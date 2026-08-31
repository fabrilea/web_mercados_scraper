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

// Colapsa líneas vacías repetidas y descarta líneas de 1-2 caracteres (ruido típico de OCR
// sobre logos/decoración: "ll", "»", "9") sin tocar el resto del texto.
function limpiarTexto(raw: string): string {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, arr) => l.length > 2 || (l === '' && arr[i - 1] !== ''))
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
