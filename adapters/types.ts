export type FuenteDatos = 'sepa' | 'scraping_web' | 'carga_manual' | 'api'

export interface ProductoPrecio {
  supermercadoId: string
  nombreOriginal: string
  nombreNormalizado: string
  marca?: string
  codigoBarras?: string
  categoria?: string
  imagenUrl?: string
  precio: number
  precioPromo?: number
  unidad: string
  fechaRelevado: Date
  promoDescripcion?: string
  promoValidoDesde?: Date
  promoValidoHasta?: Date
  fuente?: string
}

export interface SupermercadoAdapter {
  nombre: string
  fuente: FuenteDatos
  obtenerProductos(): Promise<ProductoPrecio[]>
}

// Promos de medios de pago (banco/billetera) — un dominio de datos distinto al de
// ProductoPrecio: no hay "producto" ni "precio" involucrado, sino un % de descuento
// condicionado a día de la semana + medio de pago. externalId es el id propio de la fuente
// (cuando lo tiene) para poder actualizar sin duplicar en cada corrida.
export interface PromoBancaria {
  supermercadoId: string
  externalId?: string
  titulo: string
  descripcion?: string
  descuentoPorcentaje?: number
  dias?: string[]
  imageUrl?: string
  aplicaOnline?: boolean
  validoDesde?: Date
  validoHasta?: Date
  fechaRelevado: Date
  fuente?: string
}

export interface PromoBancoAdapter {
  nombre: string
  fuente: FuenteDatos
  obtenerPromos(): Promise<PromoBancaria[]>
}
