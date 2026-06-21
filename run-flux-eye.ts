// Auditeur de Flux — mode CLI ponctuel. Usage : npx tsx run-flux-eye.ts <projectDir>
// Audite n'importe quel dossier (app générée OU le cockpit MangoOS lui-même, qui
// n'émet pas de phase-complete). Déterministe, zéro LLM, écrit flux-observations.json.
import path from 'node:path'
import fs from 'node:fs'
import { runFluxEye } from './src/flux-eye/runner.js'

const arg = process.argv[2]
if (!arg) {
  console.error('Usage : npx tsx run-flux-eye.ts <projectDir>')
  process.exit(1)
}
const projDir = path.resolve(arg)
if (!fs.existsSync(projDir)) {
  console.error(`Dossier introuvable : ${projDir}`)
  process.exit(1)
}

console.log(`\n🧭 Auditeur de Flux — ${projDir}\n`)
const obs = runFluxEye(projDir, {})

console.log(obs.summary)
if (obs.measured.phantomTargets.length > 0) {
  console.log('\n  Cibles fantômes (surface sans handler) :')
  for (const p of obs.measured.phantomTargets) {
    console.log(`    🔴 [${p.kind}] "${p.target}" ciblé depuis ${p.from} — aucun rendu`)
  }
}
if (obs.convergence.length > 0) {
  console.log('\n  Questions de convergence (souple, Raf tranche) :')
  for (const q of obs.convergence) console.log(`    ❓ ${q}`)
}
if (obs.suspects.unreachable.length > 0) {
  console.log('\n  Détail des suspects d\'inatteignabilité :')
  for (const u of obs.suspects.unreachable) {
    console.log(`    🟠 [${u.kind}] "${u.id}"`)
  }
}
console.log(`\n  → ${path.join(projDir, '.mangoqa', 'flux-observations.json')}\n`)
