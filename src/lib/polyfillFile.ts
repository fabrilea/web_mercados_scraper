// tesseract.js carga undici (para fetch), que en algunos runtimes de Node referencia el
// global `File` apenas se importa (no recién al usarlo) — en Node 24 (el que usa el runner de
// GitHub Actions, aunque el workflow pida Node 18) eso revienta con
// "ReferenceError: File is not defined" antes de que el adaptador llegue a ejecutar nada.
// `node:buffer` expone `File` desde Node 20+; se asigna al global si todavía no está.
if (typeof (globalThis as any).File === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  (globalThis as any).File = require('node:buffer').File
}

export {}
