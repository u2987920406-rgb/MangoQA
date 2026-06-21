// Tests de l'Auditeur de Flux Tier 1 (audit LLM conseil, cost-aware).
// Execution : npx tsx test-flux-deep.ts. Deterministe, ZERO vrai LLM (askLLM injecte).
import { buildGraph } from './src/flux-eye/graph.js'
import { inspectFlux } from './src/flux-eye/eye.js'
import { shouldRunDeep, auditFluxDeep, runFluxDeep } from './src/flux-eye/deep.js'
import { initFluxParser } from './src/flux-eye/parser.js'
import type { ProjectFile } from './src/types.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Pré-charge le moteur AST (tree-sitter/WASM) avant tout buildGraph.
await initFluxParser()

let passed = 0
let failed = 0
function check(name: string, cond: boolean): void {
  if (cond) passed++
  else { failed++; console.error(`  ❌ ${name}`) }
}
const F = (p: string, content: string): ProjectFile => ({ path: p, content })
const sig = (over: Record<string, unknown> = {}) =>
  ({ projectName: 'p', phase: 'build', timestamp: 't', projectDir: '/p', changedFiles: [], retryCount: 0, ...over }) as never

const healthy = [F('App.jsx', `
  const [screen, setScreen] = useState("home");
  if (screen === "home") return <Home onGo={() => setScreen("about")}/>;
  if (screen === "about") return <About onBack={() => setScreen("home")}/>;
`)]
const healthyGraph = buildGraph(healthy)
const healthyT0 = inspectFlux(healthyGraph)

// ── shouldRunDeep : declencheurs ─────────────────────────────────────────────
{
  // Defaut conservateur : petit projet propre, 1er essai → ne lance PAS.
  const d = shouldRunDeep(healthyGraph, healthyT0, sig(), { workspace: 'ws', readMetricsTail: () => [] })
  check('defaut : pas de declencheur → run=false', d.run === false)

  check('force → run', shouldRunDeep(healthyGraph, healthyT0, sig(), { force: true }).run === true)
  check('retryCount>=2 → run', shouldRunDeep(healthyGraph, healthyT0, sig({ retryCount: 2 }), { readMetricsTail: () => [] }).run === true)

  // Fantome dur Tier 0 → run.
  const phantomT0 = inspectFlux(buildGraph([F('x.jsx', `openWindow({type:"ghost"})`), F('wm.jsx', `if (win.type === "real") return <R/>;`)]))
  const dp = shouldRunDeep(buildGraph([F('x.jsx', `openWindow({type:"ghost"})`)]), phantomT0, sig(), { readMetricsTail: () => [] })
  check('fantome dur Tier 0 → run', dp.run === true && dp.reason.includes('fantome'))

  // Complexite : >= 12 surfaces.
  const many = F('wm.jsx', Array.from({ length: 12 }, (_, i) => `if (win.type === "w${i}") return <X/>;`).join('\n'))
  const bigGraph = buildGraph([many])
  const dc = shouldRunDeep(bigGraph, inspectFlux(bigGraph), sig(), { readMetricsTail: () => [] })
  check('app complexe (>=12 surfaces) → run', dc.run === true && dc.reason.includes('complexe'))

  // Escalade cerveau (resolvedBy=maitre dans les metriques recentes).
  const de = shouldRunDeep(healthyGraph, healthyT0, sig(), { workspace: 'ws', readMetricsTail: () => [{ project: 'p', resolvedBy: 'maitre' }] })
  check('escalade resolvedBy=maitre → run', de.run === true && de.reason.includes('escalade'))
  // ...mais pas pour un AUTRE projet.
  const de2 = shouldRunDeep(healthyGraph, healthyT0, sig(), { workspace: 'ws', readMetricsTail: () => [{ project: 'autre', resolvedBy: 'maitre' }] })
  check('escalade d\'un autre projet → ignoree', de2.run === false)
}

// ── auditFluxDeep : LLM mocke, parsing, conseil, fail-open ───────────────────
{
  const cannedJson = `Voici mon analyse.
{ "findings": [ { "observation": "image-creator est sur 3 surfaces", "kind": "homogeneite", "severity": "suggestion", "surfaces": ["image-creator"] }, { "observation": "chemin confus vers la preview", "kind": "coherence", "severity": "note" } ], "summary": "2 observations de flux." }`
  const obs = await auditFluxDeep(healthyGraph, healthyT0, healthy, sig(), { askLLM: async () => cannedJson })
  check('audit : ran=true', obs.ran === true)
  check('audit : blocking false (invariant)', obs.blocking === false)
  check('audit : 2 findings parses', obs.findings.length === 2)
  check('audit : kind/severity/surfaces corrects', obs.findings[0].kind === 'homogeneite' && obs.findings[0].severity === 'suggestion' && obs.findings[0].surfaces?.[0] === 'image-creator')
  check('audit : parseFirstJson robuste au texte autour', obs.summary.includes('2 observations'))

  // kind/severity invalides → normalises.
  const norm = await auditFluxDeep(healthyGraph, healthyT0, healthy, sig(), {
    askLLM: async () => `{ "findings": [ { "observation": "x", "kind": "bidon", "severity": "grave" } ], "summary": "s" }`,
  })
  check('audit : kind invalide → autre', norm.findings[0].kind === 'autre')
  check('audit : severity invalide → note', norm.findings[0].severity === 'note')

  // Reponse illisible (pas de JSON) → ran=false.
  const bad = await auditFluxDeep(healthyGraph, healthyT0, healthy, sig(), { askLLM: async () => 'desole je ne peux pas' })
  check('audit : reponse illisible → ran=false', bad.ran === false && bad.findings.length === 0 && bad.blocking === false)

  // LLM qui throw → fail-open (ran=false, pas d'exception).
  let threw = false
  let failOpen
  try {
    failOpen = await auditFluxDeep(healthyGraph, healthyT0, healthy, sig(), { askLLM: async () => { throw new Error('reseau') } })
  } catch { threw = true }
  check('audit : LLM throw → fail-open (pas d\'exception)', !threw && failOpen?.ran === false)
}

// ── runFluxDeep : ecrit flux-deep-observations.json ──────────────────────────
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxdeep-'))
  const obs = await runFluxDeep(tmp, healthyGraph, healthyT0, healthy, sig(), {
    askLLM: async () => `{ "findings": [], "summary": "Flux coherent (audit profond)." }`,
    now: () => 999,
  })
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, '.mangoqa', 'flux-deep-observations.json'), 'utf8'))
  check('runFluxDeep : ecrit le fichier (blocking false, observedAt, ran)', onDisk.blocking === false && onDisk.observedAt === 999 && onDisk.ran === true)
  check('runFluxDeep : renvoie le rapport', obs.summary.includes('coherent'))
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? '✅' : '❌'} Auditeur de Flux Tier 1 : ${passed}/${passed + failed} passed`)
if (failed > 0) process.exit(1)
