import { ProductoPrecio, SupermercadoAdapter } from './types'
import { categoriaDesdeSegmentos } from '../src/lib/categoriaHeuristica.ts'

// Carrefour es un sitio VTEX. En vez de scrapear HTML, se usa la API pública de
// búsqueda "legacy" de VTEX (catalog_system/pub/products/search), que expone EAN real,
// precio, precio de lista (para detectar promo) y categoría — sin necesidad de Playwright.
// Permitido por robots.txt (no está en las rutas disallow: /busca/, /checkout/, etc.).

const BASE = 'https://www.carrefour.com.ar'
const HEADERS = {
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
}

// Categorías reales de nivel superior del sitio (api/catalog_system/pub/category/tree/1),
// filtradas a las de supermercado (se excluyen Electro y tecnología, Hogar, Indumentaria,
// Gift Cards, Juguetería y Librería, Automotor, Aire Libre y Ocio). Se puede sobreescribir
// con CARREFOUR_CATEGORIES (lista separada por comas de slugs de URL).
const CATEGORIAS_DEFAULT = [
  'almacen',
  'desayuno-y-merienda',
  'bebidas',
  'lacteos-y-productos-frescos',
  'carnes-y-pescados',
  'frutas-y-verduras',
  'panaderia',
  'congelados',
  'limpieza',
  'perfumeria-y-farmacia',
  'mundo-bebe',
  'mascotas'
]

// Nombre canónico de categoría (mismo vocabulario que el resto de los adaptadores)
const CATEGORIA_CANONICA: Record<string, string> = {
  almacen: 'Almacén',
  'desayuno-y-merienda': 'Desayuno',
  bebidas: 'Bebidas sin Alcohol',
  'lacteos-y-productos-frescos': 'Lácteos',
  'carnes-y-pescados': 'Carnicería',
  'frutas-y-verduras': 'Frutas y Verduras',
  panaderia: 'Panadería',
  congelados: 'Congelados',
  limpieza: 'Limpieza',
  'perfumeria-y-farmacia': 'Perfumería',
  'mundo-bebe': 'Bebés y Niños',
  mascotas: 'Mascotas'
}

const PAGE_SIZE = 50
// El límite anterior (200) dejaba afuera la enorme mayoría del catálogo: Almacén solo en
// Carrefour tiene ~6300 productos. La paginación igual corta sola cuando una página vuelve
// vacía o incompleta, así que este número actúa como techo de seguridad, no como objetivo.
const MAX_PRODUCTOS_POR_CATEGORIA = Number(process.env.CARREFOUR_MAX_PRODUCTOS || 10000)

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

async function fetchPagina(categoria: string, from: number, to: number) {
  const url = `${BASE}/api/catalog_system/pub/products/search/${categoria}?_from=${from}&_to=${to}`
  const res = await fetch(url, { headers: HEADERS })
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} en ${url}`)
  return res.json()
}

const CarrefourAdapter: SupermercadoAdapter = {
  nombre: 'Carrefour',
  fuente: 'scraping_web',
  async obtenerProductos(): Promise<ProductoPrecio[]> {
    const categoriasEnv = process.env.CARREFOUR_CATEGORIES
    const categorias = categoriasEnv ? categoriasEnv.split(',').map((c) => c.trim()).filter(Boolean) : CATEGORIAS_DEFAULT

    const out: ProductoPrecio[] = []
    const seen = new Set<string>()

    for (const categoria of categorias) {
      let from = 0
      let traidos = 0

      while (traidos < MAX_PRODUCTOS_POR_CATEGORIA) {
        try {
          const to = from + PAGE_SIZE - 1
          const productos: any[] = await fetchPagina(categoria, from, to)
          if (!Array.isArray(productos) || !productos.length) break

          for (const p of productos) {
            const items = Array.isArray(p.items) ? p.items : []
            for (const item of items) {
              const seller = item.sellers?.[0]
              const offer = seller?.commertialOffer
              if (!offer || !offer.Price) continue

              const key = item.itemId || item.ean || `${p.productId}-${item.name}`
              if (seen.has(key)) continue
              seen.add(key)

              const nombreOriginal = item.nameComplete || item.name || p.productName
              if (!nombreOriginal) continue

              const ean = esEanValido(item.ean) ? item.ean : undefined
              const precioLista = Number(offer.ListPrice) || Number(offer.Price)
              const precio = precioLista
              const precioPromo = Number(offer.Price) < precioLista ? Number(offer.Price) : undefined
              const imagenUrl = item.images?.[0]?.imageUrl || undefined

              out.push({
                supermercadoId: 'Carrefour',
                nombreOriginal,
                nombreNormalizado: normalizeName(nombreOriginal),
                marca: p.brand || undefined,
                codigoBarras: ean,
                imagenUrl,
                categoria: categoriaDesdeSegmentos(p.categories, CATEGORIA_CANONICA[categoria]),
                precio,
                precioPromo,
                unidad: item.measurementUnit || 'unidad',
                fechaRelevado: new Date(),
                fuente: 'scraping_web'
              })
              traidos++
            }
          }

          if (productos.length < PAGE_SIZE) break
          from += PAGE_SIZE
          await sleep(150)
        } catch (e) {
          console.warn('Carrefour: error en categoría', categoria, 'desde', from, e)
          break
        }
      }
    }

    return out
  }
}

export default CarrefourAdapter
