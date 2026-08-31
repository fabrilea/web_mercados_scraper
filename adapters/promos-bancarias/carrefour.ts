import type { PromoBancaria, PromoBancoAdapter } from '../types.ts'
import { extraerDias } from '../../src/lib/promoDias.ts'

// Carrefour expone sus promos bancarias vigentes a través de una query GraphQL persistida
// pública (la misma que usa la sección "Descuentos Bancarios" del sitio) sobre su colección
// de dataentities "BP" (Bank Promotions). A diferencia de Monarca/DIA (que sólo muestran el
// banner con el % como imagen), acá el título, el % de descuento, el texto de vigencia y las
// condiciones vienen como texto real — permitido por robots.txt (no es una ruta /checkout ni
// /busca disallowed).

const GRAPHQL_URL = 'https://www.carrefour.com.ar/_v/public/graphql/v1'
const SHA256_HASH = 'e3aa1d96402d80dbca5c2c9dbcb7ff859970db0ccfdb64e583fb8a9b1bbff49e'
const HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
}

// El texto de vigencia (`c.validText`) es prosa libre ("Todos los Jueves de Agosto",
// "Lunes, Martes y Miércoles de Agosto") — extraerDias() busca los nombres de día que
// aparezcan como keyword; si no aparece ninguno (promos válidas "todo el mes"), devuelve
// undefined en vez de asumir "todos los días", que sería un dato inventado.

function buildUrl(): string {
  const iso = new Date().toISOString().slice(0, 19)
  const where = `active=true AND ((active_from < ${iso}) AND (active_to > ${iso}))`
  const variablesInner = Buffer.from(JSON.stringify({ where, account: 'carrefourar' })).toString('base64')
  const extensions = {
    persistedQuery: {
      version: 1,
      sha256Hash: SHA256_HASH,
      sender: 'valtech.carrefourar-bank-promotions@0.x',
      provider: 'vtex.store-graphql@2.x'
    },
    variables: variablesInner
  }
  const params = new URLSearchParams({
    workspace: 'master',
    maxAge: 'short',
    appsEtag: 'remove',
    domain: 'store',
    locale: 'es-AR',
    operationName: 'GetPromotions',
    variables: '{}',
    extensions: JSON.stringify(extensions)
  })
  return `${GRAPHQL_URL}?${params.toString()}`
}

function campos(fields: { key: string; value: string }[]): Record<string, string> {
  const o: Record<string, string> = {}
  for (const f of fields) o[f.key] = f.value
  return o
}

function toNumber(v: string | undefined): number | undefined {
  if (!v || v === 'null') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function toDate(v: string | undefined): Date | undefined {
  if (!v || v === 'null') return undefined
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? undefined : d
}

const CarrefourPromosAdapter: PromoBancoAdapter = {
  nombre: 'Carrefour',
  fuente: 'scraping_web',
  async obtenerPromos(): Promise<PromoBancaria[]> {
    const res = await fetch(buildUrl(), { headers: HEADERS })
    if (!res.ok) throw new Error(`HTTP ${res.status} en GetPromotions`)
    const data: any = await res.json()
    const documentos: any[] = data?.data?.documents || []

    const out: PromoBancaria[] = []
    for (const doc of documentos) {
      const c = campos(doc.fields || [])
      if (!c.title) continue

      out.push({
        supermercadoId: 'Carrefour',
        externalId: c.id,
        titulo: c.title,
        descripcion: c.sub_title && c.sub_title !== 'null' ? c.sub_title : undefined,
        descuentoPorcentaje: toNumber(c.discount_percentage),
        dias: extraerDias(c.validText),
        aplicaOnline: c.ecommerce === 'true' ? true : c.ecommerce === 'false' ? false : undefined,
        validoDesde: toDate(c.active_from),
        validoHasta: toDate(c.active_to),
        fechaRelevado: new Date(),
        fuente: 'scraping_web'
      })
    }

    return out
  }
}

export default CarrefourPromosAdapter
