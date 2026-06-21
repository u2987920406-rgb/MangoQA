// Auditeur de Suite (cross-app) — mode CLI ponctuel.
// Usage : npx tsx run-suite-eye.ts <workspaceDir>
// Audite la cohérence du graphe de données entre toutes les apps composables d'un
// workspace (manifests `.mangoapp.json`). Déterministe, zéro LLM ($0). Écrit
// <workspace>/.mangoqa/suite-observations.json.
import path from 'node:path'
import fs from 'node:fs'
import { analyzeSuite } from './src/suite-eye/runner.js'

const arg = process.argv.slice(2).find((a) => !a.startsWith('--'))
if (!arg) {
  console.error('Usage : npx tsx run-suite-eye.ts <workspaceDir>')
  process.exit(1)
}
const workspace = path.resolve(arg)
if (!fs.existsSync(workspace)) {
  console.error(`Dossier introuvable : ${workspace}`)
  process.exit(1)
}

console.log(`\n🧩 Auditeur de Suite — ${workspace}\n`)
const { obs, apps } = analyzeSuite(workspace, {})

console.log(obs.summary)
if (apps.length > 0) {
  console.log('\n  Apps composables :')
  for (const a of apps) {
    const cols = a.collections.map((c) => `${c.name}(${c.access}${c.schema ? ', schéma' : ''})`).join(', ') || '—'
    console.log(`    • ${a.name} [${a.id}] : ${cols}`)
  }
}
if (obs.measured.schemaConflicts.length > 0) {
  console.log('\n  Conflits de schéma (DURS — un lecteur va mal-typer la donnée) :')
  for (const c of obs.measured.schemaConflicts) {
    const decl = c.declarations.map((d) => `${d.app}:${d.type}`).join(' vs ')
    console.log(`    🔴 ${c.collection}.${c.field} — ${decl}`)
  }
}
if (obs.convergence.length > 0) {
  console.log('\n  Questions de convergence (souple, Raf tranche) :')
  for (const q of obs.convergence) console.log(`    ❓ ${q}`)
}
console.log(`\n  → ${path.join(workspace, '.mangoqa', 'suite-observations.json')}\n`)
