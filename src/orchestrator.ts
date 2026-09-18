// Mango QA — orchestrateur d'audit (moteur TESTABLE, extrait de index.ts — #Q2).
//
// index.ts reste le CÂBLAGE (env, watcher chokidar, heartbeat, process.exit) ; ici
// vit la LOGIQUE d'un signal de phase : dédup (lastHandled), verrou anti-chevauchement
// (inFlight), lecture bornée des fichiers livrés, branches d'audit, verdict, puis les
// visages dans l'ordre : Œil Design → Auditeur de Flux (Tier 0 + Tier 1 gaté) →
// Auditeur de Suite (gaté par SUITE_EYE=on — défaut off, comportement historique).
// Toutes les dépendances (fs, horloge, runners, log) sont injectées — même pattern
// que RunnerDeps des visages. Fail-open partout, mais JAMAIS silencieux (#Q3) : tout
// échec avalé est tracé en console.warn.
import fs from 'node:fs'
import path from 'node:path'
import type { Branch, PhaseSignal, ProjectFile, Rejection } from './types.js'
import { buildVerdict, type BranchResult } from './verdict.js'
import { loadRetexConstraints, recordRejection } from './retex.js'
import { runDesignEye, readLatestBrief } from './design-eye/runner.js'
import type { DesignContext, DesignObservation } from './design-eye/eye.js'
import { analyzeFlux, type FluxAnalysis } from './flux-eye/runner.js'
import { initFluxParser } from './flux-eye/parser.js'
import { shouldRunDeep, runFluxDeep, type DeepDecision, type FluxDeepObservation } from './flux-eye/deep.js'
import type { NavGraph } from './flux-eye/graph.js'
import type { FluxObservation } from './flux-eye/eye.js'
import { analyzeSuite } from './suite-eye/runner.js'
import type { SuiteObservation } from './suite-eye/audit.js'
import { walkTree } from './fs-shared.js'
import { sortByPriority } from './priority.js'

export const MAX_FILES = 40
export const MAX_FILE_CHARS = 16_000
export const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.mangoqa', '.snapshots', '.diffs'])
// #10 — cap de DÉCOUVERTE (chemins seuls, pas de contenu lu) distinct de MAX_FILES
// (sélection finale). On découvre large puis on trie par `priorityScore` avant de
// ne garder que les MAX_FILES élus — sans ce cap plus haut, walkTree s'arrêterait
// dès les 40 premiers fichiers rencontrés sur le disque (ordre alphabétique/inode),
// ce qui rend tout tri a posteriori inutile (rien à trier au-delà du 40ᵉ).
export const DISCOVERY_CAP = 500
// Fichiers de test — utilisé pour éviter un Feu Rouge fantôme sur la branche
// Tests quand les fichiers *.test.*/*.spec.* existent dans le projet mais sont
// hors du delta `changedFiles` de cette phase (cf. #10, constat "Tests").
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx)$/

// ── Système de fichiers injectable (surface minimale, testable sans disque) ──
export interface DirentLike {
  name: string
  isDirectory(): boolean
}

export interface FsLike {
  existsSync(p: string): boolean
  readFileSync(p: string): string
  writeFileSync(p: string, data: string): void
  mkdirSync(p: string): void
  readdirSync(p: string): DirentLike[]
  isFile(p: string): boolean
}

/** Implémentation réelle (node:fs) — le défaut hors tests. */
export const realFs: FsLike = {
  existsSync: p => fs.existsSync(p),
  readFileSync: p => fs.readFileSync(p, 'utf8'),
  writeFileSync: (p, data) => {
    // Atomic write: tmp+rename protects against mid-write crashes corrupting critical data
    const tmp = `${p}.tmp`
    fs.writeFileSync(tmp, data, 'utf8')
    try {
      fs.renameSync(tmp, p)
    } catch {
      // Windows may refuse rename if target is briefly held open (antivirus, editor)
      try {
        fs.writeFileSync(p, data, 'utf8')
      } finally {
        fs.rmSync(tmp, { force: true })
      }
    }
  },
  mkdirSync: p => fs.mkdirSync(p, { recursive: true }),
  readdirSync: p => fs.readdirSync(p, { withFileTypes: true }),
  isFile: p => fs.statSync(p).isFile(),
}

// ── Lecture bornée des fichiers livrés ───────────────────────────────────────
const SRC_EXT = /\.(ts|tsx|js|jsx|css|html|json)$/

/** Parcours récursif borné, chemins seuls (contenu lu séparément par `readProjectFiles`).
 *  Implémenté via le `walkTree` partagé (#R3) — comportement inchangé. */
export function walkSrc(dir: string, base: string, acc: string[], fsx: FsLike = realFs): void {
  walkTree<string>(dir, base, acc, {
    skipDirs: SKIP_DIRS,
    extRe: SRC_EXT,
    maxFiles: DISCOVERY_CAP,
    fsx,
    visit: (_full, rel) => rel,
    onError: err => console.warn('[mango-qa] orchestrateur:', (err as Error)?.message ?? err),
  })
}

/** #10 — la troncature à MAX_FILES n'est plus "premier arrivé, premier servi" :
 *  on trie d'abord TOUS les candidats découverts (jusqu'à DISCOVERY_CAP) par
 *  `priorityScore` (points d'entrée HTTP, auth, secrets/config, bootstrap serveur
 *  en tête), puis on ne lit le contenu que des MAX_FILES élus. S'applique aussi
 *  au delta `changedFiles` quand il dépasse MAX_FILES. */
export function readProjectFiles(projDir: string, changedFiles: string[], fsx: FsLike = realFs): ProjectFile[] {
  let rel: string[]
  if (changedFiles && changedFiles.length > 0) {
    rel = changedFiles.filter(f => !f.split(/[\\/]/).some(seg => SKIP_DIRS.has(seg)))
  } else {
    rel = []
    walkSrc(path.join(projDir, 'src'), projDir, rel, fsx)
    if (rel.length === 0) walkSrc(projDir, projDir, rel, fsx)
  }
  const prioritized = sortByPriority(rel)
  const out: ProjectFile[] = []
  for (const r of prioritized.slice(0, MAX_FILES)) {
    const abs = path.join(projDir, r)
    try {
      if (!fsx.existsSync(abs) || !fsx.isFile(abs)) continue
      let content = fsx.readFileSync(abs)
      if (content.length > MAX_FILE_CHARS) content = content.slice(0, MAX_FILE_CHARS) + '\n…(tronqué)…'
      out.push({ path: r.replace(/\\/g, '/'), content })
    } catch (err) {
      /* fichier illisible ignoré */
      console.warn('[mango-qa] orchestrateur:', (err as Error)?.message ?? err)
    }
  }
  return out
}

/** #10 (constat "Tests") — détecte l'EXISTENCE de fichiers `*.test.*`/`*.spec.*`
 *  n'importe où dans le projet (pas seulement dans `changedFiles`). Sert à éviter
 *  un Feu Rouge fantôme sur la branche Tests quand des tests existent mais sont
 *  hors du delta de cette phase. Contenu jamais lu — coût borné (arrêt au premier
 *  match via `maxFiles: 1`). */
export function projectHasTests(projDir: string, fsx: FsLike = realFs): boolean {
  const acc: string[] = []
  walkTree<string>(projDir, projDir, acc, {
    skipDirs: SKIP_DIRS,
    extRe: TEST_FILE_RE,
    maxFiles: 1,
    fsx,
    visit: (_full, rel) => rel,
    onError: err => console.warn('[mango-qa] orchestrateur:', (err as Error)?.message ?? err),
  })
  return acc.length > 0
}

// ── Runners injectables (les visages — mêmes signatures que les vrais) ───────
export interface OrchestratorRunners {
  loadRetexConstraints: (workspace: string, signal: PhaseSignal) => string
  recordRejection: (workspace: string, signal: PhaseSignal, rejection: Rejection) => void
  readLatestBrief: (workspace: string, project?: string) => DesignContext['brief'] | undefined
  runDesignEye: (projDir: string, files: ProjectFile[], deps: object, brief?: DesignContext['brief']) => DesignObservation
  initFluxParser: () => Promise<unknown>
  analyzeFlux: (projDir: string, deps: object) => FluxAnalysis
  shouldRunDeep: (graph: NavGraph, tier0: FluxObservation, signal: PhaseSignal, deps: { workspace?: string }) => DeepDecision
  runFluxDeep: (
    projDir: string,
    graph: NavGraph,
    tier0: FluxObservation,
    files: ProjectFile[],
    signal: PhaseSignal,
    deps: object,
  ) => Promise<FluxDeepObservation>
  analyzeSuite: (workspaceDir: string, deps: object) => { obs: SuiteObservation }
}

const DEFAULT_RUNNERS: OrchestratorRunners = {
  loadRetexConstraints,
  recordRejection,
  readLatestBrief,
  runDesignEye,
  initFluxParser,
  analyzeFlux,
  shouldRunDeep,
  runFluxDeep,
  analyzeSuite,
}

// ── Orchestrateur ────────────────────────────────────────────────────────────
export interface OrchestratorOptions {
  workspace: string
  branches: Branch[]
  /** Câblage de l'Auditeur de Suite (visage cross-app). Défaut OFF (env SUITE_EYE=on)
   *  pour ne pas changer le comportement actuel — best-effort, fail-open. */
  suiteEye?: boolean
  fs?: FsLike
  now?: () => number
  log?: (line: string) => void
  runners?: Partial<OrchestratorRunners>
}

export interface Orchestrator {
  /** Traite un phase-complete.json : dédup, verrou, audit, verdict, visages. */
  handleSignal(signalFile: string): Promise<void>
}

export function createOrchestrator(opts: OrchestratorOptions): Orchestrator {
  const { workspace, branches } = opts
  const suiteEye = opts.suiteEye ?? false
  const fsx = opts.fs ?? realFs
  const now = opts.now ?? (() => Date.now())
  const log = opts.log ?? ((line: string) => console.log(line))
  const runners: OrchestratorRunners = { ...DEFAULT_RUNNERS, ...opts.runners }

  const lastHandled = new Map<string, string>() // projectDir → timestamp traité (dédup add+change)
  const inFlight = new Set<string>() // verrou anti-chevauchement par projet

  const pendingSignals = new Map<string, string>()

  async function handleSignal(signalFile: string): Promise<void> {
    let signal: PhaseSignal
    try {
      signal = JSON.parse(fsx.readFileSync(signalFile)) as PhaseSignal
    } catch (err) {
      // signal partiel/illisible — chokidar awaitWriteFinish limite déjà ce cas
      console.warn('[mango-qa] orchestrateur:', (err as Error)?.message ?? err)
      return
    }
    const projDir = signal.projectDir
    if (!projDir || !fsx.existsSync(projDir)) return

    // Dédup (add + change pour la même écriture) + verrou.
    if (lastHandled.get(projDir) === signal.timestamp) return
    if (inFlight.has(projDir)) {
      pendingSignals.set(projDir, signalFile)
      return
    }
    inFlight.add(projDir)
    lastHandled.set(projDir, signal.timestamp)

    const t0 = now()
    log(`\n[mango-qa] 🛡️  Audit « ${signal.projectName} » — phase « ${signal.phase} » (tentative ${signal.retryCount})`)

    try {
      const files = readProjectFiles(projDir, signal.changedFiles ?? [], fsx)
      const retex = runners.loadRetexConstraints(workspace, signal)
      // #10 — signal projet ENTIER (pas le delta) pour désamorcer le Feu Rouge
      // fantôme de la branche Tests quand les tests existent hors du delta.
      const testsElsewhereInProject = projectHasTests(projDir, fsx)

      const results: BranchResult[] = await Promise.all(
        branches.map(async branch => {
          const relevant = branch.relevant(files)
          const finding = await branch.audit({ signal, files: relevant, retex, testsElsewhereInProject })
          const icon = finding.status === 'fail' ? '🔴' : finding.status === 'pass' ? '🟢' : '⚪'
          log(`  ${icon} ${branch.emoji} ${branch.label}: ${finding.summary}`)
          return { branch, finding }
        }),
      )

      const verdict = buildVerdict(results, signal.retryCount)
      verdict.signalTimestamp = signal.timestamp
      const qaDir = path.join(projDir, '.mangoqa')
      if (!fsx.existsSync(qaDir)) fsx.mkdirSync(qaDir)
      fsx.writeFileSync(path.join(qaDir, 'audit-verdict.json'), JSON.stringify(verdict, null, 2))

      // Visage 3 — l'Œil Design : mesure déterministe (contraste/tokens/conformité)
      // sur les mêmes fichiers. Écrit ses observations À CÔTÉ du verdict, ne le
      // modifie jamais, ne bloque jamais (souple). Fail-open.
      try {
        // La cible (palette Sharingan/Perfect Plan) vient du flux du Bus, publiée
        // par MangoOS → l'Œil mesure désormais la conformité au brief (briefDrift).
        const brief = runners.readLatestBrief(workspace, signal.projectName)
        const eye = runners.runDesignEye(projDir, files, {}, brief)
        const visual = eye.counts.measured > 0 ? `👁️  ${eye.summary}` : '👁️  cohérence visuelle OK'
        log(`  ${visual}`)
      } catch (err) {
        /* l'Œil n'arrête jamais la production */
        console.warn('[mango-qa] œil-design:', (err as Error)?.message ?? err)
      }

      // Auditeur de Flux — mesure déterministe du CHEMIN HUMAIN (écrans fantômes,
      // surfaces inatteignables) sur tout le source du projet. Écrit ses observations
      // À CÔTÉ du verdict, ne le modifie jamais, ne bloque jamais (conseil). Fail-open.
      try {
        await runners.initFluxParser() // pré-charge le moteur AST (idempotent) ; fail-open via ce try
        const { obs: flux, graph: fluxGraph, files: fluxFiles } = runners.analyzeFlux(projDir, {})
        log(`  🧭 ${flux.counts.measured > 0 || flux.counts.convergence > 0 ? flux.summary : 'flux cohérent'}`)
        // Tier 1 (conseil, LLM, cost-aware) : seulement si un declencheur s'arme.
        const deepDecision = runners.shouldRunDeep(fluxGraph, flux, signal, { workspace })
        if (deepDecision.run) {
          const deep = await runners.runFluxDeep(projDir, fluxGraph, flux, fluxFiles, signal, {})
          log(`  🧭+ Tier 1 (${deepDecision.reason}) → ${deep.summary}`)
        }
      } catch (err) {
        /* l'Auditeur n'arrête jamais la production */
        console.warn('[mango-qa] flux:', (err as Error)?.message ?? err)
      }

      // Auditeur de Suite (cross-app) — câblé au même titre que les autres visages
      // (#Q2 : run-suite-eye.ts n'était accessible qu'en CLI), mais GATÉ par
      // SUITE_EYE=on (défaut off = comportement historique). Best-effort, fail-open.
      if (suiteEye) {
        try {
          const { obs: suite } = runners.analyzeSuite(workspace, {})
          log(`  🧩 ${suite.summary}`)
        } catch (err) {
          /* l'Auditeur de Suite n'arrête jamais la production */
          console.warn('[mango-qa] suite:', (err as Error)?.message ?? err)
        }
      }

      if (verdict.verdict === 'red' && verdict.rejection) {
        runners.recordRejection(workspace, signal, verdict.rejection)
        log(`[mango-qa] 🔴 Feu Rouge (${verdict.rejection.branch}) en ${now() - t0}ms → ${verdict.rejection.corrective_action}`)
      } else if (verdict.verdict === 'unknown') {
        log('[mango-qa] ⚪ Audit incomplet — non vérifié')
      } else {
        log(`[mango-qa] ✅ Feu Vert en ${now() - t0}ms`)
      }
    } catch (err) {
      console.error('[mango-qa] audit:', err instanceof Error ? err.message : err)
      // Fail-open : on n'écrit pas de verdict → MangoOS continue après timeout.
    } finally {
      inFlight.delete(projDir)
      const pending = pendingSignals.get(projDir)
      pendingSignals.delete(projDir)
      if (pending) await handleSignal(pending)
    }
  }

  return { handleSignal }
}
