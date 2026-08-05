// J1 — API AUTONOME de Mango QA : auditer N'IMPORTE QUEL dossier de code.
//
// Pourquoi ce module (2026-08-04, refonte produit — voir MangoOS/docs/refonte/06) :
// jusqu'ici, la SEULE façon de déclencher un audit était que MangoOS écrive
// `<projet>/.mangoqa/phase-complete.json`. Le moteur d'audit lui-même n'a pourtant
// aucune dépendance à MangoOS (vérifié : zéro import, les branches prennent de simples
// `{ path, content }`) — il était juste inatteignable autrement.
//
// Ce module rend le moteur appelable directement :
//     const rapport = await auditProject('./mon-projet')
// Aucun fichier-signal, aucun workspace, aucun watcher, aucun MangoOS.
//
// Le chemin historique (`orchestrator.ts` + watcher chokidar) reste INCHANGÉ et
// continue de servir l'intégration MangoOS — les deux partagent le même moteur.

import path from 'node:path'
import type { AuditCoverage, Branch, BranchFinding, PhaseSignal, ProjectFile, QAVerdict } from './types.js'
// (2026-08-05, J3) Import direct de `project-files.js`, PAS de `orchestrator.js` : c'est
// ce qui garde la CLI légère. Passer par l'orchestrateur tirait design-eye, suite-eye,
// retex et flux-eye/parser → web-tree-sitter (50 Mo de WASM) pour trois fonctions de
// lecture. L'orchestrateur ré-exporte ce module, donc rien d'autre ne change.
import { readProjectFiles, projectHasTests, realFs, type FsLike, type ReadStats } from './project-files.js'
import { buildVerdict } from './verdict.js'
import { architecture } from './branches/architecture.js'
import { security } from './branches/security.js'
import { accessibility } from './branches/accessibility.js'
import { performance } from './branches/performance.js'
import { tests } from './branches/tests.js'
import { designSystem } from './branches/design-system.js'

/** Les 6 branches, dans l'ordre de PRIORITÉ du rejet (la 1ʳᵉ bloquante en échec porte le Feu Rouge). */
export const ALL_BRANCHES: Branch[] = [architecture, security, accessibility, performance, tests, designSystem]

export interface AuditOptions {
  /** Sous-ensemble de branches (ids). Défaut : les 6. */
  only?: string[]
  /** N'auditer que ces fichiers (chemins relatifs au projet). Défaut : tout le projet. */
  changedFiles?: string[]
  /**
   * Nombre de branches lancées EN PARALLÈLE. Défaut 6 (comportement historique).
   *
   * ⚠️ Mesuré le 2026-08-04 : sur un cerveau LOCAL mono-GPU, les 6 appels se
   * SÉRIALISENT de toute façon au niveau d'Ollama — le total mur est le même (~133 s),
   * mais en parallèle aucune branche ne rend son verdict avant la fin. Passer à 1
   * ne coûte donc rien en durée totale et permet d'afficher les résultats AU FIL DE
   * L'EAU (bien meilleur en CLI). Sur un cerveau cloud, garder 6.
   */
  concurrency?: number
  /** Contraintes héritées du Retex (erreurs passées). Défaut : aucune. */
  retex?: string
  /** Appelé dès qu'une branche rend son verdict — pour un affichage progressif. */
  onBranch?: (result: BranchResultLite) => void
  /** Nombre de tentatives déjà faites sur ce projet (nourrit le verdict). Défaut 0. */
  retryCount?: number
  /** Injection (tests). */
  fs?: FsLike
  now?: () => number
}

export interface BranchResultLite {
  id: string
  label: string
  emoji: string
  blocking: boolean
  finding: BranchFinding
  /** Fichiers effectivement retenus par `relevant()` pour cette branche. */
  filesAudited: number
  /** Ce que le modèle a réellement LU parmi ces `filesAudited` (J1 défaut n°2).
   *  `undefined` = branche sautée sans appel LLM (aucun fichier pertinent). */
  coverage?: AuditCoverage
  durationMs: number
}

/** Couverture au niveau PROJET — les deux étages de perte, avant les branches.
 *  (Les branches ont leur propre couverture de prompt dans `BranchResultLite`.) */
export interface ReportCoverage {
  /** Fichiers candidats découverts dans le projet. */
  filesDiscovered: number
  /** Fichiers réellement lus et soumis aux branches (cap `MAX_FILES`). */
  filesRead: number
  /** Chemins découverts mais jamais lus — nommés, pas seulement comptés. */
  filesDropped: string[]
  /** Fichiers lus mais COUPÉS à la lecture (cap `MAX_FILE_CHARS`). */
  filesTruncated: string[]
  /** Vrai si le projet entier a été lu ET vu par toutes les branches concernées. */
  complete: boolean
}

export interface AuditReport {
  projectName: string
  projectDir: string
  /** Le contrat FIGÉ, identique à celui écrit dans `.mangoqa/audit-verdict.json`. */
  verdict: QAVerdict
  /** Le détail par branche — ce que le contrat figé ne porte pas. */
  branches: BranchResultLite[]
  filesScanned: number
  /** Ce qui a été vu et ce qui ne l'a pas été. À afficher AVEC le verdict, jamais après. */
  coverage: ReportCoverage
  durationMs: number
  /** Vrai si aucun fichier auditable n'a été trouvé (dossier vide, ou hors périmètre). */
  empty: boolean
}

/**
 * Audite un dossier de code et rend un rapport complet.
 *
 * Ne throw JAMAIS sur un défaut d'audit (fail-open, invariant du produit) : une branche
 * qui échoue devient un `skip`. Throw uniquement si le dossier lui-même est inutilisable.
 */
export async function auditProject(projectDir: string, opts: AuditOptions = {}): Promise<AuditReport> {
  const fsx = opts.fs ?? realFs
  const now = opts.now ?? (() => Date.now())
  const dir = path.resolve(projectDir)
  if (!fsx.existsSync(dir)) throw new Error(`Dossier introuvable : ${dir}`)

  const projectName = path.basename(dir)
  const branches = opts.only?.length
    ? ALL_BRANCHES.filter(b => opts.only!.includes(b.id))
    : ALL_BRANCHES
  if (branches.length === 0) {
    throw new Error(`Aucune branche ne correspond à : ${opts.only?.join(', ')}`)
  }

  const t0 = now()
  const readStats: ReadStats = { discovered: 0, read: 0, dropped: [] }
  const files: ProjectFile[] = readProjectFiles(dir, opts.changedFiles ?? [], fsx, readStats)

  // Le PhaseSignal reste le contrat d'entrée des branches — on le SYNTHÉTISE ici au
  // lieu de le lire sur disque. C'est tout ce qui séparait le moteur d'un usage libre.
  const signal: PhaseSignal = {
    projectName,
    phase: 'audit',
    timestamp: new Date(now()).toISOString(),
    projectDir: dir,
    changedFiles: files.map(f => f.path),
    retryCount: opts.retryCount ?? 0,
  }

  if (files.length === 0) {
    return {
      projectName,
      projectDir: dir,
      verdict: { verdict: 'green', rejection: null, branches: {} },
      branches: [],
      filesScanned: 0,
      coverage: {
        filesDiscovered: readStats.discovered,
        filesRead: 0,
        filesDropped: readStats.dropped,
        filesTruncated: [],
        // Rien lu n'est pas « tout lu » : un dossier vide est complet, un dossier
        // dont AUCUN fichier n'a pu être lu ne l'est pas.
        complete: readStats.discovered === 0,
      },
      durationMs: now() - t0,
      empty: true,
    }
  }

  const testsElsewhere = projectHasTests(dir, fsx)
  const retex = opts.retex ?? ''

  const runOne = async (branch: Branch): Promise<BranchResultLite> => {
    const started = now()
    const relevant = branch.relevant(files)
    // `relevant() === []` → la branche ne juge pas ce projet. C'est un `skip` explicite,
    // jamais un `pass` : distinguer « rien à auditer » de « audité et conforme » est ce
    // qui empêche un rapport de mentir par omission.
    const finding: BranchFinding =
      relevant.length === 0
        ? { status: 'skip', summary: 'Aucun fichier pertinent pour cette branche.' }
        : await branch.audit({ signal, files: relevant, retex, testsElsewhereInProject: testsElsewhere })
    const result: BranchResultLite = {
      id: branch.id,
      label: branch.label,
      emoji: branch.emoji,
      blocking: branch.blocking,
      finding,
      filesAudited: relevant.length,
      ...(finding.coverage ? { coverage: finding.coverage } : {}),
      durationMs: now() - started,
    }
    opts.onBranch?.(result)
    return result
  }

  const results = await mapWithConcurrency(branches, opts.concurrency ?? branches.length, runOne)

  // `buildVerdict` attend la forme historique { branch, finding } — on la reconstitue
  // pour garder UN SEUL calcul de verdict entre le chemin autonome et le chemin MangoOS.
  const verdict = buildVerdict(
    results.map((r, i) => ({ branch: branches[i], finding: r.finding })),
    signal.retryCount,
  )

  const filesTruncated = files.filter(f => f.truncated).map(f => f.path)
  return {
    projectName,
    projectDir: dir,
    verdict,
    branches: results,
    filesScanned: files.length,
    coverage: {
      filesDiscovered: readStats.discovered,
      filesRead: readStats.read,
      filesDropped: readStats.dropped,
      filesTruncated,
      // Complet = les trois étages sont intacts : tout découvert a été lu, rien n'a
      // été coupé à la lecture, et aucune branche n'a rendu une couverture partielle.
      complete:
        readStats.dropped.length === 0 &&
        filesTruncated.length === 0 &&
        results.every(r => r.coverage === undefined || r.coverage.complete),
    },
    durationMs: now() - t0,
    empty: false,
  }
}

/** Exécute `fn` sur chaque item, `limit` en vol au maximum, en PRÉSERVANT l'ordre du retour. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const max = Math.max(1, Math.min(limit, items.length))
  const out = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: max }, async () => {
      for (;;) {
        const i = next++
        if (i >= items.length) return
        out[i] = await fn(items[i])
      }
    }),
  )
  return out
}
