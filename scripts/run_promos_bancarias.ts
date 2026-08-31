// Orquestador de promos bancarias: corre todos los adaptadores en
// adapters/promos-bancarias/ y persiste cada uno vía save_promos_bancarias.ts.
// Uso: npx ts-node scripts/run_promos_bancarias.ts

// require en vez de import: ver la nota equivalente en run_adapters.ts.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path')

async function main() {
  const dir = path.join(__dirname, '..', 'adapters', 'promos-bancarias')
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f: string) => f.endsWith('.ts') || f.endsWith('.js'))
    : []

  if (!files.length) {
    console.log('No hay adaptadores en', dir)
    return
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { spawnSync } = require('child_process')
  const fallidos: string[] = []
  for (const file of files) {
    const adapterFile = path.join('adapters', 'promos-bancarias', file)
    console.log(new Date().toISOString(), 'Corriendo', adapterFile)
    const res = spawnSync('npx', ['ts-node', 'scripts/save_promos_bancarias.ts', adapterFile], { stdio: 'inherit', shell: true })
    if (!res || res.status !== 0) {
      console.error(new Date().toISOString(), `${adapterFile} terminó con error (exit ${res?.status})`)
      fallidos.push(file)
    }
  }

  // Ver la nota equivalente en run_adapters.ts: fallar de verdad si algo no anduvo, para que
  // el workflow de CI no muestre éxito con adaptadores rotos en silencio.
  if (fallidos.length) {
    throw new Error(`${fallidos.length}/${files.length} adaptadores de promos fallaron: ${fallidos.join(', ')}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
