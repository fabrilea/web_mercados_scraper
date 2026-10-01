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
// `Prisma.sql`/`Prisma.join` para armar el upsert masivo de PrecioActual con parámetros, sin
// concatenar strings. Se carga aparte del cliente porque el modo sin DB (archivo JSON) no lo usa.
let Prisma: any = null
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
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    Prisma = require('@prisma/client').Prisma
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
  let descartadosSinPrecio = 0
  let cacheDesincronizada = false

  // Precio vigente por (producto, supermercado), cargado de una sola vez al empezar.
  //
  // Es lo que permite insertar en Precio SÓLO cuando el valor cambió. Antes cada corrida
  // insertaba una fila por producto aunque el precio fuera idéntico al de la corrida anterior:
  // ~45.000 filas por corrida de las cuales la enorme mayoría no aportaban información, y es lo
  // que llevó la tabla al millón de filas y agotó el cupo de la DB. Un producto que no cambió de
  // precio ahora sólo actualiza `vistoEn` en PrecioActual, que es un UPDATE de una columna sobre
  // una fila que ya existe en vez de un INSERT nuevo.
  const clavePar = (productoId: number, supermercadoId: number) => `${productoId}:${supermercadoId}`
  const cachePrecioActual = new Map<string, any>()

  if (prisma) {
    const filas = await prisma.precioActual.findMany({
      select: {
        id: true,
        productoCanonicoId: true,
        supermercadoId: true,
        precio: true,
        precioPromo: true,
        promoDescripcion: true,
        promoDesde: true,
        promoHasta: true
      }
    })
    for (const f of filas) cachePrecioActual.set(clavePar(f.productoCanonicoId, f.supermercadoId), f)
    log(`PrecioActual en memoria: ${filas.length} filas`)
  }

  const mismaFecha = (a: Date | null | undefined, b: Date | null | undefined) => {
    if (!a && !b) return true
    if (!a || !b) return false
    return new Date(a).getTime() === new Date(b).getTime()
  }

  // Qué cuenta como "el mismo precio": todo lo que se guardaría en la fila de Precio. Si algo de
  // esto cambió —incluida la descripción o la vigencia de una promo— es un dato nuevo y merece su
  // propia fila en el histórico.
  function mismoPrecio(anterior: any, nuevo: any): boolean {
    if (!anterior) return false
    return (
      anterior.precio === nuevo.precio &&
      (anterior.precioPromo ?? null) === (nuevo.precioPromo ?? null) &&
      (anterior.promoDescripcion ?? null) === (nuevo.promoDescripcion ?? null) &&
      mismaFecha(anterior.promoDesde, nuevo.promoDesde) &&
      mismaFecha(anterior.promoHasta, nuevo.promoHasta)
    )
  }

  // Los que no cambiaron: sólo hay que marcarlos como vistos. Se juntan en lotes más grandes que
  // los inserts porque es un UPDATE de una columna sobre filas que ya existen, mucho más barato.
  const BATCH_VISTOS = 2000
  let bufferVistos: number[] = []
  let sinCambio = 0

  async function flushBufferVistos(cuando: Date) {
    if (!bufferVistos.length) return
    const ids = bufferVistos
    bufferVistos = []
    try {
      await retryAsync(
        () =>
          prisma.precioActual.updateMany({
            where: { id: { in: ids } },
            data: { vistoEn: cuando }
          }),
        2,
        500
      )
    } catch (e) {
      log(`Failed to mark ${ids.length} rows as seen`, String(e))
      cacheDesincronizada = true
    }
  }

  // Además del insert en el histórico, se actualiza la caché PrecioActual (una fila por
  // producto+supermercado con el último precio conocido). Prisma no tiene upsert masivo, así que
  // va como un solo INSERT ... ON CONFLICT por lote en vez de 200 idas y vueltas.
  //
  // El DO UPDATE está condicionado a que la fila guardada NO sea más nueva que la que entra: si
  // dos corridas se pisan, o si se reprocesa un adaptador viejo, no queremos que un precio
  // anterior sobreescriba a uno posterior.
  async function upsertPreciosActuales(lote: any[]) {
    // Dentro de un mismo lote puede haber dos items que caen en el MISMO producto canónico: el
    // fuzzy-match de src/lib/normalize.ts fusiona a propósito SKUs distintos de un mismo super
    // (mismo producto con y sin texto promocional en el nombre, presentaciones que matchean,
    // etc.). Postgres rechaza un INSERT ... ON CONFLICT que intente tocar la misma fila dos
    // veces en la misma sentencia ("ON CONFLICT DO UPDATE command cannot affect row a second
    // time") y se pierde el lote ENTERO — no la fila duplicada, el lote. Sin este dedup la
    // caché se quedaba con los precios viejos mientras el histórico sí se actualizaba, que es
    // exactamente el síntoma de "los precios basura siguen apareciendo en la web".
    const porPar = new Map<string, any>()
    for (const r of lote) {
      const clave = `${r.productoCanonicoId}:${r.supermercadoId}`
      const previo = porPar.get(clave)
      if (!previo || r.fechaRelevado >= previo.fechaRelevado) porPar.set(clave, r)
    }

    const valores = [...porPar.values()].map((r: any) => {
      const promoValida = r.precioPromo != null && r.precioPromo > 0 && r.precioPromo < r.precio
      return Prisma.sql`(
        ${r.productoCanonicoId}::int, ${r.supermercadoId}::int,
        ${r.precio}::double precision, ${r.precioPromo}::double precision,
        ${promoValida ? r.precioPromo : r.precio}::double precision,
        ${r.promoDescripcion}::text, ${r.promoDesde}::timestamp, ${r.promoHasta}::timestamp,
        ${r.fechaRelevado}::timestamp, ${r.fechaRelevado}::timestamp, ${r.fuente}::text
      )`
    })

    // `vistoEn` se escribe con la misma fecha que `fechaRelevado`: si el precio cambió, esta
    // corrida es a la vez el último cambio y la última vez que se vio el producto.
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "PrecioActual" (
        "productoCanonicoId", "supermercadoId", "precio", "precioPromo", "precioFinal",
        "promoDescripcion", "promoDesde", "promoHasta", "fechaRelevado", "vistoEn", "fuente"
      )
      VALUES ${Prisma.join(valores)}
      ON CONFLICT ("productoCanonicoId", "supermercadoId") DO UPDATE SET
        "precio"           = EXCLUDED."precio",
        "precioPromo"      = EXCLUDED."precioPromo",
        "precioFinal"      = EXCLUDED."precioFinal",
        "promoDescripcion" = EXCLUDED."promoDescripcion",
        "promoDesde"       = EXCLUDED."promoDesde",
        "promoHasta"       = EXCLUDED."promoHasta",
        "fechaRelevado"    = EXCLUDED."fechaRelevado",
        "vistoEn"          = EXCLUDED."vistoEn",
        "fuente"           = EXCLUDED."fuente"
      WHERE "PrecioActual"."fechaRelevado" <= EXCLUDED."fechaRelevado"
    `)
  }

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
      // Si el histórico no se pudo guardar, no se toca la caché: quedaría diciendo que hay un
      // precio que en realidad no se registró. `npm run db:rebuild-actuales` la reconstruye.
      return
    }

    // Un fallo acá no invalida la corrida: el histórico —que es la fuente de verdad— ya quedó
    // guardado, y la caché se puede reconstruir entera después.
    try {
      await retryAsync(() => upsertPreciosActuales(lote), 2, 500)
    } catch (e) {
      log(`Failed to refresh PrecioActual for a batch of ${lote.length} rows`, String(e))
      cacheDesincronizada = true
    }
  }

  for (const it of items) {
    try {
      // Un precio que no es un número positivo no es un precio: antes `Number(it.precio) || 0`
      // lo guardaba como $0, que después aparece en la web como "el más barato" de todos y le
      // gana a cualquier precio real en el optimizador del carrito. Se descarta el item entero
      // (el producto igual se sigue conociendo por sus corridas anteriores).
      const precioNumerico = Number(it.precio)
      if (!Number.isFinite(precioNumerico) || precioNumerico <= 0) {
        descartadosSinPrecio++
        continue
      }

      // Cada item puede pertenecer a un supermercado/sucursal distinto (ej. SEPA trae
      // varias sucursales en una sola corrida); si no especifica, se usa el del adaptador.
      const supermercadoNombre = it.supermercadoId || supermercadoDefault
      const supermercado = prisma ? await ensureSupermercadoCached(supermercadoNombre) : { id: 1, nombre: supermercadoNombre }

      if (prisma) {
        const prod = await findOrCreateProductoCanonico(it)
        const fila = {
          productoCanonicoId: prod.id,
          supermercadoId: supermercado.id,
          precio: precioNumerico,
          precioPromo: it.precioPromo ?? null,
          fechaRelevado: it.fechaRelevado ? new Date(it.fechaRelevado) : new Date(),
          promoDescripcion: it.promoDescripcion ?? null,
          promoDesde: it.promoValidoDesde ? new Date(it.promoValidoDesde) : null,
          promoHasta: it.promoValidoHasta ? new Date(it.promoValidoHasta) : null,
          fuente: it.fuente ?? 'scraping_web'
        }

        const clave = clavePar(prod.id, supermercado.id)
        const anterior = cachePrecioActual.get(clave)

        if (mismoPrecio(anterior, fila)) {
          // Nada nuevo que contar: el producto sigue ahí al mismo precio. Se marca como visto y
          // listo — no se escribe una fila de histórico que sería idéntica a la anterior.
          bufferVistos.push(anterior.id)
          sinCambio++
          if (bufferVistos.length >= BATCH_VISTOS) await flushBufferVistos(fila.fechaRelevado)
        } else {
          bufferPrecios.push(fila)
          // La caché se actualiza acá y no al hacer flush, porque dentro de la misma corrida
          // puede venir otro item que caiga en el mismo producto canónico (el fuzzy-match fusiona
          // SKUs distintos de un mismo super): si no, el segundo compararía contra el precio
          // viejo y escribiría una fila de más.
          cachePrecioActual.set(clave, { ...(anterior || {}), ...fila, id: anterior?.id })
          if (bufferPrecios.length >= BATCH_SIZE) await flushBufferPrecios()
        }
      } else {
        const row = {
          productoCanonicoId: it.nombreNormalizado,
          supermercado: supermercado.nombre,
          precio: precioNumerico,
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

  if (prisma) {
    await flushBufferPrecios()
    await flushBufferVistos(new Date())
  }

  if (descartadosSinPrecio) {
    log(`Descartados ${descartadosSinPrecio} items sin un precio positivo válido`)
  }
  if (prisma) {
    // El ratio entre estos dos números es la medida de cuánto sirve no insertar repeticiones:
    // si "sin cambios" es la enorme mayoría, la tabla de histórico deja de crecer en balde.
    log(`Precios nuevos o modificados: ${inserted} — sin cambios (sólo marcados como vistos): ${sinCambio}`)
  }
  if (cacheDesincronizada) {
    log('AVISO: PrecioActual quedó desincronizada en algún lote — correr `npm run db:rebuild-actuales`')
  }

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
