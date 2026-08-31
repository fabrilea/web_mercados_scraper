// Script: ejecuta un adaptador de promos bancarias (adapters/promos-bancarias/*) y
// persiste el resultado en PromoBanco. A diferencia de save_adapter_results.ts (que
// siempre inserta filas nuevas en Precio para mantener histórico), acá se hace upsert por
// (supermercadoId, externalId): una promo bancaria vigente no es un dato histórico de
// precio, es "lo que está vigente ahora" — sin upsert, cada corrida diaria duplicaría la
// misma promo activa una y otra vez.
// Uso: npx ts-node scripts/save_promos_bancarias.ts adapters/promos-bancarias/carrefour.ts

// require en vez de import: ver la nota equivalente en save_adapter_results.ts.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const prisma = require('../src/lib/prisma').default

const adapterArg = process.argv[2]
if (!adapterArg) {
  console.error('Uso: npx ts-node scripts/save_promos_bancarias.ts adapters/promos-bancarias/<archivo>.ts')
  process.exit(1)
}

function log(...args: any[]) {
  console.log(new Date().toISOString(), ...args)
}

async function ensureSupermercado(nombre: string) {
  let s = await prisma.supermercado.findFirst({ where: { nombre } })
  if (!s) s = await prisma.supermercado.create({ data: { nombre } })
  return s
}

async function main() {
  const mod = require('../' + adapterArg.replace(/^\.?\//, '').replace(/\.ts$/, ''))
  const adapter = mod.default || mod

  log('Ejecutando adaptador de promos bancarias:', adapter.nombre)
  const promos = await adapter.obtenerPromos()
  log(`Adaptador devolvió ${promos.length} promos`)

  const supermercadoCache = new Map<string, any>()
  let guardadas = 0

  for (const p of promos) {
    if (!supermercadoCache.has(p.supermercadoId)) {
      supermercadoCache.set(p.supermercadoId, await ensureSupermercado(p.supermercadoId))
    }
    const supermercado = supermercadoCache.get(p.supermercadoId)

    const data = {
      supermercadoId: supermercado.id,
      externalId: p.externalId,
      titulo: p.titulo,
      descripcion: p.descripcion,
      descuentoPorcentaje: p.descuentoPorcentaje,
      dias: p.dias?.join(',') || undefined,
      imageUrl: p.imageUrl,
      aplicaOnline: p.aplicaOnline,
      validoDesde: p.validoDesde,
      validoHasta: p.validoHasta,
      fechaRelevado: p.fechaRelevado,
      fuente: p.fuente
    }

    if (p.externalId) {
      await prisma.promoBanco.upsert({
        where: { supermercadoId_externalId: { supermercadoId: supermercado.id, externalId: p.externalId } },
        create: data,
        update: data
      })
    } else {
      await prisma.promoBanco.create({ data })
    }
    guardadas++
  }

  log(`Guardadas/actualizadas ${guardadas} promos bancarias`)
  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
