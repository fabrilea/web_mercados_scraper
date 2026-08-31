import prisma from './prisma.ts'

const STOPWORDS = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'en', 'con', 'sin', 'x', 'pack', 'paquete', 'un', 'una', 'y', 'a', 'por'
])

// Alias de unidades para comparar cantidades equivalentes escritas distinto (1lts vs 1l)
const UNIT_ALIASES: Record<string, string> = {
  lts: 'l', lt: 'l', litro: 'l', litros: 'l', l: 'l',
  kg: 'kg', kgs: 'kg',
  grs: 'g', gr: 'g', g: 'g',
  ml: 'ml', cc: 'ml', cm3: 'ml',
  unidad: 'un', uds: 'un', un: 'un'
}

export function normalizeText(s: string) {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Descuentos/etiquetas promocionales al inicio del nombre ("25% ...", "2x1 ...",
// "HOY ...", "EN LA 2DA UNIDAD ...") no forman parte del producto en sí. Se aplican
// en loop porque suelen combinarse (ej. "70% EN LA 2DA UNIDAD ALIMENTO...").
const PROMO_PREFIXES = [
  /^\s*\d{1,3}%\s*/,
  /^\s*\d+x\d+\s*/i,
  /^\s*hoy\s+/i,
  /^\s*en la \d+\w*\s+unidad\s*/i
]

export function stripDiscountPrefix(s: string) {
  let out = s
  let changed = true
  while (changed) {
    changed = false
    for (const re of PROMO_PREFIXES) {
      const next = out.replace(re, '')
      if (next !== out) {
        out = next
        changed = true
      }
    }
  }
  return out
}

// Palabras que distinguen variantes de un mismo producto (contenido graso, sabor, etc.)
// Si dos nombres tienen conjuntos distintos de estas palabras, son productos distintos
// aunque el resto del texto se parezca mucho (ej. "descremada" vs "entera").
const VARIANT_WORDS = new Set([
  'descremada', 'entera', 'deslactosada', 'light', 'diet', 'fortificada', 'liviana', 'azucar',
  'vainilla', 'chocolate', 'chocolatada', 'mocha', 'coco', 'cafe', 'frutilla', 'durazno', 'natural',
  'integral', 'blanco', 'negro'
])

export function hasVariantConflict(a: Set<string>, b: Set<string>): boolean {
  const va = [...a].filter((t) => VARIANT_WORDS.has(t))
  const vb = [...b].filter((t) => VARIANT_WORDS.has(t))
  if (!va.length && !vb.length) return false
  if (va.length !== vb.length) return true
  return va.some((v) => !vb.includes(v))
}

// Extrae una firma de cantidad normalizada (ej "1kg", "500g", "1.5l") o null si no encuentra
export function extractQuantitySignature(normalized: string): string | null {
  const m = normalized.match(/(\d+[.,]?\d*)\s*(kg|kgs|g|gr|grs|l|lt|lts|litro|litros|ml|cc|cm3|un|unidad|uds)\b/)
  if (!m) return null
  const num = parseFloat(m[1].replace(',', '.'))
  const unit = UNIT_ALIASES[m[2]] || m[2]
  return `${num}${unit}`
}

export function significantTokens(normalized: string): Set<string> {
  return new Set(
    normalized
      .split(' ')
      .filter((t) => t && !STOPWORDS.has(t) && !/^\d+$/.test(t))
  )
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

// Frecuencia de cada palabra dentro de un catálogo de productos (document frequency).
// Palabras muy frecuentes ("papel", "detergente", "gaseosa") son genéricas — describen el
// tipo de producto. Palabras poco frecuentes suelen ser la marca o línea específica
// ("higienol", "colgate", "cif") — son las que realmente identifican que dos nombres
// distintos hablan del mismo producto.
export function buildDocFrequency(tokenSets: Set<string>[]): Map<string, number> {
  const freq = new Map<string, number>()
  for (const ts of tokenSets) {
    for (const t of ts) freq.set(t, (freq.get(t) || 0) + 1)
  }
  return freq
}

const RATIO_PALABRA_ESPECIFICA = 0.05

export function esPalabraEspecifica(t: string, freq: Map<string, number>, total: number): boolean {
  if (!total) return false
  return (freq.get(t) || 0) / total <= RATIO_PALABRA_ESPECIFICA
}

export function compartenPalabraEspecifica(a: Set<string>, b: Set<string>, freq: Map<string, number>, total: number): boolean {
  for (const t of a) {
    if (b.has(t) && esPalabraEspecifica(t, freq, total)) return true
  }
  return false
}

// Cache en memoria del proceso: antes se volvía a pedir hasta 2000 candidatos a la DB y se
// retokenizaban todos desde cero en JS en CADA llamada (una por producto scrapeado). Con
// SQLite local eso no se notaba (sin latencia de red), pero contra Postgres externo cada
// corrida de scraping tardaba casi 1 segundo por producto — un adaptador de ~19.000 productos
// (Carrefour) tardaba casi 5 horas y hacía que el workflow de GitHub Actions superara el
// límite de 6hs sin terminar. Cada adaptador corre en su propio proceso hijo (ver
// save_adapter_results.ts), así que este cache vive y se descarta con ese proceso: se arma
// una sola vez por corrida, no una vez por producto.
interface CandidatoCache {
  id: number
  norm: string
  tokens: Set<string>
}

let cacheCandidatos: CandidatoCache[] | null = null
let cacheFreq: Map<string, number> | null = null

async function obtenerCandidatos(): Promise<{ candidatos: CandidatoCache[]; freq: Map<string, number> }> {
  if (!cacheCandidatos || !cacheFreq) {
    const rows = await prisma.productoCanonico.findMany({ select: { id: true, nombre: true } })
    cacheCandidatos = rows.map((r) => {
      const norm = normalizeText(stripDiscountPrefix(r.nombre))
      return { id: r.id, norm, tokens: significantTokens(norm) }
    })
    // La frecuencia de palabras se calcula una sola vez con el catálogo tal cual estaba al
    // arrancar la corrida — productos creados durante la misma corrida no la actualizan. Es
    // una aproximación aceptable (es sólo un peso heurístico) a cambio de no recalcularla
    // sobre miles de productos en cada creación.
    cacheFreq = buildDocFrequency(cacheCandidatos.map((c) => c.tokens))
  }
  return { candidatos: cacheCandidatos, freq: cacheFreq }
}

function agregarACache(id: number, nombre: string) {
  if (!cacheCandidatos) return
  const norm = normalizeText(stripDiscountPrefix(nombre))
  cacheCandidatos.push({ id, norm, tokens: significantTokens(norm) })
}

/**
 * Busca (o crea) el ProductoCanonico correspondiente a un nombre de producto.
 *
 * Estrategia en dos niveles:
 * 1. Match exacto por texto normalizado (sin descuentos/mayúsculas/acentos): garantiza que
 *    el mismo producto scrapeado en corridas distintas del mismo adaptador siempre re-matchee
 *    al mismo canónico, para no fragmentar el histórico de precios.
 * 2. Si no hay match exacto, fuzzy-match por overlap de palabras significativas (Jaccard),
 *    exigiendo que la cantidad (kg/l/g/etc.) sea compatible cuando ambos productos la tienen,
 *    para no mezclar variantes distintas (ej. "descremada" vs "entera").
 */
export async function findOrCreateProductoCanonicoByName(
  nombreOriginal: string,
  unidad?: string,
  threshold = 0.6,
  codigoBarras?: string,
  categoria?: string,
  marca?: string,
  imagenUrl?: string
) {
  if (codigoBarras) {
    const found = await prisma.productoCanonico.findUnique({ where: { codigoBarras } })
    if (found) {
      const faltantes: Record<string, string> = {}
      if (categoria && !found.categoria) faltantes.categoria = categoria
      if (marca && !found.marca) faltantes.marca = marca
      if (imagenUrl && !found.imagenUrl) faltantes.imagenUrl = imagenUrl
      if (Object.keys(faltantes).length) {
        return prisma.productoCanonico.update({ where: { id: found.id }, data: faltantes })
      }
      return found
    }
    // El código de barras es un identificador real y global del producto (asignado por
    // el fabricante, no por el supermercado): si no hay ningún canónico con este EAN, es
    // porque este producto puntual todavía no existe, no porque haya que buscarlo por
    // texto. Ir al fuzzy-match de todos modos es lo que fusionaba variantes distintas de
    // una misma marca (ej. arroz "parboil" vs "doble carolina" vs "largo fino", cada una
    // con su propio EAN real) en un solo canónico por compartir casi todas las palabras.
    const creado = await prisma.productoCanonico.create({
      data: {
        nombre: stripDiscountPrefix(nombreOriginal).trim(),
        unidadEstandar: unidad,
        codigoBarras,
        categoria: categoria ?? undefined,
        marca: marca ?? undefined,
        imagenUrl: imagenUrl ?? undefined
      }
    })
    agregarACache(creado.id, creado.nombre)
    return creado
  }

  const cleaned = stripDiscountPrefix(nombreOriginal).trim()
  const norm = normalizeText(cleaned)
  const qty = extractQuantitySignature(norm)
  const tokens = significantTokens(norm)

  const { candidatos, freq } = await obtenerCandidatos()
  const totalCandidatos = candidatos.length

  let bestId: number | null = null
  let bestScore = 0

  for (const c of candidatos) {
    if (c.norm === norm) {
      bestId = c.id
      bestScore = 1
      break
    }
    const cQty = extractQuantitySignature(c.norm)
    if (qty && cQty && qty !== cQty) continue

    if (hasVariantConflict(tokens, c.tokens)) continue

    const score = jaccardSimilarity(tokens, c.tokens)
    const compartenMarca = compartenPalabraEspecifica(tokens, c.tokens, freq, totalCandidatos)
    // El umbral reducido por "palabra de marca compartida" solo es seguro cuando ambos
    // nombres tienen una cantidad detectada y coincide (ya filtrado arriba): si a alguno
    // de los dos no se le pudo extraer la cantidad, no hay garantía de que sean el mismo
    // tamaño de producto, así que se exige el umbral completo.
    const cantidadConfirmada = qty !== null && cQty !== null
    const aceptable = score >= threshold || (compartenMarca && cantidadConfirmada && score >= threshold * 0.7)
    if (aceptable && score > bestScore) {
      bestScore = score
      bestId = c.id
    }
  }

  if (bestId !== null) {
    const found = await prisma.productoCanonico.findUnique({ where: { id: bestId } })
    if (found) {
      const faltantes: Record<string, string> = {}
      if (categoria && !found.categoria) faltantes.categoria = categoria
      if (marca && !found.marca) faltantes.marca = marca
      if (imagenUrl && !found.imagenUrl) faltantes.imagenUrl = imagenUrl
      if (Object.keys(faltantes).length) {
        return prisma.productoCanonico.update({ where: { id: found.id }, data: faltantes })
      }
    }
    return found
  }

  const creado = await prisma.productoCanonico.create({
    data: {
      nombre: cleaned,
      unidadEstandar: unidad,
      codigoBarras: codigoBarras ?? undefined,
      categoria: categoria ?? undefined,
      marca: marca ?? undefined,
      imagenUrl: imagenUrl ?? undefined
    }
  })
  agregarACache(creado.id, creado.nombre)
  return creado
}

export default {
  normalizeText,
  stripDiscountPrefix,
  extractQuantitySignature,
  significantTokens,
  jaccardSimilarity,
  hasVariantConflict,
  buildDocFrequency,
  esPalabraEspecifica,
  compartenPalabraEspecifica,
  findOrCreateProductoCanonicoByName
}
