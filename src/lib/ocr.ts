import './polyfillFile'
import { createWorker, type Worker } from 'tesseract.js'

// OCR sobre flyers de promos bancarias (Cooperativa Obrera): a diferencia de Carrefour, esa
// fuente no publica el % ni las condiciones como texto real, sólo como imagen. Se usa acá
// (en tiempo de scrape, nunca en el render de la página) para no depender de que el usuario
// abra la imagen. Un solo worker se reutiliza entre imágenes de la misma corrida —
// crear/terminar un worker por imagen cuesta ~3-5s cada vez.

let workerPromise: Promise<Worker> | null = null

function getWorker(): Promise<Worker> {
  if (!workerPromise) workerPromise = createWorker('spa')
  return workerPromise
}

// Descarta una línea si es mayormente ruido: el OCR sobre logos/decoración de los flyers
// (no texto real) suele devolver fragmentos cortos con muy pocas letras reales —
// "== — !", "N j y", "6", "€" — que antes sobrevivían al filtro (tenían más de 2
// caracteres) y quedaban mezclados con la descripción de la promo. Si menos de la mitad de
// los caracteres de la línea son letras, se descarta.
function esRuido(linea: string): boolean {
  if (linea.length <= 2) return true
  const letras = (linea.match(/\p{L}/gu) || []).length
  if (letras / linea.length < 0.5) return true

  // El chequeo de arriba no agarra fragmentos tipo "N j y" (letras sueltas separadas por
  // espacios, típico de OCR sobre logos): son "todo letras" pero ninguna es una palabra real.
  // Exigir que al menos la mitad de las palabras tengan 3+ letras filtra esos casos sin
  // afectar oraciones reales (que sí tienen palabras cortas como "y"/"de", pero no todas).
  const palabras = linea.split(/\s+/).filter(Boolean)
  const palabrasReales = palabras.filter((p) => (p.match(/\p{L}/gu) || []).length >= 3).length
  return palabrasReales / palabras.length < 0.5
}

// Colapsa líneas vacías repetidas y descarta líneas de ruido (ver esRuido) sin tocar el
// resto del texto.
function limpiarTexto(raw: string): string {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, arr) => !esRuido(l) || (l === '' && arr[i - 1] !== ''))
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

export async function ocrImageText(url: string): Promise<string> {
  const worker = await getWorker()
  const { data } = await worker.recognize(url)
  return limpiarTexto(data.text)
}

export async function cerrarOcr(): Promise<void> {
  if (!workerPromise) return
  const worker = await workerPromise
  await worker.terminate()
  workerPromise = null
}
