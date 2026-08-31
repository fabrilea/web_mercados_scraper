import * as cheerio from 'cheerio'
import type { PromoBancaria, PromoBancoAdapter } from '../types.ts'
import { extraerDias } from '../../src/lib/promoDias.ts'
import { ocrImageText, cerrarOcr } from '../../src/lib/ocr.ts'

// Cooperativa Obrera publica sus promos bancarias como flyers (imagen), no como texto —
// a diferencia de Carrefour (que sí tiene título/%/vigencia en texto real vía GraphQL). A
// diferencia de Monarca (banners casi sin texto, donde el OCR probado dio basura — ver
// adapters/_archived/promos-bancarias/monarca.ts), estos flyers sí traen párrafos de
// condiciones legibles, así que se corre OCR (tesseract.js) sobre cada imagen para no
// depender de que el usuario la abra.
// No se extrae descuentoPorcentaje del texto OCR: estos flyers son casi siempre promos de
// "cuotas sin interés" (no de % de descuento), y el único patrón "N%" que suele aparecer es
// el de "C.F.T.: 0,0%" (costo financiero total, letra chica legal) — tomarlo como si fuera
// el descuento sería un dato inventado y además engañoso (parece "sin promo").
// robots.txt de cooperativaobrera.coop no bloquea /financiacion-y-promos-bancarias ni /images/.

const PAGE_URL = 'https://www.cooperativaobrera.coop/financiacion-y-promos-bancarias'
const SITE_ORIGIN = 'https://www.cooperativaobrera.coop'
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
}

// Los flyers de promo viven bajo /images/<año>/<mes>/Bancos/... o /images/<año>/<mes>/naranja/...
// Esto los separa de logos (/images/Logos/...) y banners separadores (/images/banners/...),
// que no son promos.
const FLYER_PATH_RE = /\/images\/\d{4}\/\d{2}\/(bancos|naranja)\//i

const NOMBRE_BANCO: Record<string, string> = {
  mp: 'Mercado Pago',
  bapro: 'Banco Provincia',
  credicoop: 'Banco Credicoop',
  bna: 'Banco Nación',
  galicia: 'Banco Galicia',
  hipotecario: 'Banco Hipotecario',
  naranja: 'Naranja X',
  comafi: 'Banco Comafi',
  pampa: 'Banco de la Pampa',
  patagonia: 'Banco Patagonia',
  sol: 'Banco del Sol',
  chubut: 'Banco del Chubut'
}

function humanizar(segmento: string): string {
  return segmento
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function inferirBanco(urlPath: string, filename: string): string {
  const enCarpetaBancos = urlPath.match(/\/bancos\/([^/]+)\//i)
  const clave = (enCarpetaBancos ? enCarpetaBancos[1] : /\/naranja\//i.test(urlPath) ? 'naranja' : '').toLowerCase()
  if (clave && NOMBRE_BANCO[clave]) return NOMBRE_BANCO[clave]
  if (clave) return humanizar(clave)
  // Archivo suelto directamente en /Bancos/ (sin subcarpeta de banco), ej. promo genérica
  // de club de beneficios: se humaniza el nombre de archivo como mejor esfuerzo.
  return humanizar(filename.replace(/\.\w+$/, '').replace(/^\d+x\d+[-_]?/i, ''))
}

function absoluta(url: string): string {
  return url.startsWith('http') ? url : `${SITE_ORIGIN}${url.startsWith('/') ? '' : '/'}${url}`
}

// El sitio sirve el mismo flyer alternando extensión (.jpg / .webp) entre corridas — usar la
// URL cruda como externalId rompía el upsert (cada corrida creaba filas nuevas en vez de
// actualizar las existentes). Se saca la extensión y query string para que ambas variantes
// del mismo flyer mapeen al mismo id estable.
function idEstable(url: string): string {
  return url.replace(/\.\w+(\?.*)?$/, '')
}

const CooperativaObreraPromosAdapter: PromoBancoAdapter = {
  nombre: 'Cooperativa Obrera',
  fuente: 'scraping_web',
  async obtenerPromos(): Promise<PromoBancaria[]> {
    const res = await fetch(PAGE_URL, { headers: HEADERS })
    if (!res.ok) throw new Error(`HTTP ${res.status} en ${PAGE_URL}`)
    const html = await res.text()
    const $ = cheerio.load(html)

    const vistos = new Set<string>()
    const candidatos: { url: string; filename: string }[] = []

    $('.sppb-addon-single-image-container').each((_, el) => {
      const $container = $(el)
      // Se prefiere el <a href> (imagen de mayor resolución, la que se ve al hacer click)
      // por sobre el data-large del <img> (versión recortada para el slider), cuando ambos
      // apuntan a un flyer válido.
      const href = $container.find('a[href*="/images/"]').attr('href')
      const dataLarge = $container.find('img[data-large*="/images/"]').attr('data-large')
      const candidato = [href, dataLarge].find((u) => u && FLYER_PATH_RE.test(u))
      if (!candidato) return

      const url = absoluta(candidato)
      const clave = idEstable(url)
      if (vistos.has(clave)) return
      vistos.add(clave)

      candidatos.push({ url, filename: url.split('/').pop() || '' })
    })

    const out: PromoBancaria[] = []

    // Secuencial (no Promise.all): un solo worker de tesseract.js se reutiliza entre
    // imágenes, y corriéndolo en paralelo sobre el mismo worker generaría resultados
    // cruzados entre reconocimientos.
    for (const { url, filename } of candidatos) {
      let texto = ''
      try {
        texto = await ocrImageText(url)
      } catch (e) {
        console.warn('Cooperativa Obrera: OCR falló para', url, e)
      }

      out.push({
        supermercadoId: 'Cooperativa Obrera',
        externalId: idEstable(url),
        titulo: inferirBanco(url, filename),
        descripcion: texto || 'El OCR no pudo extraer texto de este flyer — ver la imagen original para el detalle.',
        dias: extraerDias(filename + ' ' + texto),
        imageUrl: url,
        fechaRelevado: new Date(),
        fuente: 'scraping_web'
      })
    }

    await cerrarOcr()
    return out
  }
}

export default CooperativaObreraPromosAdapter
