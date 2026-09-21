import { ProductoPrecio, SupermercadoAdapter } from './types'
import { categoriaDesdeSegmentos } from '../src/lib/categoriaHeuristica.ts'

// Golopolis (Tandil) — "Golopolis Supermarket", plataforma GoalEyes/Daedaz. A diferencia de
// los sitios VTEX (Carrefour/DIA/Vea), acá cada página de subcategoría es HTML
// server-rendered clásico, pero incluye los datos de producto ya estructurados como JSON en
// una variable JS embebida (`var aProducts = [...]`) — no hace falta parsear el DOM ni
// Playwright, alcanza con extraer y parsear ese array de cada respuesta. Sin robots.txt en el
// sitio (404), sin rutas explícitas bloqueadas.
//
// El menú (`superItemId`/`itemId` por subcategoría) se descubre en cada corrida parseando el
// nav de la home en vez de hardcodear los ids numéricos: son ids internos de la plataforma,
// no slugs estables, así que hardcodearlos se rompería silenciosamente si la tienda reordena
// categorías. Cada subcategoría devuelve su catálogo completo en una sola respuesta (sin
// paginación del lado del sitio — verificado con una subcategoría de 367 productos), así que
// no hace falta un loop de paginación como en los adaptadores VTEX.

const BASE = 'https://golopolis.com.ar/app/'
const HEADERS = {
  'Accept': 'text/html',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
}

// Nombre canónico por "super" (categoría de nivel superior del sitio) — mismo vocabulario que
// el resto de los adaptadores. GALLETITAS se mapea a "Desayuno" siguiendo la misma
// convención que Carrefour/DIA (su bucket "Desayuno" agrupa justamente galletitas/meriendas).
// VARIOS y FIESTA son un catch-all real del sitio (ferretería, pilas, cotillón, etc.) sin
// equivalente en el resto del catálogo — forzarlos dentro de Almacén/Limpieza inventaría una
// categoría que no es, así que quedan en su propio bucket "Varios".
const CATEGORIA_CANONICA_POR_SUPER: Record<string, string> = {
  ALMACEN: 'Almacén',
  BEBIDAS: 'Bebidas sin Alcohol',
  GALLETITAS: 'Desayuno',
  GOLOSINAS: 'Kiosco',
  LIMPIEZA: 'Limpieza',
  PERFUMERIA: 'Perfumería',
  VARIOS: 'Varios',
  FIESTA: 'Varios'
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function normalizeName(s: string) {
  return s
    .normalize('NFKD')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function esEanValido(ean: string | null | undefined): boolean {
  return !!ean && /^\d{8,14}$/.test(ean)
}

interface Subcategoria {
  super: string
  superItemId: string
  itemId: string
  nombre: string
}

async function descubrirSubcategorias(): Promise<Subcategoria[]> {
  const res = await fetch(BASE, { headers: HEADERS })
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${BASE}`)
  const html = await res.text()

  const navStart = html.indexOf('<nav class="panel-menu">')
  const navEnd = html.indexOf('</nav>', navStart)
  if (navStart === -1 || navEnd === -1) throw new Error('No se encontró el menú de categorías en la home')
  const nav = html.slice(navStart, navEnd)

  const out: Subcategoria[] = []
  const supers = nav.matchAll(/<a href="javascript:;">([^<]+)<\/a>\s*<ul>([\s\S]*?)<\/ul>/g)
  for (const s of supers) {
    const superNombre = s[1].trim().toUpperCase()
    const items = s[2].matchAll(/superItemId=(\d+)&itemId=(\d+)">([^<]+)</g)
    for (const it of items) {
      out.push({ super: superNombre, superItemId: it[1], itemId: it[2], nombre: it[3].trim() })
    }
  }
  return out
}

async function fetchSubcategoria(superItemId: string, itemId: string): Promise<any[]> {
  const url = `${BASE}?action=products&superItemId=${superItemId}&itemId=${itemId}`
  const res = await fetch(url, { headers: HEADERS })
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`)
  const html = await res.text()
  const m = html.match(/var\s+aProducts\s*=\s*(\[.*?\]);/s)
  if (!m) return []
  return JSON.parse(m[1])
}

function toFecha(fechaStr: string | null | undefined): Date | undefined {
  if (!fechaStr) return undefined
  const d = new Date(`${fechaStr}T00:00:00`)
  return Number.isNaN(d.getTime()) ? undefined : d
}

function categoriaProducto(sub: Subcategoria): string {
  // ALIMENTOS MASCOTAS vive dentro del catch-all "VARIOS" del sitio, pero es un rubro real y
  // ya existente en el resto del catálogo (Mascotas) — vale la pena el caso puntual en vez de
  // perderlo dentro de "Varios".
  if (sub.nombre.toUpperCase() === 'ALIMENTOS MASCOTAS') return 'Mascotas'
  const fallback = CATEGORIA_CANONICA_POR_SUPER[sub.super] || 'Varios'
  return categoriaDesdeSegmentos([sub.super, sub.nombre], fallback)
}

const GolopolisAdapter: SupermercadoAdapter = {
  nombre: 'Golopolis',
  fuente: 'scraping_web',
  async obtenerProductos(): Promise<ProductoPrecio[]> {
    const subcategorias = await descubrirSubcategorias()

    const out: ProductoPrecio[] = []
    const vistos = new Set<string>()

    for (const sub of subcategorias) {
      try {
        const productos = await fetchSubcategoria(sub.superItemId, sub.itemId)

        for (const p of productos) {
          const id = String(p.id || p.foreign_id)
          if (!id || vistos.has(id)) continue
          vistos.add(id)

          const nombreOriginal: string = p.name
          if (!nombreOriginal) continue

          const ean = esEanValido(p.ean) ? p.ean : undefined
          const precioActual = Number(p.price)
          if (!precioActual) continue
          const precioLista = Number(p.originalPrice) || precioActual
          const precio = precioLista
          const precioPromo = precioActual < precioLista ? precioActual : undefined
          const imagenUrl = p.image ? `${BASE}files/company_${p.company_id}/products/${p.image}` : undefined

          out.push({
            supermercadoId: 'Golopolis',
            nombreOriginal,
            nombreNormalizado: normalizeName(nombreOriginal),
            marca: p.brand || undefined,
            codigoBarras: ean,
            imagenUrl,
            categoria: categoriaProducto(sub),
            precio,
            precioPromo,
            unidad: 'unidad',
            fechaRelevado: new Date(),
            promoDescripcion: precioPromo ? (p.promotion || undefined) : undefined,
            promoValidoHasta: precioPromo ? toFecha(p.until) : undefined,
            fuente: 'scraping_web'
          })
        }

        await sleep(150)
      } catch (e) {
        console.warn('Golopolis: error en subcategoría', sub.super, sub.nombre, e)
      }
    }

    return out
  }
}

export default GolopolisAdapter
