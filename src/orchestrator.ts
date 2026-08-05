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

// ── Lecture bornée des fichiers livrés ───────────────────────────────────────
// (2026-08-05, J3) DÉPLACÉE dans `project-files.ts` — voir l'en-tête de ce module :
// la CLI n'a besoin que de ces trois fonctions, et les importer d'ici lui faisait
// tirer web-tree-sitter (50 Mo de WASM) via flux-eye/parser. Ré-exportées telles
// quelles : aucun appelant historique ne change.
export {
  MAX_FILES,
  MAX_FILE_CHARS,
  SKIP_DIRS,
  DISCOVERY_CAP,
  realFs,
  walkSrc,
  readProjectFiles,
  projectHasTests,
  type DirentLike,
  type FsLike,
  type ReadStats,
} from './project-files.js'
// `export … from` ne met rien dans la portée LOCALE : l'orchestrateur utilise aussi
// ces symboles pour son propre compte, d'où cet import en plus de la ré-exportation.
import { realFs, readProjectFiles, projectHasTests, type FsLike } from './project-files.js'

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
    if (inFlight.has(projDir)) return
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
      } else {
        log(`[mango-qa] ✅ Feu Vert en ${now() - t0}ms`)
      }
    } catch (err) {
      console.error('[mango-qa] audit:', err instanceof Error ? err.message : err)
      // Fail-open : on n'écrit pas de verdict → MangoOS continue après timeout.
    } finally {
      inFlight.delete(projDir)
    }
  }

  return { handleSignal }
}
