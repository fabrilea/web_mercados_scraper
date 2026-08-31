import { ProductoPrecio, SupermercadoAdapter } from './types'
import { categoriaDesdeSegmentos } from '../src/lib/categoriaHeuristica.ts'

// Cooperativa Obrera — e-commerce "La Coope en Casa" (lacoopeencasa.coop).
// A diferencia de los sitios VTEX (Carrefour, DIA), este sitio expone una API JSON propia
// (api.lacoopeencasa.coop) que no requiere Playwright. El catálogo online es único
// (no varía por localidad seleccionada, verificado empíricamente), igual que Carrefour/DIA.
// Cooperativa Obrera tiene sucursal en Tandil (id_localidad 326 en su propio sistema),
// aunque no está en la red de Precios Claros/SEPA, por lo que este es el único origen
// de precios para esta cadena.

const API_BASE = 'https://api.lacoopeencasa.coop/api'
const HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'Referer': 'https://www.lacoopeencasa.coop/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
}

// Categorías de nivel 1 del árbol de categorías del sitio -> nombre canónico
const CATEGORIAS_DEFAULT = [
  { id: 2, nombre: 'Almacén', categoria: 'Almacén' },
  { id: 3, nombre: 'Frescos', categoria: 'Productos Frescos' },
  { id: 4, nombre: 'Bebidas', categoria: 'Bebidas sin Alcohol' },
  { id: 5, nombre: 'Perfumería', categoria: 'Perfumería' },
  { id: 6, nombre: 'Limpieza', categoria: 'Limpieza' }
]

// El límite anterior (3 páginas) dejaba afuera la mayoría del catálogo: Almacén solo
// tiene ~1900 artículos. Además, sólo la primera tanda trae 32 artículos; las siguientes
// traen 8 cada vez (ver obtenerPagina), así que hacen falta muchas más "páginas" para
// cubrir una categoría grande. La paginación igual corta sola cuando una tanda vuelve
// vacía, así que este número actúa como techo de seguridad, no como objetivo.
const MAX_PAGINAS_POR_CATEGORIA = Number(process.env.LACOOPE_MAX_PAGINAS || 300)

// ⚠️ PENDIENTE: cada categoría trae bastante menos de lo esperado (ej. Almacén corta en 248
// artículos, muy por debajo de los ~1900 reales) y no es por errores de red — no hay ningún
// throw ni "error en categoría X" en el log, la tanda simplemente empieza a volver vacía en un
// punto fijo y reproducible aunque se reintente en el mismo lugar de la secuencia normal de
// paginación. Curiosamente, pegándole a la API a mano con un `pagina` arbitrario (no el que
// seguiría en la secuencia) y el mismo `cant_articulos` donde cortó, sí devuelve más datos —
// sugiere que `pagina` no es tan decorativo como se pensaba y el corte depende de algo del
// lado del server relacionado a esa secuencia incremental, no de cuántos artículos ya se
// trajeron. Hace falta investigar la API a mano (con curl/Postman, variando `pagina` de forma
// no incremental) para entender qué la hace cortar — no alcanza con reintentar.

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

function toFecha(fechaStr: string | null | undefined): Date | undefined {
  if (!fechaStr || fechaStr === '0000-00-00') return undefined
  const d = new Date(fechaStr)
  return Number.isNaN(d.getTime()) ? undefined : d
}

async function obtenerPagina(idCategoria: number, pagina: number, cantidadYaTraida: number) {
  const res = await fetch(`${API_BASE}/articulos/pagina`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      id_busqueda: String(idCategoria),
      pagina,
      filtros: {
        preciomenor: -1,
        preciomayor: -1,
        marca: [],
        categoria: [],
        tipo_seleccion: 'categoria',
        filtros_gramaje: [],
        filtros_descuento: [],
        // El sitio no pagina en bloques fijos: la primera tanda trae 32 artículos, pero
        // las siguientes traen sólo 8 cada vez. Asumir 32 por página (pagina * 32) hacía
        // que este parámetro (que el backend usa como offset real de artículos ya vistos,
        // no como número de página) quedara mal calculado a partir de la segunda tanda, y
        // el sitio devolvía los mismos 8 artículos una y otra vez en vez de avanzar.
        cant_articulos: cantidadYaTraida,
        ofertas: false,
        modificado: false,
        primer_filtro: ''
      }
    })
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} en articulos/pagina (categoria ${idCategoria}, pagina ${pagina})`)
  const data: any = await res.json()
  if (data?.estado !== 1) throw new Error(`Respuesta inesperada: ${data?.mensaje}`)
  return data.datos
}

const CooperativaObreraAdapter: SupermercadoAdapter = {
  nombre: 'Cooperativa Obrera',
  fuente: 'scraping_web',
  async obtenerProductos(): Promise<ProductoPrecio[]> {
    const out: ProductoPrecio[] = []

    for (const cat of CATEGORIAS_DEFAULT) {
      let cantidadTraida = 0
      for (let pagina = 0; pagina < MAX_PAGINAS_POR_CATEGORIA; pagina++) {
        try {
          // Ni un error de red puntual ni una tanda vacía deberían dar por terminada toda la
          // categoría de una: verificado a mano que la API a veces devuelve 0 artículos de
          // forma transitoria (no un error) para un offset que, reintentado, sí trae más datos
          // — antes eso se tomaba como "se acabó el catálogo" (`if (!articulos.length) break`)
          // y dejaba categorías con una fracción mínima de su catálogo real (ej. Almacén con
          // ~250 de ~1900 artículos esperados). Ahora sólo se da por terminada la categoría si
          // la tanda sigue vacía después de reintentar.
          let articulos: any[] = []
          let intentos = 0
          for (;;) {
            try {
              const datos = await obtenerPagina(cat.id, pagina, cantidadTraida)
              articulos = Array.isArray(datos?.articulos) ? datos.articulos : []
              if (articulos.length || intentos >= 3) break
            } catch (err) {
              if (intentos >= 2) throw err
            }
            intentos++
            await sleep(500 * intentos)
          }
          if (!articulos.length) break
          cantidadTraida += articulos.length

          for (const a of articulos) {
            // Cuando hay promo, `a.precio` YA viene con el descuento aplicado y
            // `a.precio_anterior` es el precio de lista real (sin promo); sin promo, ambos
            // campos son iguales. Guardar `a.precio` tal cual como si fuera el precio
            // "normal" perdía el precio de lista real de todo producto en oferta y además
            // duplicaba el mismo valor en precioPromo, sin aportar la referencia de cuánto
            // se ahorra ni qué pasa cuando termine la promo.
            const precioAnterior = Number(a.precio_anterior)
            const precioActual = Number(a.precio)
            if (!precioActual) continue
            const precio = precioAnterior > precioActual ? precioAnterior : precioActual
            const nombreOriginal = [a.marca_desc, a.descripcion].filter(Boolean).join(' ').trim()
            const precioPromo = a.existe_promo === '1' && precioActual < precio ? precioActual : undefined
            const unidad = [a.gramaje, a.unimed_desc].filter(Boolean).join(' ').trim()

            out.push({
              supermercadoId: 'Cooperativa Obrera',
              nombreOriginal,
              nombreNormalizado: normalizeName(nombreOriginal),
              marca: a.marca_desc || undefined,
              imagenUrl: a.imagen || undefined,
              categoria: categoriaDesdeSegmentos(
                [a.categoria_inicial_desc, a.categoria_secundaria_desc, a.categoria_terciaria_desc, a.categoria_desc],
                cat.categoria
              ),
              precio,
              precioPromo,
              unidad: unidad || 'unidad',
              fechaRelevado: new Date(),
              promoDescripcion: a.descripcion_promo || undefined,
              promoValidoDesde: toFecha(a.vigencia_promo_desde),
              promoValidoHasta: toFecha(a.vigencia_promo),
              fuente: 'scraping_web'
            })
          }

          await sleep(200)
        } catch (e) {
          console.warn('Cooperativa Obrera: error en categoría', cat.nombre, 'página', pagina, e)
          break
        }
      }
    }

    return out
  }
}

export default CooperativaObreraAdapter
