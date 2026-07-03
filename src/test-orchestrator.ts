// Tests de l'orchestrateur (#Q2). Exécution : npx tsx src/test-orchestrator.ts
// Déterministe, zéro réseau, zéro LLM, zéro disque (fs + runners injectés).
import path from 'node:path'
import type { Branch, PhaseSignal, ProjectFile } from './types.js'
import {
  createOrchestrator,
  readProjectFiles,
  walkSrc,
  type FsLike,
  type OrchestratorRunners,
} from './orchestrator.js'
import type { DesignObservation } from './design-eye/eye.js'
import type { FluxObservation } from './flux-eye/eye.js'
import type { NavGraph } from './flux-eye/graph.js'
import type { FluxDeepObservation } from './flux-eye/deep.js'
import type { SuiteObservation } from './suite-eye/audit.js'

let passed = 0
let failed = 0
function check(name: string, cond: boolean): void {
  if (cond) {
    passed++
  } else {
    failed++
    console.error(`  ❌ ${name}`)
  }
}

// ── Fakes ────────────────────────────────────────────────────────────────────
const norm = (p: string): string => p.replace(/\\/g, '/')

/** fs en mémoire : un Map de fichiers + un Set de dossiers. */
function makeFakeFs(initialFiles: Record<string, string>, dirs: string[] = []): { fsx: FsLike; writes: Map<string, string> } {
  const files = new Map(Object.entries(initialFiles).map(([k, v]) => [norm(k), v]))
  const dirSet = new Set(dirs.map(norm))
  const writes = new Map<string, string>()
  const fsx: FsLike = {
    existsSync: p => files.has(norm(p)) || dirSet.has(norm(p)),
    readFileSync: p => {
      const v = files.get(norm(p))
      if (v === undefined) throw new Error(`ENOENT: ${p}`)
      return v
    },
    writeFileSync: (p, data) => {
      files.set(norm(p), data)
      writes.set(norm(p), data)
    },
    mkdirSync: p => {
      dirSet.add(norm(p))
    },
    readdirSync: () => [],
    isFile: p => files.has(norm(p)),
  }
  return { fsx, writes }
}

const fluxObs: FluxObservation = {
  blocking: false,
  measured: { phantomTargets: [] },
  suspects: { unreachable: [] },
  convergence: [],
  summary: 'flux ok',
  counts: { measured: 0, convergence: 0 },
}
const designObs = {
  blocking: false,
  measured: { contrast: [], offPalette: [], offSpacing: [], offRadius: [], briefDrift: [] },
  convergence: [],
  summary: 'design ok',
  counts: { measured: 0, convergence: 0 },
} as DesignObservation
const suiteObs = {
  blocking: false,
  measured: { schemaConflicts: [] },
  convergence: [],
  summary: 'suite ok',
  counts: { apps: 0, collections: 0, measured: 0, convergence: 0 },
} as SuiteObservation
const deepObs: FluxDeepObservation = {
  blocking: false,
  ran: true,
  reason: 'test',
  model: 'fake',
  findings: [],
  summary: 'tier1 ok',
}

/** Runners espions : chaque visage note son passage dans `order`. */
function makeRunners(order: string[], opts: { deep?: boolean } = {}): OrchestratorRunners {
  return {
    loadRetexConstraints: () => {
      order.push('retex')
      return ''
    },
    recordRejection: () => {
      order.push('rejection')
    },
    readLatestBrief: () => undefined,
    runDesignEye: () => {
      order.push('design')
      return designObs
    },
    initFluxParser: async () => {
      order.push('flux-init')
    },
    analyzeFlux: () => {
      order.push('flux')
      return { obs: fluxObs, graph: {} as NavGraph, files: [] }
    },
    shouldRunDeep: () => ({ run: opts.deep ?? false, reason: 'test' }),
    runFluxDeep: async () => {
      order.push('flux-deep')
      return deepObs
    },
    analyzeSuite: () => {
      order.push('suite')
      return { obs: suiteObs }
    },
  }
}

function makeBranch(id: string, onAudit?: () => Promise<void>): { branch: Branch; audits: PhaseSignal[] } {
  const audits: PhaseSignal[] = []
  const branch: Branch = {
    id,
    label: id,
    emoji: '🧪',
    blocking: true,
    relevant: (files: ProjectFile[]) => files,
    audit: async ctx => {
      audits.push(ctx.signal)
      if (onAudit) await onAudit()
      return { status: 'pass', summary: 'ok' }
    },
  }
  return { branch, audits }
}

const WS = '/ws'
const PROJ = '/ws/proj'
const SIGNAL_FILE = '/ws/proj/.mangoqa/phase-complete.json'

function signalJson(timestamp: string): string {
  const s: PhaseSignal = {
    projectName: 'proj',
    phase: 'build',
    timestamp,
    projectDir: PROJ,
    changedFiles: ['a.ts'],
    retryCount: 0,
  }
  return JSON.stringify(s)
}

function makeWorld(timestamp: string, opts: { suiteEye?: boolean; deep?: boolean; onAudit?: () => Promise<void> } = {}) {
  const { fsx, writes } = makeFakeFs(
    {
      [SIGNAL_FILE]: signalJson(timestamp),
      [`${PROJ}/a.ts`]: 'export const a = 1',
    },
    [PROJ],
  )
  const order: string[] = []
  const { branch, audits } = makeBranch('archi', opts.onAudit)
  const logs: string[] = []
  const orch = createOrchestrator({
    workspace: WS,
    branches: [branch],
    suiteEye: opts.suiteEye,
    fs: fsx,
    now: () => 42,
    log: l => logs.push(l),
    runners: makeRunners(order, { deep: opts.deep }),
  })
  return { orch, fsx, writes, order, audits, logs }
}

// ── Dédup : même phase (même timestamp) traitée 2× → 1 seul run ──────────────
await (async () => {
  const w = makeWorld('t1')
  await w.orch.handleSignal(SIGNAL_FILE)
  await w.orch.handleSignal(SIGNAL_FILE) // add + change de la même écriture
  check('dédup : même timestamp → 1 seul audit', w.audits.length === 1)
  check('dédup : verdict écrit une fois', w.writes.has(norm(path.join(PROJ, '.mangoqa', 'audit-verdict.json'))))
})()

// ── Verrou inFlight : 2 signaux CONCURRENTS → pas de chevauchement, puis série ─
await (async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>(r => {
    release = r
  })
  const w = makeWorld('t1', { onAudit: () => gate })
  const p1 = w.orch.handleSignal(SIGNAL_FILE) // entre et se bloque dans branch.audit
  // 2ᵉ signal pendant que le 1ᵉʳ est en vol (timestamp différent → passe la dédup).
  w.fsx.writeFileSync(SIGNAL_FILE, signalJson('t2'))
  const p2 = w.orch.handleSignal(SIGNAL_FILE)
  await p2 // doit revenir IMMÉDIATEMENT (verrou) sans lancer d'audit
  check('verrou : signal concurrent non chevauché', w.audits.length === 1)
  release()
  await p1
  // Le verrou levé, le signal suivant passe → traitement EN SÉRIE.
  w.fsx.writeFileSync(SIGNAL_FILE, signalJson('t3'))
  await w.orch.handleSignal(SIGNAL_FILE)
  check('verrou : après libération, le signal suivant tourne (série)', w.audits.length === 2)
})()

// ── Ordre des visages : retex → branches → verdict → œil → flux → (fin) ──────
await (async () => {
  const w = makeWorld('t1')
  await w.orch.handleSignal(SIGNAL_FILE)
  check(
    'ordre des visages : retex → design → flux-init → flux',
    JSON.stringify(w.order) === JSON.stringify(['retex', 'design', 'flux-init', 'flux']),
  )
  check('tier 1 non déclenché par défaut', !w.order.includes('flux-deep'))
})()

// ── Tier 1 gaté : shouldRunDeep run:true → runFluxDeep appelé ────────────────
await (async () => {
  const w = makeWorld('t1', { deep: true })
  await w.orch.handleSignal(SIGNAL_FILE)
  check('tier 1 : déclencheur armé → flux-deep appelé', w.order.includes('flux-deep'))
})()

// ── Auditeur de Suite : gaté par suiteEye (défaut OFF) ───────────────────────
await (async () => {
  const off = makeWorld('t1')
  await off.orch.handleSignal(SIGNAL_FILE)
  check('suite-eye : défaut off → jamais appelé', !off.order.includes('suite'))

  const on = makeWorld('t1', { suiteEye: true })
  await on.orch.handleSignal(SIGNAL_FILE)
  check('suite-eye : SUITE_EYE=on → appelé', on.order.includes('suite'))
  check(
    'suite-eye : appelé APRÈS les autres visages',
    on.order.indexOf('suite') > on.order.indexOf('flux') && on.order.indexOf('suite') > on.order.indexOf('design'),
  )
})()

// ── Signal illisible / projet absent → aucun run, aucun crash ────────────────
await (async () => {
  const w = makeWorld('t1')
  w.fsx.writeFileSync(SIGNAL_FILE, '{pas du json')
  await w.orch.handleSignal(SIGNAL_FILE)
  check('signal corrompu → ignoré sans crash', w.audits.length === 0)

  const w2 = makeWorld('t1')
  w2.fsx.writeFileSync(SIGNAL_FILE, JSON.stringify({ ...JSON.parse(signalJson('t9')), projectDir: '/nulle-part' }))
  await w2.orch.handleSignal(SIGNAL_FILE)
  check('projectDir inexistant → ignoré', w2.audits.length === 0)
})()

// ── readProjectFiles : filtre SKIP_DIRS + troncature ─────────────────────────
{
  const { fsx } = makeFakeFs(
    {
      [`${PROJ}/a.ts`]: 'aaa',
      [`${PROJ}/node_modules/x.ts`]: 'nope',
      [`${PROJ}/big.ts`]: 'b'.repeat(17_000),
    },
    [PROJ],
  )
  const got = readProjectFiles(PROJ, ['a.ts', 'node_modules/x.ts', 'big.ts', 'missing.ts'], fsx)
  check('readProjectFiles : node_modules filtré', !got.some(f => f.path.includes('node_modules')))
  check('readProjectFiles : fichier manquant ignoré', got.length === 2)
  check(
    'readProjectFiles : gros fichier tronqué',
    got.find(f => f.path === 'big.ts')!.content.includes('…(tronqué)…'),
  )
}

// ── walkSrc : parcourt, saute les dossiers cachés/skip, borne MAX_FILES ──────
{
  const listing: Record<string, { name: string; dir: boolean }[]> = {
    '/p': [
      { name: 'a.ts', dir: false },
      { name: 'node_modules', dir: true },
      { name: '.git', dir: true },
      { name: 'sub', dir: true },
      { name: 'img.png', dir: false },
    ],
    '/p/sub': [{ name: 'b.tsx', dir: false }],
  }
  const fsx: FsLike = {
    existsSync: () => true,
    readFileSync: () => '',
    writeFileSync: () => {},
    mkdirSync: () => {},
    readdirSync: p => (listing[norm(p)] ?? []).map(e => ({ name: e.name, isDirectory: () => e.dir })),
    isFile: () => true,
  }
  const acc: string[] = []
  walkSrc('/p', '/p', acc, fsx)
  const rel = acc.map(norm)
  check('walkSrc : fichiers source trouvés (récursif)', rel.includes('a.ts') && rel.includes('sub/b.tsx'))
  check('walkSrc : extensions hors code ignorées', !rel.includes('img.png'))
  check('walkSrc : node_modules/.git sautés', rel.length === 2)
}

// ── Bilan ────────────────────────────────────────────────────────────────────
console.log(`\n[orchestrator] ${passed} ✅  ${failed ? failed + ' ❌' : '0 ❌'}  (${passed + failed} assertions)`)
if (failed > 0) process.exit(1)
