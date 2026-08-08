// Tests de l'orchestrateur (#Q2).
// Déterministe, zéro réseau, zéro LLM, zéro disque (fs + runners injectés).
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import type { AuditContext, Branch, PhaseSignal, ProjectFile } from '../../src/types.js'
import {
  createOrchestrator,
  readProjectFiles,
  walkSrc,
  projectHasTests,
  MAX_FILES,
  type FsLike,
  type OrchestratorRunners,
} from '../../src/orchestrator.js'
import type { DesignObservation } from '../../src/design-eye/eye.js'
import type { FluxObservation } from '../../src/flux-eye/eye.js'
import type { NavGraph } from '../../src/flux-eye/graph.js'
import type { FluxDeepObservation } from '../../src/flux-eye/deep.js'
import type { SuiteObservation } from '../../src/suite-eye/audit.js'

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
    // #10/#11 — dérivé des clés de `files`/`dirs` (immédiats enfants de `p`),
    // pour que `projectHasTests`/`walkSrc` (qui parcourent via readdirSync)
    // puissent réellement trouver quelque chose en test, pas seulement [].
    readdirSync: p => {
      const base = norm(p)
      const seen = new Map<string, boolean>() // name → isDirectory
      const consider = (full: string) => {
        if (!full.startsWith(base + '/')) return
        const rest = full.slice(base.length + 1)
        const name = rest.split('/')[0]
        const isDir = rest.includes('/')
        if (!seen.has(name) || isDir) seen.set(name, seen.get(name) || isDir)
      }
      for (const f of files.keys()) consider(f)
      for (const d of dirSet) consider(d)
      return [...seen.entries()].map(([name, isDir]) => ({ name, isDirectory: () => isDir }))
    },
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

function makeBranch(
  id: string,
  onAudit?: () => Promise<void>,
): { branch: Branch; audits: PhaseSignal[]; contexts: AuditContext[] } {
  const audits: PhaseSignal[] = []
  const contexts: AuditContext[] = []
  const branch: Branch = {
    id,
    label: id,
    emoji: '🧪',
    blocking: true,
    relevant: (files: ProjectFile[]) => files,
    audit: async ctx => {
      audits.push(ctx.signal)
      contexts.push(ctx)
      if (onAudit) await onAudit()
      return { status: 'pass', summary: 'ok' }
    },
  }
  return { branch, audits, contexts }
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

function makeWorld(
  timestamp: string,
  opts: { suiteEye?: boolean; deep?: boolean; onAudit?: () => Promise<void>; withTestFile?: boolean } = {},
) {
  const extraFiles: Record<string, string> = opts.withTestFile ? { [`${PROJ}/src/foo.test.ts`]: 'test()' } : {}
  const { fsx, writes } = makeFakeFs(
    {
      [SIGNAL_FILE]: signalJson(timestamp),
      [`${PROJ}/a.ts`]: 'export const a = 1',
      ...extraFiles,
    },
    [PROJ],
  )
  const order: string[] = []
  const { branch, audits, contexts } = makeBranch('archi', opts.onAudit)
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
  return { orch, fsx, writes, order, audits, contexts, logs }
}

describe('orchestrator', () => {
  it('dédup : même timestamp → 1 seul audit, verdict écrit une fois', async () => {
    const w = makeWorld('t1')
    await w.orch.handleSignal(SIGNAL_FILE)
    await w.orch.handleSignal(SIGNAL_FILE) // add + change de la même écriture
    expect(w.audits.length).toBe(1)
    expect(w.writes.has(norm(path.join(PROJ, '.mangoqa', 'audit-verdict.json')))).toBe(true)
  })

  it('verrou inFlight : 2 signaux CONCURRENTS → pas de chevauchement, puis série', async () => {
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
    expect(w.audits.length).toBe(1)
    release()
    await p1
    // Le verrou levé, le signal suivant passe → traitement EN SÉRIE.
    w.fsx.writeFileSync(SIGNAL_FILE, signalJson('t3'))
    await w.orch.handleSignal(SIGNAL_FILE)
    expect(w.audits.length).toBe(2)
  })

  it('ordre des visages : retex → branches → verdict → œil → flux → (fin)', async () => {
    const w = makeWorld('t1')
    await w.orch.handleSignal(SIGNAL_FILE)
    expect(JSON.stringify(w.order)).toBe(JSON.stringify(['retex', 'design', 'flux-init', 'flux']))
    expect(w.order.includes('flux-deep')).toBe(false)
  })

  it('tier 1 gaté : shouldRunDeep run:true → runFluxDeep appelé', async () => {
    const w = makeWorld('t1', { deep: true })
    await w.orch.handleSignal(SIGNAL_FILE)
    expect(w.order.includes('flux-deep')).toBe(true)
  })

  it('auditeur de Suite : gaté par suiteEye (défaut OFF)', async () => {
    const off = makeWorld('t1')
    await off.orch.handleSignal(SIGNAL_FILE)
    expect(off.order.includes('suite')).toBe(false)

    const on = makeWorld('t1', { suiteEye: true })
    await on.orch.handleSignal(SIGNAL_FILE)
    expect(on.order.includes('suite')).toBe(true)
    expect(
      on.order.indexOf('suite') > on.order.indexOf('flux') && on.order.indexOf('suite') > on.order.indexOf('design'),
    ).toBe(true)
  })

  it('signal illisible / projet absent → aucun run, aucun crash', async () => {
    const w = makeWorld('t1')
    w.fsx.writeFileSync(SIGNAL_FILE, '{pas du json')
    await w.orch.handleSignal(SIGNAL_FILE)
    expect(w.audits.length).toBe(0)

    const w2 = makeWorld('t1')
    w2.fsx.writeFileSync(SIGNAL_FILE, JSON.stringify({ ...JSON.parse(signalJson('t9')), projectDir: '/nulle-part' }))
    await w2.orch.handleSignal(SIGNAL_FILE)
    expect(w2.audits.length).toBe(0)
  })

  it('readProjectFiles : filtre SKIP_DIRS + troncature', () => {
    const { fsx } = makeFakeFs(
      {
        [`${PROJ}/a.ts`]: 'aaa',
        [`${PROJ}/node_modules/x.ts`]: 'nope',
        [`${PROJ}/big.ts`]: 'b'.repeat(17_000),
      },
      [PROJ],
    )
    const got = readProjectFiles(PROJ, ['a.ts', 'node_modules/x.ts', 'big.ts', 'missing.ts'], fsx)
    expect(got.some(f => f.path.includes('node_modules'))).toBe(false)
    expect(got.length).toBe(2)
    expect(got.find(f => f.path === 'big.ts')!.content.includes('…(tronqué)…')).toBe(true)
  })

  it('#10 : échantillonnage priorisé — un fichier "route/auth" découvert TARD survit à la troncature MAX_FILES, contrairement à un fichier ordinaire', () => {
    const files: Record<string, string> = {}
    // 60 fichiers "ordinaires" (> MAX_FILES=40) placés EN PREMIER dans le delta.
    const ordinary: string[] = []
    for (let i = 0; i < 60; i++) {
      const p = `component-${String(i).padStart(2, '0')}.tsx`
      files[`${PROJ}/${p}`] = `export const C${i} = () => null`
      ordinary.push(p)
    }
    // Un fichier sensible (auth), placé TOUT À LA FIN de la liste de delta —
    // "premier arrivé, premier servi" l'aurait perdu (60 > MAX_FILES=40).
    const sensitive = 'src/routes/auth-handler.ts'
    files[`${PROJ}/${sensitive}`] = 'export function login() {}'
    const { fsx } = makeFakeFs(files, [PROJ])
    const changed = [...ordinary, sensitive]
    const got = readProjectFiles(PROJ, changed, fsx)
    expect(got.length).toBe(MAX_FILES)
    expect(got.some(f => f.path === sensitive)).toBe(true)
  })

  it('#10 : signal "tests ailleurs dans le projet" propagé dans AuditContext', async () => {
    const withTest = makeWorld('t1', { withTestFile: true })
    await withTest.orch.handleSignal(SIGNAL_FILE)
    expect(withTest.contexts[0]?.testsElsewhereInProject).toBe(true)

    const withoutTest = makeWorld('t1', { withTestFile: false })
    await withoutTest.orch.handleSignal(SIGNAL_FILE)
    expect(withoutTest.contexts[0]?.testsElsewhereInProject).toBe(false)
  })

  it('#10 : projectHasTests — existence seule, contenu jamais lu', () => {
    const listing: Record<string, { name: string; dir: boolean }[]> = {
      '/proj': [
        { name: 'a.ts', dir: false },
        { name: 'node_modules', dir: true },
        { name: 'src', dir: true },
      ],
      '/proj/src': [
        { name: 'b.ts', dir: false },
        { name: 'b.test.ts', dir: false },
      ],
    }
    const fsx: FsLike = {
      existsSync: () => true,
      readFileSync: () => {
        throw new Error('projectHasTests ne doit jamais lire le contenu')
      },
      writeFileSync: () => {},
      mkdirSync: () => {},
      readdirSync: p => (listing[norm(p)] ?? []).map(e => ({ name: e.name, isDirectory: () => e.dir })),
      isFile: () => true,
    }
    expect(projectHasTests('/proj', fsx)).toBe(true)

    const listingNoTests: Record<string, { name: string; dir: boolean }[]> = {
      '/proj2': [{ name: 'a.ts', dir: false }],
    }
    const fsxNoTests: FsLike = { ...fsx, readdirSync: p => (listingNoTests[norm(p)] ?? []).map(e => ({ name: e.name, isDirectory: () => e.dir })) }
    expect(projectHasTests('/proj2', fsxNoTests)).toBe(false)
  })

  it('(P7) reconnaît les tests PRÉFIXÉS, sans confondre « latest » avec « test »', () => {
    // Trouvé par le produit en s'auditant lui-même : Mango QA nomme ses tests
    // `test-cli.ts`, forme que l'ancien motif (`*.test.*`/`*.spec.*`) ignorait. Son
    // PROPRE dépôt était donc vu comme dépourvu de tests, et les branches recevaient
    // « aucun fichier de test n'existe nulle part » — un mensonge sur la foi duquel la
    // branche Tests peut rendre un Feu Rouge.
    const avec = (noms: string[]): FsLike => ({
      existsSync: () => true,
      readFileSync: () => '',
      writeFileSync: () => {},
      mkdirSync: () => {},
      readdirSync: () => noms.map(n => ({ name: n, isDirectory: () => false })),
      isFile: () => true,
    })
    for (const n of ['test-cli.ts', 'test_utils.tsx', 'foo_test.ts', 'bar-spec.js', 'a.test.ts']) {
      expect(projectHasTests('/p', avec([n])), n).toBe(true)
    }
    // Le séparateur est obligatoire : un faux positif ici ÉTEINDRAIT un vrai Feu Rouge.
    for (const n of ['latest.ts', 'contest.ts', 'protest.js', 'manifest.json']) {
      expect(projectHasTests('/p', avec([n])), n).toBe(false)
    }
  })

  it('walkSrc : parcourt, saute les dossiers cachés/skip, borne MAX_FILES', () => {
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
    expect(rel.includes('a.ts') && rel.includes('sub/b.tsx')).toBe(true)
    expect(rel.includes('img.png')).toBe(false)
    expect(rel.length).toBe(2)
  })
})
