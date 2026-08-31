import { normalizeText } from './normalize.ts'

// Helper compartido por adaptadores que traen una jerarquía real de categorías por
// producto (los sitios VTEX Carrefour/DIA en `categories`, o Cooperativa Obrera en
// categoria_inicial_desc/categoria_secundaria_desc/categoria_terciaria_desc). Consultar
// esa jerarquía real (en vez de asumir que todo lo que viene de la categoría de query
// "bebidas" es "Bebidas sin Alcohol") es lo que permite separar cerveza/vino/etc. de
// gaseosas/aguas/jugos, y separar Lácteos/Carnicería/Frutas y Verduras dentro de un
// bucket genérico como "Frescos"/"Productos Frescos".
//
// Reglas ordenadas: la primera cuyo keyword aparezca en los segmentos (normalizados, sin
// acentos) gana. El alcohol va primero porque palabras como "bebidas" no deben pisar una
// coincidencia más específica de más abajo en el árbol.
// Palabras que, en el nombre de un producto, indican sin ambigüedad que es una bebida
// alcohólica. Se comparten entre categoriaDesdeSegmentos (clasificación de productos
// nuevos, contra la jerarquía del sitio) y pareceBebidaConAlcohol (corrección de
// productos viejos, contra el nombre) para no mantener dos listas separadas.
const PALABRAS_ALCOHOL = [
  'con alcohol',
  'cerveza',
  'bodega',
  'vino',
  'aperitivo',
  'licor',
  'bebidas blancas',
  'espumante',
  'champagne',
  'sidra',
  'fernet',
  'whisky',
  'vodka'
]

// Versiones "0.0%" de cerveza/aperitivo/vino/sidra existen y se venden con ese nombre
// (ej. "Cerveza sin alcohol Heineken 0.0%", "Vino tinto sin alcohol San Humberto"): el
// nombre contiene la palabra de alcohol ("cerveza", "vino") pero el producto es
// justamente lo contrario. Si el texto aclara explícitamente que no tiene alcohol, esa
// aclaración gana por sobre cualquier keyword de PALABRAS_ALCOHOL.
// Coincide contra texto ya normalizado (normalizeText saca tildes/puntuación/mayúsculas),
// así que "0.0%" ya llegó como "0 0" y "alcohol-free" como "alcohol free".
const PATRON_SIN_ALCOHOL = /sin alcohol|alcohol free|cero alcohol/

function esRealmenteAlcohol(texto: string): boolean {
  if (PATRON_SIN_ALCOHOL.test(texto)) return false
  return PALABRAS_ALCOHOL.some((keyword) => texto.includes(keyword))
}

const REGLAS_SUBCATEGORIA: [string, string][] = [
  ['gaseosa', 'Bebidas sin Alcohol'],
  ['agua', 'Bebidas sin Alcohol'],
  ['jugo', 'Bebidas sin Alcohol'],
  ['isotonic', 'Bebidas sin Alcohol'],
  ['lacteo', 'Lácteos'],
  ['leche', 'Lácteos'],
  ['carniceria', 'Carnicería'],
  ['frutas y verduras', 'Frutas y Verduras'],
  ['hortalizas', 'Frutas y Verduras'],
  ['fiambr', 'Fiambrería'],
  ['pastas frescas', 'Pastas Frescas'],
  ['listos para disfrutar', 'Comidas Listas']
]

export function categoriaDesdeSegmentos(segmentos: (string | null | undefined)[] | undefined, fallback: string): string {
  if (!segmentos || !segmentos.length) return fallback
  const texto = normalizeText(segmentos.filter(Boolean).join(' '))
  if (esRealmenteAlcohol(texto)) return 'Bebidas con Alcohol'
  for (const [keyword, categoria] of REGLAS_SUBCATEGORIA) {
    if (texto.includes(keyword)) return categoria
  }
  return fallback
}

// Para corregir productos viejos ya clasificados "Bebidas sin Alcohol" antes de que
// categoriaDesdeSegmentos existiera: a diferencia de esa función (que compara contra la
// jerarquía real del sitio), acá sólo tenemos el nombre del producto, así que el chequeo
// se limita a las palabras de alcohol (inequívocas) y no a las de "Bebidas sin Alcohol"
// (agua/jugo/gaseosa son demasiado genéricas como substring de nombres arbitrarios).
export function pareceBebidaConAlcohol(nombre: string): boolean {
  return esRealmenteAlcohol(normalizeText(nombre))
}
