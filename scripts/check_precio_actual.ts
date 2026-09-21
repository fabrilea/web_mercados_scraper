// Verifica que la caché PrecioActual coincida con el histórico Precio.
//
// PrecioActual tiene que ser exactamente "la fila más reciente de Precio por cada par
// (producto, supermercado)". Si no coincide es que una corrida del scraper quedó a medias o que
// el upsert incremental de scripts/save_adapter_results.ts falló en algún lote — se arregla
// corriendo `npm run db:rebuild-actuales`.
//
// No escribe nada: es sólo lectura.
//
// Uso: npm run db:check-actuales

require('dotenv').config({ override: true })

// eslint-disable-next-line @typescript-eslint/no-var-requires
const prismaMod = require('../src/lib/prisma')
const prisma = prismaMod.default || prismaMod

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Falta DATABASE_URL — ver DEPLOY.md')
    process.exit(1)
  }

  const resumen: any[] = await prisma.$queryRawUnsafe(`
    SELECT s."nombre",
           count(*)::int AS filas,
           max(pa."fechaRelevado") AS ultima
    FROM "PrecioActual" pa
    JOIN "Supermercado" s ON s.id = pa."supermercadoId"
    GROUP BY s."nombre"
    ORDER BY filas DESC
  `)

  console.log('')
  console.log('  PrecioActual por supermercado:')
  for (const f of resumen) {
    const dias = Math.floor((Date.now() - new Date(f.ultima).getTime()) / 86400000)
    const aviso = dias >= 3 ? `  <-- sin relevar hace ${dias} días` : ''
    console.log(`    ${String(f.nombre).padEnd(22)} ${String(f.filas).padStart(6)} precios   última: ${new Date(f.ultima).toISOString().slice(0, 16)}${aviso}`)
  }

  const discrepancias: any[] = await prisma.$queryRawUnsafe(`
    WITH ult AS (
      SELECT DISTINCT ON ("productoCanonicoId", "supermercadoId")
             "productoCanonicoId" AS pid, "supermercadoId" AS sid, precio, "fechaRelevado" AS f
      FROM "Precio"
      WHERE precio > 0
      ORDER BY "productoCanonicoId", "supermercadoId", "fechaRelevado" DESC
    )
    SELECT
      count(*) FILTER (WHERE pa.id IS NULL)::int          AS faltan_en_cache,
      count(*) FILTER (WHERE ult.pid IS NULL)::int        AS sobran_en_cache,
      count(*) FILTER (WHERE pa.id IS NOT NULL AND ult.pid IS NOT NULL
                         AND (pa.precio <> ult.precio OR pa."fechaRelevado" <> ult.f))::int AS desactualizadas
    FROM ult
    FULL JOIN "PrecioActual" pa
      ON pa."productoCanonicoId" = ult.pid AND pa."supermercadoId" = ult.sid
  `)

  const d = discrepancias[0]
  const total = d.faltan_en_cache + d.sobran_en_cache + d.desactualizadas

  console.log('')
  if (total === 0) {
    console.log('  OK — PrecioActual coincide exactamente con el histórico.')
  } else {
    console.log('  DESINCRONIZADA:')
    console.log(`    ${d.faltan_en_cache} pares (producto, super) están en Precio pero no en la caché`)
    console.log(`    ${d.sobran_en_cache} están en la caché pero no en Precio`)
    console.log(`    ${d.desactualizadas} tienen distinto precio o fecha`)
    console.log('')
    console.log('    Se arregla con: npm run db:rebuild-actuales')
  }
  console.log('')

  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  try {
    await prisma.$disconnect()
  } catch {}
  process.exit(1)
})
