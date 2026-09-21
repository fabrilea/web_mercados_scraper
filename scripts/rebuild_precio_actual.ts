// Reconstruye PrecioActual entera desde el histórico de Precio.
//
// PrecioActual es una caché derivada: se puede borrar y regenerar sin perder nada, porque la
// fuente de verdad sigue siendo Precio (append-only). Este script sirve para dos cosas:
//   - el backfill inicial, la primera vez que se crea la tabla;
//   - reparar la caché si una corrida del scraper quedó a medias y la dejó desincronizada.
//
// Uso: npm run db:rebuild-actuales
//
// Trabaja en una sola sentencia SQL (DISTINCT ON + INSERT ... ON CONFLICT) en vez de traer las
// filas a Node: son ~1M de filas de histórico y moverlas por la red no tiene ningún sentido
// cuando Postgres puede resolverlo entero del lado del servidor.

require('dotenv').config({ override: true })

// eslint-disable-next-line @typescript-eslint/no-var-requires
const prismaMod = require('../src/lib/prisma')
const prisma = prismaMod.default || prismaMod

function log(...args: any[]) {
  console.log(new Date().toISOString(), ...args)
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Falta DATABASE_URL — ver DEPLOY.md')
    process.exit(1)
  }

  const antes: any[] = await prisma.$queryRawUnsafe('SELECT count(*)::int AS c FROM "PrecioActual"')
  log(`PrecioActual tenía ${antes[0].c} filas`)

  log('Reconstruyendo desde Precio...')
  // DISTINCT ON (productoCanonicoId, supermercadoId) ORDER BY fechaRelevado DESC = "la fila más
  // reciente de cada par producto/supermercado". Se filtran los precios no positivos: eran datos
  // basura de corridas viejas (antes de la guarda en save_adapter_results.ts) y un $0 gana
  // cualquier comparación de "más barato".
  const afectadas = await prisma.$executeRawUnsafe(`
    INSERT INTO "PrecioActual" (
      "productoCanonicoId", "supermercadoId", "precio", "precioPromo", "precioFinal",
      "promoDescripcion", "promoDesde", "promoHasta", "fechaRelevado", "fuente"
    )
    SELECT DISTINCT ON (p."productoCanonicoId", p."supermercadoId")
      p."productoCanonicoId",
      p."supermercadoId",
      p."precio",
      p."precioPromo",
      -- Un precioPromo sólo cuenta como precio final si es realmente menor que el de lista:
      -- algunos adaptadores lo completan con el mismo valor que precio.
      CASE WHEN p."precioPromo" IS NOT NULL AND p."precioPromo" > 0 AND p."precioPromo" < p."precio"
           THEN p."precioPromo" ELSE p."precio" END,
      p."promoDescripcion",
      p."promoDesde",
      p."promoHasta",
      p."fechaRelevado",
      p."fuente"
    FROM "Precio" p
    WHERE p."precio" > 0
    ORDER BY p."productoCanonicoId", p."supermercadoId", p."fechaRelevado" DESC
    ON CONFLICT ("productoCanonicoId", "supermercadoId") DO UPDATE SET
      "precio"           = EXCLUDED."precio",
      "precioPromo"      = EXCLUDED."precioPromo",
      "precioFinal"      = EXCLUDED."precioFinal",
      "promoDescripcion" = EXCLUDED."promoDescripcion",
      "promoDesde"       = EXCLUDED."promoDesde",
      "promoHasta"       = EXCLUDED."promoHasta",
      "fechaRelevado"    = EXCLUDED."fechaRelevado",
      "fuente"           = EXCLUDED."fuente"
  `)

  const despues: any[] = await prisma.$queryRawUnsafe('SELECT count(*)::int AS c FROM "PrecioActual"')
  log(`Listo: ${afectadas} filas escritas, PrecioActual quedó con ${despues[0].c}`)

  const porSuper: any[] = await prisma.$queryRawUnsafe(`
    SELECT s."nombre", count(*)::int AS filas, max(pa."fechaRelevado") AS ultima
    FROM "PrecioActual" pa JOIN "Supermercado" s ON s.id = pa."supermercadoId"
    GROUP BY s."nombre" ORDER BY filas DESC
  `)
  for (const f of porSuper) {
    log(`  ${f.nombre}: ${f.filas} precios, última corrida ${new Date(f.ultima).toISOString()}`)
  }

  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  try {
    await prisma.$disconnect()
  } catch {}
  process.exit(1)
})
