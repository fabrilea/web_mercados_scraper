// Script: Ejecuta el adaptador Monarca y persiste resultados en la DB (Prisma)
// Uso: npx ts-node scripts/save_adapter_results.ts

// eslint-disable-next-line @typescript-eslint/no-var-requires
require('dotenv').config({ override: true })

const adapterArg = process.argv[2]
const adapterPath = adapterArg || '../adapters/monarca'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs')
const path = require('path')
// eslint-disable-next-line @typescript-eslint/no-var-requires
let mod
try {
  mod = require(adapterPath)
} catch (e) {
  // try relative to script
  mod = require(path.join(__dirname, '..', 'adapters', path.basename(adapterPath).replace(/\.ts$/, '')))
}
let MonarcaAdapter = mod.default || mod

function log(...args: any[]) {
  console.log(new Date().toISOString(), ...args)
}

async function retryAsync<T>(fn: () => Promise<T>, attempts = 3, delayMs = 1000): Promise<T> {
  let lastErr: any
  for (let i = 0; i < attempts; i++) {
    try {
      if (i > 0) log(`Retry attempt ${i + 1}/${attempts}...`)
      return await fn()
    } catch (e) {
      lastErr = e
      const wait = delayMs * Math.pow(2, i)
      const emsg = (e && (e as any).message) ? (e as any).message : String(e)
      log(`Attempt ${i + 1} failed:`, emsg, `— waiting ${wait}ms`)
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, wait))
    }
  }
  throw lastErr
}
// Try loading Prisma; if unavailable, fallback to JSON file storage
let prisma: any = null
// Usar Prisma en cuanto haya alguna DATABASE_URL configurada (antes sólo se activaba para
// rutas file:/dev_new.db de la vieja DB SQLite local — con Postgres externo esa condición
// nunca daba true, así que esto quedaba escribiendo silenciosamente en data/prices.json en
// vez de persistir en la DB real).
const dbUrl = process.env.DATABASE_URL || ''
if (dbUrl) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const prismaMod = require('../src/lib/prisma')
    prisma = prismaMod.default || prismaMod
    // connect eagerly
    if (prisma && typeof prisma.$connect === 'function') {
      // it's safe to call connect; ignore promise for scripts that exit quickly
      prisma.$connect().catch(() => {})
    }
  } catch (e) {
    prisma = null
  }
}
console.log('Prisma available:', !!prisma)


async function ensureSupermercado(nombre: string) {
  if (!prisma) {
    // file-based stub: return an object with id 1
    return { id: 1, nombre }
  }
  let s = await prisma.supermercado.findFirst({ where: { nombre } })
  if (!s) {
    s = await prisma.supermercado.create({ data: { nombre } })
  }
  return s
}

// Cachea por nombre dentro de la corrida para no repetir consultas: un adaptador puede
// traer items de varias sucursales/supermercados distintos (ver ProductoPrecio.supermercadoId).
const supermercadoCache = new Map<string, any>()
async function ensureSupermercadoCached(nombre: string) {
  if (supermercadoCache.has(nombre)) return supermercadoCache.get(nombre)
  const s = await ensureSupermercado(nombre)
  supermercadoCache.set(nombre, s)
  return s
}

// Delegate fuzzy matching/creation to shared normalizer
let normalizer: any = null
try {
  normalizer = require('../src/lib/normalize')
} catch (e) {
  normalizer = null
}

async function findOrCreateProductoCanonico(p: any) {
  if (!prisma) return { id: p.nombreNormalizado, nombre: p.nombreOriginal }
  if (normalizer && typeof normalizer.findOrCreateProductoCanonicoByName === 'function') {
    return await normalizer.findOrCreateProductoCanonicoByName(p.nombreOriginal, p.unidad, 0.6, p.codigoBarras, p.categoria, p.marca, p.imagenUrl)
  }
  // fallback simple
  const nombre = p.nombreOriginal
  if (p.codigoBarras) {
    const byCode = await prisma.productoCanonico.findUnique({ where: { codigoBarras: p.codigoBarras } }).catch(() => null)
    if (byCode) return byCode
  }
  let prod = await prisma.productoCanonico.findFirst({ where: { nombre } })
  if (prod) return prod
  prod = await prisma.productoCanonico.create({ data: { nombre, unidadEstandar: p.unidad || 'unidad', codigoBarras: p.codigoBarras ?? undefined, categoria: p.categoria ?? undefined, marca: p.marca ?? undefined, imagenUrl: p.imagenUrl ?? undefined } })
  return prod
}

async function main() {
  log('Run adapter and save results — Adapter:', MonarcaAdapter.nombre || adapterPath)
  const supermercadoDefault = MonarcaAdapter.nombre || 'Adapter'

  // Ejecutar adaptador con retries y logging
  const items = await retryAsync(async () => {
    log('Calling adapter.obtenerProductos()')
    const res = await MonarcaAdapter.obtenerProductos()
    return res
  }, 3, 1500)
  log(`Adapter returned ${Array.isArray(items) ? items.length : 'N/A'} items`)

  let inserted = 0
  const outDir = path.join(__dirname, '..', 'data')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, 'prices.json')

  let fileData: any[] = []
  if (fs.existsSync(outFile)) {
    try {
      fileData = JSON.parse(fs.readFileSync(outFile, 'utf8'))
    } catch (e) {
      fileData = []
    }
  }

  // El create de Precio se agrupa en lotes (createMany) en vez de un insert por producto: con
  // la DB externa (Postgres/Neon) cada viaje de ida y vuelta a la red cuesta bastante más que
  // con la SQLite local de antes, y hacer uno por producto es lo que hacía que scrapear el
  // catálogo completo (~19.000 productos en Carrefour) tardara varias horas y arriesgara pasar
  // el límite de 6hs de un job de GitHub Actions. La resolución de producto (fuzzy-match) sigue
  // siendo una consulta por item — no es trivial de agrupar sin arriesgar duplicados — pero el
  // insert de precio en sí, que no necesita ninguna lógica de match, sí.
  const BATCH_SIZE = 200
  let bufferPrecios: any[] = []

  async function flushBufferPrecios() {
    if (!bufferPrecios.length) return
    const lote = bufferPrecios
    bufferPrecios = []
    try {
      await retryAsync(async () => {
        await prisma.precio.createMany({ data: lote })
      }, 2, 500)
      inserted += lote.length
    } catch (e) {
      log(`Failed to persist a batch of ${lote.length} precio rows`, String(e))
    }
  }

  for (const it of items) {
    try {
      // Cada item puede pertenecer a un supermercado/sucursal distinto (ej. SEPA trae
      // varias sucursales en una sola corrida); si no especifica, se usa el del adaptador.
      const supermercadoNombre = it.supermercadoId || supermercadoDefault
      const supermercado = prisma ? await ensureSupermercadoCached(supermercadoNombre) : { id: 1, nombre: supermercadoNombre }

      if (prisma) {
        const prod = await findOrCreateProductoCanonico(it)
        bufferPrecios.push({
          productoCanonicoId: prod.id,
          supermercadoId: supermercado.id,
          precio: Number(it.precio) || 0,
          precioPromo: it.precioPromo ?? null,
          fechaRelevado: it.fechaRelevado ? new Date(it.fechaRelevado) : new Date(),
          promoDescripcion: it.promoDescripcion ?? null,
          promoDesde: it.promoValidoDesde ? new Date(it.promoValidoDesde) : null,
          promoHasta: it.promoValidoHasta ? new Date(it.promoValidoHasta) : null,
          fuente: it.fuente ?? 'scraping_web'
        })
        if (bufferPrecios.length >= BATCH_SIZE) await flushBufferPrecios()
      } else {
        const row = {
          productoCanonicoId: it.nombreNormalizado,
          supermercado: supermercado.nombre,
          precio: Number(it.precio) || 0,
          precioPromo: it.precioPromo ?? null,
          fechaRelevado: it.fechaRelevado ? new Date(it.fechaRelevado).toISOString() : new Date().toISOString(),
          promoDescripcion: it.promoDescripcion ?? null,
          promoDesde: it.promoValidoDesde ?? null,
          promoHasta: it.promoValidoHasta ?? null,
          fuente: it.fuente ?? 'scraping_web',
          nombreOriginal: it.nombreOriginal,
          nombreNormalizado: it.nombreNormalizado
        }
        fileData.push(row)
        inserted++
      }
    } catch (e) {
      log('Failed to persist item', it.nombreOriginal, String(e))
    }
  }

  if (prisma) await flushBufferPrecios()

  if (!prisma) {
    fs.writeFileSync(outFile, JSON.stringify(fileData, null, 2), 'utf8')
    console.log(`Inserted ${inserted} precio rows (file: ${outFile})`)
  } else {
    console.log(`Inserted ${inserted} precio rows into Prisma DB (${dbUrl})`)
  }
  if (prisma) await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
