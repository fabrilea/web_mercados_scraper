import { ProductoPrecio, SupermercadoAdapter } from './types'

// Monarca Digital expone una API JSON propia (web.monarcadigital.com.ar/api) que no
// requiere Playwright: da nombre limpio, marca, presentación, código de barras real (EAN),
// categoría real (con jerarquía) y promociones con fecha de vigencia. Mucho más confiable
// que scrapear las tarjetas de producto en HTML (que traen texto promocional mezclado
// con el nombre, ej. "70% EN LA 2DA UNIDAD ...", "2x1 ...").

const API_BASE = 'https://web.monarcadigital.com.ar/api'
const HEADERS = {
  'Accept': 'application/json',
  'Referer': 'https://web.monarcadigital.com.ar/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
}

// Categorías de nivel superior reales del sitio -> nombre canónico usado en toda la app.
const CATEGORIAS_DEFAULT: Record<number, string> = {
  1001: 'Almacén',
  15295: 'Bebés y Niños',
  1005: 'Bebidas con Alcohol',
  1004: 'Bebidas sin Alcohol',
  1013: 'Carnicería',
  1010: 'Congelados',
  1002: 'Desayuno',
  1014: 'Fiambrería',
  1012: 'Frutas y Verduras',
  1003: 'Kiosco',
  1009: 'Lácteos',
  1008: 'Limpieza',
  15212: 'Mascotas',
  1015: 'Panadería',
  1007: 'Papeles',
  1006: 'Perfumería',
  15252: 'Productos Frescos'
}

// El límite anterior (2 páginas de 100 = 200) dejaba afuera la mayoría del catálogo:
// Almacén solo tiene ~1170 productos. La paginación igual corta sola cuando una página
// vuelve vacía o incompleta, así que este número actúa como techo de seguridad.
const MAX_PAGINAS_POR_CATEGORIA = Number(process.env.MONARCA_MAX_PAGINAS || 50)
const PAGE_SIZE = 100

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

// Fechas del tipo "13/08/2026 22:15:00"
function parseFechaAr(s: string | null | undefined): Date | undefined {
  if (!s) return undefined
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/)
  if (!m) return undefined
  const [, dd, mm, yyyy, hh, min, ss] = m
  const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min), Number(ss))
  return Number.isNaN(d.getTime()) ? undefined : d
}

async function fetchJson(url: string) {
  const res = await fetch(url, { headers: HEADERS })
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`)
  return res.json()
}

const MonarcaAdapter: SupermercadoAdapter = {
  nombre: 'Monarca Digital',
  fuente: 'scraping_web',
  async obtenerProductos(): Promise<ProductoPrecio[]> {
    const categoriasEnv = process.env.MONARCA_CATEGORY_IDS
    const categoryIds = categoriasEnv
      ? categoriasEnv.split(',').map((s) => Number(s.trim())).filter(Boolean)
      : Object.keys(CATEGORIAS_DEFAULT).map(Number)

    const out: ProductoPrecio[] = []
    const seen = new Set<number>()

    for (const categoryId of categoryIds) {
      for (let pagina = 0; pagina < MAX_PAGINAS_POR_CATEGORIA; pagina++) {
        try {
          const data: any = await fetchJson(`${API_BASE}/products/search?categoryId=${categoryId}&page=${pagina}&size=${PAGE_SIZE}`)
          const productos = data?.products?.content
          if (!Array.isArray(productos) || !productos.length) break

          for (const p of productos) {
            if (seen.has(p.id)) continue
            seen.add(p.id)

            const nombreOriginal = String(p.description || '').trim()
            if (!nombreOriginal) continue

            const promo = Array.isArray(p.promotions) && p.promotions.length ? p.promotions[0] : null
            const precio = Number(p.price) || 0
            // promo.totalPrice es lo que se paga en total, no por unidad: en promos "PXQ"
            // (ej. "4x $1550") o "NXM" (ej. "comprá 2 y pagás 1") totalPrice cubre
            // promo.productQuantity unidades, no una sola. Si se usara tal cual como precio
            // "por producto" quedaría mal comparado contra el precio normal (que sí es por
            // unidad) — por ej. mostraría $1550 como si fuera más caro que el precio de
            // $399, cuando en realidad son 4 unidades a $387,50 c/u. Se prorratea acá y sólo
            // se informa como precioPromo si de verdad resulta más barato por unidad; la
            // condición de "comprar varias" queda igual aclarada en promoDescripcion.
            const precioPromoUnitario = promo
              ? Number(promo.totalPrice) / (Number(promo.productQuantity) || 1)
              : undefined
            const precioPromo = precioPromoUnitario !== undefined && precioPromoUnitario < precio
              ? precioPromoUnitario
              : undefined

            out.push({
              supermercadoId: 'Monarca Digital',
              nombreOriginal,
              nombreNormalizado: normalizeName(nombreOriginal),
              marca: p.brand || undefined,
              codigoBarras: p.barcode || undefined,
              imagenUrl: p.featuredImage?.path || undefined,
              categoria: CATEGORIAS_DEFAULT[categoryId] || undefined,
              precio,
              precioPromo,
              unidad: p.presentation || 'unidad',
              fechaRelevado: new Date(),
              promoDescripcion: promo?.content || undefined,
              promoValidoDesde: promo ? parseFechaAr(promo.fromDate) : undefined,
              promoValidoHasta: promo ? parseFechaAr(promo.dateTo) : undefined,
              fuente: 'scraping_web'
            })
          }

          if (productos.length < PAGE_SIZE) break
          await sleep(200)
        } catch (e) {
          console.warn('Monarca: error en categoría', categoryId, 'página', pagina, e)
          break
        }
      }
    }

    return out
  }
}

export default MonarcaAdapter
