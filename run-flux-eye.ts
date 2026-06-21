// Auditeur de Flux — mode CLI ponctuel. Usage : npx tsx run-flux-eye.ts <projectDir> [--deep]
// Audite n'importe quel dossier (app generee OU le cockpit MangoOS lui-meme, qui
// n'emet pas de phase-complete). Tier 0 deterministe ($0). Avec --deep : lance AUSSI
// l'audit LLM Tier 1 (vrai appel Claude abonnement). Ecrit flux-observations.json
// (+ flux-deep-observations.json avec --deep).
import path from 'node:path'
import fs from 'node:fs'
import { analyzeFlux } from './src/flux-eye/runner.js'
import { runFluxDeep } from './src/flux-eye/deep.js'
import { initFluxParser } from './src/flux-eye/parser.js'

const args = process.argv.slice(2)
const deep = args.includes('--deep')
const arg = args.find(a => !a.startsWith('--'))
if (!arg) {
  console.error('Usage : npx tsx run-flux-eye.ts <projectDir> [--deep]')
  process.exit(1)
}
const projDir = path.resolve(arg)
if (!fs.existsSync(projDir)) {
  console.error(`Dossier introuvable : ${projDir}`)
  process.exit(1)
}

console.log(`\n🧭 Auditeur de Flux — ${projDir}\n`)
await initFluxParser() // pré-charge le moteur AST (tree-sitter/WASM) — buildGraph reste sync
const { obs, graph, files } = analyzeFlux(projDir, {})

console.log(obs.summary)
if (obs.measured.phantomTargets.length > 0) {
  console.log('\n  Cibles fantomes (surface sans handler) :')
  for (const p of obs.measured.phantomTargets) {
    console.log(`    🔴 [${p.kind}] "${p.target}" cible depuis ${p.from} — aucun rendu`)
  }
}
if (obs.convergence.length > 0) {
  console.log('\n  Questions de convergence (souple, Raf tranche) :')
  for (const q of obs.convergence) console.log(`    ❓ ${q}`)
}
if (obs.suspects.unreachable.length > 0) {
  console.log('\n  Detail des suspects d\'inatteignabilite :')
  for (const u of obs.suspects.unreachable) console.log(`    🟠 [${u.kind}] "${u.id}"`)
}

if (deep) {
  console.log('\n🧭+ Tier 1 — audit LLM (conseil, Claude abonnement)…\n')
  const signal = {
    projectName: path.basename(projDir),
    phase: 'cli',
    timestamp: new Date().toISOString(),
    projectDir: projDir,
    changedFiles: [],
    retryCount: 0,
  }
  const d = await runFluxDeep(projDir, graph, obs, files, signal, {})
  console.log(d.summary)
  for (const f of d.findings) {
    const icon = f.severity === 'suggestion' ? '💡' : '•'
    const surf = f.surfaces?.length ? ` [${f.surfaces.join(', ')}]` : ''
    console.log(`    ${icon} (${f.kind}) ${f.observation}${surf}`)
  }
  console.log(`\n  → ${path.join(projDir, '.mangoqa', 'flux-deep-observations.json')}`)
}
console.log(`\n  → ${path.join(projDir, '.mangoqa', 'flux-observations.json')}\n`)
