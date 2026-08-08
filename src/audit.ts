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
import type {
  AuditCoverage,
  Branch,
  BranchFinding,
  CauseAbstention,
  PhaseSignal,
  ProjectFile,
  QAVerdict,
} from './types.js'
// (2026-08-05, J3) Import direct de `project-files.js`, PAS de `orchestrator.js` : c'est
// ce qui garde la CLI légère. Passer par l'orchestrateur tirait design-eye, suite-eye,
// retex et flux-eye/parser → web-tree-sitter (50 Mo de WASM) pour trois fonctions de
// lecture. L'orchestrateur ré-exporte ce module, donc rien d'autre ne change.
import { readProjectFiles, projectHasTests, realFs, type FsLike, type ReadStats } from './project-files.js'
import { buildVerdict, estPanne } from './verdict.js'
import { CerveauInutilisableError, preflightCerveau, type ResultatPreflight } from './preflight.js'
import { scanConventions, type ConventionsScan } from './conventions.js'
import { scanSpec, type SpecScan } from './spec.js'
import { architecture } from './branches/architecture.js'
import { security } from './branches/security.js'
import { accessibility } from './branches/accessibility.js'
import { performance } from './branches/performance.js'
import { tests } from './branches/tests.js'
import { designSystem } from './branches/design-system.js'
import { spec } from './branches/spec.js'

/** Les 7 branches, dans l'ordre de PRIORITÉ du rejet (la 1ʳᵉ bloquante en échec porte
 *  le Feu Rouge).
 *
 *  **Spec vient en premier** (2026-08-08, lot 4), et ce n'est pas un détail d'ordre :
 *  quand du code ne fait pas ce qui était demandé, c'est le seul reproche qui compte.
 *  Rendre un Feu Rouge « contraste insuffisant » sur une fonctionnalité qui n'existe pas
 *  ferait travailler l'utilisateur sur le mauvais problème. */
export const ALL_BRANCHES: Branch[] = [
  spec,
  architecture,
  security,
  accessibility,
  performance,
  tests,
  designSystem,
]

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
  /**
   * Vérifier que le cerveau sait rendre un verdict AVANT de lancer l'audit. Défaut : oui.
   *
   * (2026-08-05, J4-a) Coûte un aller-retour de quelques centaines de ms ; évite de
   * découvrir au bout de six appels de plusieurs minutes que rien n'a été jugé. Échec
   * → `CerveauInutilisableError`, jamais un rapport : un rapport rendu par un cerveau
   * qui ne juge pas est très exactement ce que ce lot supprime.
   *
   * Passer `false` a un seul usage légitime : l'appelant a DÉJÀ fait le préflight
   * (le harnais d'éval le fait, une fois pour toute une campagne).
   */
  preflight?: boolean
  /**
   * Lire les conventions écrites par le dépôt et juger contre elles. Défaut : oui.
   *
   * (2026-08-08, lot 3) Déterministe et bon marché (quelques fichiers texte à la
   * racine). `false` rend un prompt byte-identique à celui d'avant le lot 3 — utile
   * pour comparer deux mesures dont l'une précède le lot.
   */
  conventions?: boolean
  /** Plafond de caractères de code par prompt. `undefined` → `QA_FILE_PAYLOAD_CAP`,
   *  puis 100 000. Porté par le contrat depuis la faille L2-a : un serveur MCP
   *  long-vivant ne peut pas régler ça par une variable de process partagée. */
  cap?: number
  /**
   * Chemin d'un fichier décrivant ce qui était DEMANDÉ (`--spec`). Active la branche
   * Spec ; sans lui elle s'abstient et le rapport le déclare.
   *
   * (2026-08-08, lot 4) Lève `SpecInutilisableError` si le fichier est introuvable ou
   * n'énonce aucune exigence lisible : l'utilisateur a demandé qu'on juge contre un
   * document, lui rendre en silence un audit sans spec répondrait à une autre question
   * que la sienne.
   */
  spec?: string
  /** Injection (tests) — un scan de spec déjà fait, au lieu d'un chemin à lire. */
  specScan?: SpecScan
  /** Injection (tests). */
  fs?: FsLike
  now?: () => number
  /** Injection (tests) — le préflight réellement exécuté. */
  preflightFn?: () => Promise<ResultatPreflight>
  /** Injection (tests) — le registre de branches. Défaut : les 6 réelles.
   *  Sert à rejouer une panne de cerveau de bout en bout sans réseau. */
  branches?: Branch[]
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

/** Ce qui a effectivement été JUGÉ — le pendant de `ReportCoverage`.
 *
 *  (2026-08-05, J4-a) La couverture répond à « qu'a-t-il lu ? », celui-ci répond à
 *  « qu'a-t-il jugé ? ». Il a fallu les deux : sur la sonde du 2026-08-05, la
 *  couverture s'affichait **complète** — et elle disait vrai, les fichiers avaient
 *  bien été envoyés — pendant qu'aucune des six branches n'avait rendu de verdict. */
export interface ReportJugement {
  /** Vrai si toutes les branches BLOQUANTES ont rendu un jugement. Faux dès qu'une
   *  seule n'a pas pu juger : il n'existe alors plus de Feu Vert défendable. */
  complet: boolean
  /** Les branches qui n'ont PAS PU juger, et pourquoi. Vide si `complet`. */
  nonJugees: Array<{ id: string; label: string; cause: CauseAbstention; blocking: boolean }>
  /** Résultat du préflight, s'il a été exécuté. `undefined` = non exécuté. */
  preflight?: ResultatPreflight
}

/** Ce que le dépôt avait ÉCRIT comme règles, et ce que l'audit en a fait.
 *
 *  (2026-08-08, lot 3) Troisième déclaration de la même famille que `coverage` (ce qui
 *  a été lu) et `jugement` (ce qui a été jugé) : celle-ci dit **contre quoi** on a jugé.
 *
 *  ⚠️ Piège de lecture à ne jamais commettre : `citees` n'est PAS « les règles
 *  vérifiées ». Une règle non citée a très bien pu être vérifiée et respectée. Ce champ
 *  dit ce qui a été FOURNI au jugement et ce qui a été INVOQUÉ dans une trouvaille —
 *  rien de plus. Prétendre l'inverse referait, sur les conventions, l'erreur que J1-a
 *  et J4-a ont coûté cher à corriger. */
export interface ReportConventions {
  /** Fichiers de conventions lus (chemins relatifs). Vide si le projet n'en a aucun. */
  files: string[]
  /** Règles extraites et fournies au jugement. */
  rulesProvided: number
  /** Règles écartées par le cap (`QA_CONVENTIONS_CAP`). */
  rulesDropped: number
  /** Identifiants VÉRIFIÉS invoqués par au moins une trouvaille. */
  cited: string[]
  /** Citations rejetées : le modèle a invoqué une règle qui n'existe pas. */
  rejected: string[]
  /** Vrai si le projet ne documente AUCUNE convention lisible. Déclaré, jamais supposé. */
  absent: boolean
}

/** Ce qui avait été DEMANDÉ, et ce que l'audit en a fait.
 *
 *  (2026-08-08, lot 4) Quatrième déclaration de la même famille : `coverage` dit ce qui
 *  a été lu, `jugement` ce qui a été jugé, `conventions` contre quelles règles maison —
 *  celle-ci dit **contre quelle demande**. Et comme les trois autres, son cas « absent »
 *  compte autant que l'autre : un feu vert rendu sans spec ne dit rien sur la question
 *  « est-ce que c'est ce que j'avais demandé ? », et doit le dire. */
export interface ReportSpec {
  /** Fichier de spec utilisé. `null` quand aucune spec n'a été fournie. */
  file: string | null
  /** Exigences extraites et soumises au jugement. */
  exigencesProvided: number
  /** Exigences écartées par le cap (`QA_SPEC_CAP`). */
  exigencesDropped: number
  /** Identifiants VÉRIFIÉS invoqués par une trouvaille (exigences jugées non satisfaites). */
  cited: string[]
  /** Citations rejetées : le modèle a invoqué une exigence qui n'existe pas. */
  rejected: string[]
  /** Texte des exigences citées, pour que le rapport puisse les montrer entre guillemets. */
  citedTexts: Array<{ id: string; text: string }>
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
  /** Ce qui a été jugé et ce qui ne l'a pas été. Même règle d'affichage que `coverage` :
   *  AVEC le verdict, jamais en note de bas de page. */
  jugement: ReportJugement
  /** Contre quelles règles du dépôt on a jugé. `undefined` = scan désactivé. */
  conventions?: ReportConventions
  /** Contre quelle demande on a jugé. Toujours présent : son cas « absent » est une
   *  information, pas un silence. */
  spec: ReportSpec
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
  const registre = opts.branches ?? ALL_BRANCHES
  const branches = opts.only?.length ? registre.filter(b => opts.only!.includes(b.id)) : registre
  if (branches.length === 0) {
    throw new Error(`Aucune branche ne correspond à : ${opts.only?.join(', ')}`)
  }

  const t0 = now()

  // PRÉFLIGHT — avant de lire le moindre fichier. Un cerveau qui ne sait pas rendre un
  // verdict rend l'audit entier sans objet ; le découvrir maintenant coûte quelques
  // centaines de ms, le découvrir à la fin coûte six appels de plusieurs minutes.
  let preflight: ResultatPreflight | undefined
  if (opts.preflight !== false) {
    preflight = await (opts.preflightFn ?? preflightCerveau)()
    if (!preflight.ok) throw new CerveauInutilisableError(preflight)
  }

  // Les conventions se lisent UNE fois pour les six branches : elles décrivent le
  // dépôt, pas le périmètre de chaque spécialité. Déterministe, aucun appel de modèle.
  const scan: ConventionsScan | undefined =
    opts.conventions === false ? undefined : scanConventions(dir, fsx)

  // La spec se lit AVANT l'audit, et son échec est fatal : mieux vaut refuser de juger
  // que juger contre une demande qu'on n'a pas su lire.
  const specScan: SpecScan | undefined =
    opts.specScan ?? (opts.spec !== undefined ? scanSpec(opts.spec, fsx) : undefined)

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
      // Aucune branche n'a tourné : aucune n'a échoué à juger. Un dossier sans code
      // auditable est un non-événement, pas une panne de l'auditeur.
      jugement: { complet: true, nonJugees: [], ...(preflight ? { preflight } : {}) },
      // Aucune branche n'a tourné : rien n'a pu être cité. Le scan est tout de même
      // rapporté — savoir qu'un dépôt documente 14 règles jamais confrontées à du code
      // est une information, et la taire ferait croire qu'il n'en documente aucune.
      ...(scan ? { conventions: agregerConventions(scan, []) } : {}),
      spec: agregerSpec(specScan, []),
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
        ? {
            status: 'skip',
            summary: 'Aucun fichier pertinent pour cette branche.',
            abstention: { cause: 'hors-perimetre' },
          }
        : await branch.audit({
            signal,
            files: relevant,
            retex,
            testsElsewhereInProject: testsElsewhere,
            ...(scan ? { conventions: scan } : {}),
            ...(specScan ? { spec: specScan } : {}),
            ...(opts.cap !== undefined ? { cap: opts.cap } : {}),
          })
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
  // Les branches qui n'ont PAS PU juger — pannes seulement. Une branche hors périmètre
  // ou un `skip` assumé par le juge sont des jugements, pas des trous.
  const nonJugees = results
    .filter(r => r.finding.status === 'skip' && estPanne(r.finding.abstention))
    .map(r => ({
      id: r.id,
      label: r.label,
      cause: r.finding.abstention?.cause ?? ('cause-inconnue' as CauseAbstention),
      blocking: r.blocking,
    }))
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
    jugement: {
      // Seules les branches BLOQUANTES décident : design-system est un conseil, son
      // silence n'empêche pas de statuer sur la santé du code.
      complet: !nonJugees.some(b => b.blocking),
      nonJugees,
      ...(preflight ? { preflight } : {}),
    },
    ...(scan ? { conventions: agregerConventions(scan, results) } : {}),
    spec: agregerSpec(specScan, results),
    durationMs: now() - t0,
    empty: false,
  }
}

/** Réunit le scan de spec et ce que les branches en ont cité. */
function agregerSpec(scan: SpecScan | undefined, results: BranchResultLite[]): ReportSpec {
  const cited = new Set<string>()
  const rejected = new Set<string>()
  for (const r of results) {
    for (const id of r.finding.spec?.citees ?? []) cited.add(id)
    for (const id of r.finding.spec?.rejetees ?? []) rejected.add(id)
  }
  const index = new Map((scan?.exigences ?? []).map(e => [e.id, e.text]))
  const ids = [...cited].sort()
  return {
    file: scan?.file ?? null,
    exigencesProvided: scan?.exigences.length ?? 0,
    exigencesDropped: scan?.dropped ?? 0,
    cited: ids,
    rejected: [...rejected].sort(),
    // Le texte voyage avec l'identifiant : le critère d'achèvement du lot exige que
    // l'exigence soit CITÉE ENTRE GUILLEMETS, pas seulement référencée. Un rapport qui
    // afficherait « spec:12 non satisfaite » obligerait le lecteur à aller ouvrir le
    // fichier pour savoir de quoi on parle.
    citedTexts: ids.map(id => ({ id, text: index.get(id) ?? '' })).filter(e => e.text !== ''),
  }
}

/** Réunit le scan déterministe et ce que les branches en ont cité. */
function agregerConventions(scan: ConventionsScan, results: BranchResultLite[]): ReportConventions {
  const cited = new Set<string>()
  const rejected = new Set<string>()
  for (const r of results) {
    for (const id of r.finding.conventions?.citees ?? []) cited.add(id)
    for (const id of r.finding.conventions?.rejetees ?? []) rejected.add(id)
  }
  return {
    files: scan.files,
    rulesProvided: scan.rules.length,
    rulesDropped: scan.dropped,
    cited: [...cited].sort(),
    rejected: [...rejected].sort(),
    absent: scan.absent,
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
