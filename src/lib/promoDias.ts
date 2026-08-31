// Helpers compartidos por los adaptadores de promos-bancarias/ para extraer día(s) de la
// semana a partir de texto libre (prosa de vigencia, nombres de archivo de flyers, etc.).
// Centralizado acá porque más de un adaptador (Carrefour, Cooperativa Obrera) lo necesita
// y la lógica de qué cuenta como "aparece un día" debe ser idéntica en todos.

export const ORDEN_DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'] as const

export const NOMBRE_DIA: Record<string, string> = {
  lunes: 'Lunes',
  martes: 'Martes',
  miercoles: 'Miércoles',
  jueves: 'Jueves',
  viernes: 'Viernes',
  sabado: 'Sábado',
  domingo: 'Domingo'
}

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
}

// Busca nombres de día como keyword dentro de un texto libre. Si no aparece ninguno
// (promos válidas "todo el mes" o sin info de día), devuelve undefined en vez de asumir
// "todos los días", que sería un dato inventado.
export function extraerDias(texto: string | undefined): string[] | undefined {
  if (!texto) return undefined
  const normalizado = normalizeText(texto)
  const dias = ORDEN_DIAS.filter((dia) => normalizado.includes(dia))
  return dias.length ? dias : undefined
}
