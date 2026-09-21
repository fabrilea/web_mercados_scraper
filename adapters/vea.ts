import { ProductoPrecio, SupermercadoAdapter } from './types'
import { categoriaDesdeSegmentos } from '../src/lib/categoriaHeuristica.ts'

// Vea (grupo Cencosud) es, igual que Carrefour/DIA, un sitio VTEX: se usa la misma API
// pública de búsqueda "legacy" de VTEX (catalog_system/pub/products/search) en vez de
// Playwright/HTML — expone EAN real, precio y categoría directamente. Permitido por
// robots.txt (no está en las rutas disallow: /Busca/, /Quick-View/, /Control/, /checkout,
// /login). Catálogo online nacional único (no varía por sucursal), verificado igual que
// con Carrefour/DIA. A diferencia de esos dos, acá el precio de lista NO sale de
// `ListPrice` — ver el comentario junto a su uso más abajo para el porqué.

const BASE = 'https://www.vea.com.ar'
const HEADERS = {
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
}

// Categorías reales de nivel superior del sitio (api/catalog_system/pub/category/tree/1),
// filtradas a las de supermercado (se excluyen Electro, Hogar y textil, Tiempo Libre, Sin
// Categoría, Felices Fiestas/Huevos de pascua —eventos estacionales—, Panadería duplicada
// de Panaderia y Pasteleria, y una categoría con id fuera de rango que trae un único
// producto mal cargado). Se puede sobreescribir con VEA_CATEGORIES (lista separada por
// comas de slugs de URL).
const CATEGORIAS_DEFAULT = [
  'almacen',
  'bebidas',
  'frutas-y-verduras',
  'carnes',
  'pescados-y-mariscos',
  'quesos-y-fiambres',
  'lacteos',
  'congelados',
  'panaderia-y-pasteleria',
  'rotiseria',
  'perfumeria',
  'limpieza',
  'mascotas',
  'mundo-bebe',
  'pastas-frescas'
]

// Nombre canónico de categoría (mismo vocabulario que el resto de los adaptadores)
const CATEGORIA_CANONICA: Record<string, string> = {
  almacen: 'Almacén',
  bebidas: 'Bebidas sin Alcohol',
  'frutas-y-verduras': 'Frutas y Verduras',
  carnes: 'Carnicería',
  'pescados-y-mariscos': 'Pescadería',
  'quesos-y-fiambres': 'Fiambrería',
  lacteos: 'Lácteos',
  congelados: 'Congelados',
  'panaderia-y-pasteleria': 'Panadería',
  rotiseria: 'Comidas Listas',
  perfumeria: 'Perfumería',
  limpieza: 'Limpieza',
  mascotas: 'Mascotas',
  'mundo-bebe': 'Bebés y Niños',
  'pastas-frescas': 'Pastas Frescas'
}

const PAGE_SIZE = 50
// Mismo techo de seguridad que Carrefour/DIA: la paginación corta sola cuando una página
// vuelve vacía o incompleta, así que este número no es un objetivo sino un límite superior.
const MAX_PRODUCTOS_POR_CATEGORIA = Number(process.env.VEA_MAX_PRODUCTOS || 10000)

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

const VeaAdapter: SupermercadoAdapter = {
  nombre: 'Vea',
  fuente: 'scraping_web',
  async obtenerProductos(): Promise<ProductoPrecio[]> {
    const categoriasEnv = process.env.VEA_CATEGORIES
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
              // Mismo filtro de disponibilidad que Carrefour/DIA, pero acá es lo que más
              // cambia: la API pública de búsqueda de Vea devuelve muchísimo SKU sin stock o
              // discontinuado (hasta el 62% en las páginas profundas de una categoría), y el
              // precio que traen esos es basura — el 100% de los productos de Vea con precio
              // absurdo que había en la DB (huevos a $282, carne a $1,75 el kg: ~190x más
              // baratos que el mismo producto en otro super) venían con `IsAvailable: false` y
              // `AvailableQuantity: 0`. Los disponibles, en cambio, dan precios sanos (mediana
              // 0,95x contra los otros supers), así que este filtro es toda la diferencia.
              //
              // Ojo: esto saca más productos de los que el sitio realmente esconde — Vea sigue
              // listando en su buscador bastante cosa sin stock. Se filtran igual a propósito:
              // cuando un SKU de VTEX queda sin stock su precio se congela en el que tenía, sin
              // ninguna marca de cuán viejo es. Con la inflación local, un precio congelado hace
              // años es justamente el caso de "huevos a $282". Aunque el número parezca sano no
              // es confiable, y de todas formas no se puede comprar: recomendar un viaje a Vea
              // por un producto que no tiene stock es peor que no mostrarlo.
              if (offer.IsAvailable === false || !(Number(offer.AvailableQuantity) > 0)) continue
              if (!(Number(offer.Price) > 0)) continue

              const key = item.itemId || item.ean || `${p.productId}-${item.name}`
              if (seen.has(key)) continue
              seen.add(key)

              const nombreOriginal = item.nameComplete || item.name || p.productName
              if (!nombreOriginal) continue

              const ean = esEanValido(item.ean) ? item.ean : undefined
              // A diferencia de Carrefour/DIA, en Vea `offer.ListPrice` no sirve como precio de
              // lista: viene siempre ~82.6x más alto que `offer.Price` en TODO producto muestreado
              // (constante fija en de decenas de categorías, no varía por producto), así que es un
              // artefacto/bug del catálogo VTEX de Vea, no un precio de lista real — usarlo
              // inventaría una promo falsa enorme en cada producto. `offer.PriceWithoutDiscount` sí
              // es el campo estándar de VTEX para el precio sin descuento, pero en la práctica nunca
              // difiere de `Price` en el catálogo de Vea (las promos del sitio se aplican por
              // cluster/checkout, no cambian el precio del listado) — se lo deja como comparación
              // por si algún producto puntual sí lo expone, sin inventar nada cuando no está.
              const precioActual = Number(offer.Price)
              const precioLista = Number(offer.PriceWithoutDiscount) || precioActual
              const precio = precioLista
              const precioPromo = precioActual < precioLista ? precioActual : undefined
              const imagenUrl = item.images?.[0]?.imageUrl || undefined

              out.push({
                supermercadoId: 'Vea',
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
          console.warn('Vea: error en categoría', categoria, 'desde', from, e)
          break
        }
      }
    }

    return out
  }
}

export default VeaAdapter
