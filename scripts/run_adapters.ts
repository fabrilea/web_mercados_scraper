// Orquestador que ejecuta todos los adaptadores en `adapters/` y persiste resultados en la DB.
// La persistencia real ocurre en el proceso hijo (save_adapter_results.ts), que usa el matching
// compartido de src/lib/normalize.ts.
// Uso: npx ts-node scripts/run_adapters.ts (toma DATABASE_URL de .env, ver DEPLOY.md)

// require en vez de import: ts-node en este proyecto no resuelve bien sintaxis ESM (`import`,
// `import.meta.url`) en scripts sueltos — ver save_adapter_results.ts, que usa el mismo
// patrón. __dirname/__filename ya están disponibles nativamente en CJS, sin necesitar
// fileURLToPath(import.meta.url).
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('dotenv').config({ override: true })
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path')

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('Falta DATABASE_URL (ver .env / DEPLOY.md)')
  }
  console.log('Running adapters and persisting to DB')

  const adaptersDir = path.join(__dirname, '..', 'adapters')
  const files = fs.existsSync(adaptersDir)
    ? fs.readdirSync(adaptersDir).filter((f: string) => (f.endsWith('.ts') || f.endsWith('.js')) && !f.startsWith('types'))
    : []
  if (!files.length) {
    console.log('No adapters found in', adaptersDir)
    process.exit(0)
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { spawnSync } = require('child_process')
  const fallidos: string[] = []
  for (const file of files) {
    const adapterFile = path.join('adapters', file)
    console.log(new Date().toISOString(), 'Running adapter process for', adapterFile)
    let attempts = 0
    const maxAttempts = 3
    let ok = false
    while (attempts < maxAttempts) {
      attempts++
      try {
        const res = spawnSync('npx', ['ts-node', 'scripts/save_adapter_results.ts', adapterFile], { stdio: 'inherit', shell: true })
        if (res.error) {
          console.error(new Date().toISOString(), 'Spawn error', res.error)
        }
        if (res && res.status === 0) {
          ok = true
          break
        }
        console.error(new Date().toISOString(), `Adapter process exited with ${res?.status}. attempt ${attempts}/${maxAttempts}`)
        if (attempts < maxAttempts) {
          const wait = 500 * Math.pow(2, attempts - 1)
          console.log(new Date().toISOString(), `Retrying in ${wait}ms`)
          await sleep(wait)
        }
      } catch (e) {
        console.error(new Date().toISOString(), 'Adapter error', file, e)
      }
    }
    if (!ok) fallidos.push(file)
  }

  // Fallar el proceso (y con eso el job de CI) si algún adaptador no pudo persistir nada
  // después de agotar los reintentos — antes esto quedaba en silencio y el workflow de
  // GitHub Actions mostraba éxito aunque ningún adaptador hubiera corrido.
  if (fallidos.length) {
    throw new Error(`${fallidos.length}/${files.length} adaptadores fallaron: ${fallidos.join(', ')}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
