// Datos fijos de cada supermercado relevado: su web pública, cómo se arma el link a un producto y
// los helpers que comparten el adaptador de scraping y la verificación en vivo
// (src/lib/verificacionEnVivo.ts) — si los dos parsearan la fuente cada uno a su manera, un cambio
// del sitio rompería uno solo y la verificación empezaría a contradecir al scraper sin motivo.
//
// Sin dependencias de servidor ni de Prisma: lo importan los adaptadores (ts-node), las rutas de
// API y componentes de cliente.

/**
 * Único lugar con la lista de supermercados + su web pública. No hay un campo `url` en el modelo
 * Supermercado (ver prisma/schema.prisma): son 6 sitios fijos y conocidos. El nombre tiene que
 * coincidir con `Supermercado.nombre`.
 */
export const SUPERMERCADOS_DISPONIBLES = [
  { nombre: 'Carrefour', url: 'https://www.carrefour.com.ar' },
  { nombre: 'Cooperativa Obrera', url: 'https://www.lacoopeencasa.coop' },
  { nombre: 'Golopolis', url: 'https://golopolis.com.ar/app/' },
  { nombre: 'Monarca Digital', url: 'https://web.monarcadigital.com.ar' },
  { nombre: 'Supermercados DIA', url: 'https://diaonline.supermercadosdia.com.ar' },
  { nombre: 'Vea', url: 'https://www.vea.com.ar' }
]

export function sitioDeSupermercado(nombre: string | null | undefined): string | undefined {
  return SUPERMERCADOS_DISPONIBLES.find((s) => s.nombre === nombre)?.url
}

export interface LinkProducto {
  href: string
  /**
   * true = lleva a la página (o al listado) donde está ESE producto; false = sólo a la home del
   * super, porque ese sitio no tiene una URL por producto confirmada. La UI lo dice distinto
   * ("Ver en X" vs. "Buscar en X") para no prometer algo que el link no cumple.
   */
  exacto: boolean
}

export function linkDeProducto(supermercado: string | null | undefined, urlProducto: string | null | undefined): LinkProducto | null {
  if (urlProducto && /^https:\/\//.test(urlProducto)) return { href: urlProducto, exacto: true }
  const sitio = sitioDeSupermercado(supermercado)
  return sitio ? { href: sitio, exacto: false } : null
}

// --- VTEX (Carrefour, DIA, Vea) ---

/** Base de la API pública de VTEX de cada super que corre sobre esa plataforma. */
export const VTEX_BASE_POR_SUPER: Record<string, string> = {
  Carrefour: 'https://www.carrefour.com.ar',
  'Supermercados DIA': 'https://diaonline.supermercadosdia.com.ar',
  Vea: 'https://www.vea.com.ar'
}

/**
 * Página del producto a partir de un resultado de `catalog_system/pub/products/search`. La API
 * trae `link` (URL absoluta) y `linkText` (el slug); se arma desde el slug si `link` no vino.
 */
export function urlProductoVtex(base: string, producto: { link?: unknown; linkText?: unknown }): string | undefined {
  if (typeof producto.link === 'string' && producto.link.startsWith('https://')) return producto.link
  if (typeof producto.linkText === 'string' && producto.linkText) return `${base}/${producto.linkText}/p`
  return undefined
}

// --- Golopolis ---

export const GOLOPOLIS_BASE = 'https://golopolis.com.ar/app/'

/** Productos embebidos como JSON (`var aProducts = [...]`) en una página de subcategoría. */
export function extraerProductosGolopolis(html: string): any[] {
  const m = html.match(/var\s+aProducts\s*=\s*(\[.*?\]);/s)
  if (!m) return []
  return JSON.parse(m[1])
}

// --- Monarca ---

export const MONARCA_API = 'https://web.monarcadigital.com.ar/api'

/**
 * Precio unitario de promo de Monarca: `totalPrice` cubre `productQuantity` unidades (promos tipo
 * "4x $1550"), así que se prorratea. Mismo criterio que adapters/monarca.ts.
 */
export function precioPromoUnitarioMonarca(promo: { totalPrice?: unknown; productQuantity?: unknown } | null | undefined): number | undefined {
  if (!promo) return undefined
  const v = Number(promo.totalPrice) / (Number(promo.productQuantity) || 1)
  return Number.isFinite(v) && v > 0 ? v : undefined
}
