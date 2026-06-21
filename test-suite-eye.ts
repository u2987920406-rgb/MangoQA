// Tests de l'Auditeur de Suite (cross-app, #138). Exécution : npx tsx test-suite-eye.ts
// Déterministe, zéro réseau, zéro LLM. Logique pure (auditSuite) + runner I/O injectée.
import { auditSuite, slugCollection, type SuiteApp } from './src/suite-eye/audit.js'
import { analyzeSuite, loadSuiteApp, type SuiteEyeDeps } from './src/suite-eye/runner.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let passed = 0
let failed = 0
function check(name: string, cond: boolean): void {
  if (cond) passed++
  else { failed++; console.error(`  ❌ ${name}`) }
}
const app = (id: string, name: string, collections: SuiteApp['collections']): SuiteApp => ({ id, name, collections })

// ── slugCollection ───────────────────────────────────────────────────────────
{
  check('slug : minuscule + accents', slugCollection('Tâches Récentes') === 'taches-recentes')
  check('slug : ponctuation → tirets bornés', slugCollection('  My Tasks!! ') === 'my-tasks')
}

// ── Suite cohérente : un écrivain, un lecteur, schémas compatibles → 0 mesuré ──
{
  const obs = auditSuite([
    app('taches', 'Mango Tâches', [{ name: 'tasks', access: 'readwrite', schema: { title: 'string', done: 'boolean' } }]),
    app('tableau', 'Mango Tableau', [{ name: 'tasks', access: 'read', schema: { title: 'string', done: 'boolean' } }]),
  ])
  check('cohérent : zéro conflit de schéma', obs.measured.schemaConflicts.length === 0)
  check('cohérent : zéro convergence', obs.convergence.length === 0)
  check('cohérent : 2 apps, 1 collection', obs.counts.apps === 2 && obs.counts.collections === 1)
  check('cohérent : invariant blocking false', obs.blocking === false)
  check('cohérent : summary « cohérent »', /cohérent/.test(obs.summary))
}

// ── MESURÉ : conflit de schéma (types incompatibles entre apps) ───────────────
{
  const obs = auditSuite([
    app('a', 'App A', [{ name: 'tasks', access: 'write', schema: { priority: 'number' } }]),
    app('b', 'App B', [{ name: 'tasks', access: 'read', schema: { priority: 'string' } }]),
  ])
  check('conflit : 1 mesuré', obs.measured.schemaConflicts.length === 1)
  const c = obs.measured.schemaConflicts[0]
  check('conflit : bonne collection/champ', c?.collection === 'tasks' && c?.field === 'priority')
  check('conflit : les deux types listés', c?.declarations.some(d => d.type === 'number') && c?.declarations.some(d => d.type === 'string'))
  check('conflit : summary signale le dur', /conflit/.test(obs.summary))
  check('conflit : toujours non bloquant', obs.blocking === false)
}

// L'optionnel (« number? ») ne crée PAS de conflit de type avec « number ».
{
  const obs = auditSuite([
    app('a', 'A', [{ name: 'c', access: 'write', schema: { p: 'number' } }]),
    app('b', 'B', [{ name: 'c', access: 'read', schema: { p: 'number?' } }]),
  ])
  check('optionnel : « number? » vs « number » → pas un conflit de type', obs.measured.schemaConflicts.length === 0)
}

// ── CONVERGENCE : lue sans écrivain (souple, pas mesuré) ──────────────────────
{
  const obs = auditSuite([
    app('a', 'Lecteur', [{ name: 'stats', access: 'read' }]),
    app('b', 'Autre', [{ name: 'tasks', access: 'readwrite' }]),
  ])
  check('lue-sans-écrivain → convergence', obs.convergence.some(q => /lue.*sans aucun écrivain/.test(q) && /stats/.test(q)))
  check('lue-sans-écrivain : pas un fait dur', obs.measured.schemaConflicts.length === 0)
}

// ── CONVERGENCE : écrite sans lecteur ─────────────────────────────────────────
{
  const obs = auditSuite([
    app('a', 'Producteur', [{ name: 'logs', access: 'write' }]),
    app('b', 'Autre', [{ name: 'tasks', access: 'readwrite' }]),
  ])
  check('écrite-sans-lecteur → convergence', obs.convergence.some(q => /personne ne lit/.test(q) && /logs/.test(q)))
}

// ── CONVERGENCE : app en silo (ne partage avec personne) ──────────────────────
{
  const obs = auditSuite([
    app('shared1', 'Partage A', [{ name: 'tasks', access: 'write' }]),
    app('shared2', 'Partage B', [{ name: 'tasks', access: 'read' }]),
    app('silo', 'Solo', [{ name: 'private', access: 'readwrite' }]),
  ])
  check('silo détecté', obs.convergence.some(q => /silo/.test(q) && /Solo/.test(q)))
  check('silo : les apps qui partagent tasks ne sont PAS en silo', obs.convergence.every(q => !/Partage A/.test(q) && !/Partage B/.test(q)))
}

// App sans aucune collection → silo aussi.
{
  const obs = auditSuite([
    app('a', 'Connecte A', [{ name: 'x', access: 'write' }]),
    app('b', 'Connecte B', [{ name: 'x', access: 'read' }]),
    app('vide', 'Vide', []),
  ])
  check('app sans collection → silo', obs.convergence.some(q => /silo/.test(q) && /Vide/.test(q)))
}

// ── Cas vide : aucune app → rien à auditer, jamais d'erreur ───────────────────
{
  const obs = auditSuite([])
  check('vide : 0 app, 0 mesuré, 0 convergence', obs.counts.apps === 0 && obs.counts.measured === 0 && obs.convergence.length === 0)
  check('vide : summary « rien à auditer »', /rien à auditer/.test(obs.summary))
  check('vide : non bloquant', obs.blocking === false)
}

// ── Runner I/O : lecture défensive + écriture + fail-open ─────────────────────
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-eye-'))
  const mk = (dir: string, manifest: unknown) => {
    const d = path.join(ws, dir)
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, '.mangoapp.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
  }
  mk('app-a', { id: 'a', name: 'A', collections: [{ name: 'tasks', access: 'write', schema: { t: 'string' } }] })
  mk('app-b', { id: 'b', name: 'B', collections: [{ name: 'tasks', access: 'read', schema: { t: 'number' } }] })
  mk('app-corrompu', '{ not json')
  mk('pas-une-app', { foo: 1 })

  check('loadSuiteApp : manifest valide', loadSuiteApp(path.join(ws, 'app-a'))?.name === 'A')
  check('loadSuiteApp : JSON corrompu → null', loadSuiteApp(path.join(ws, 'app-corrompu')) === null)
  check('loadSuiteApp : sans id/name → null', loadSuiteApp(path.join(ws, 'pas-une-app')) === null)

  const { obs, apps } = analyzeSuite(ws, {})
  check('runner : charge les 2 apps valides (ignore corrompu/invalide)', apps.length === 2)
  check('runner : détecte le conflit tasks.t (string vs number)', obs.measured.schemaConflicts.some(c => c.collection === 'tasks' && c.field === 't'))
  const onDisk = JSON.parse(fs.readFileSync(path.join(ws, '.mangoqa', 'suite-observations.json'), 'utf8'))
  check('runner : observations écrites (observedAt + blocking false)', onDisk.blocking === false && typeof onDisk.observedAt === 'number')

  // Fail-open : une écriture qui throw ne casse pas l'analyse.
  let threw = false
  const deps: SuiteEyeDeps = { writeFile: () => { throw new Error('disque plein') } }
  try { analyzeSuite(ws, deps) } catch { threw = true }
  check('runner : fail-open (écriture qui throw n\'arrête rien)', !threw)

  fs.rmSync(ws, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? '✅' : '❌'} Auditeur de Suite : ${passed}/${passed + failed} passed`)
if (failed > 0) process.exit(1)
