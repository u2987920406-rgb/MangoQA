// Contrats de données Mango QA.
//
// ⚠️ Les types PhaseSignal / QAVerdict / Rejection / BranchSummary sont le
// CONTRAT FIGÉ partagé avec MangoOS (server/src/mangoqa.ts). Ne pas en changer
// la forme : MangoOS écrit phase-complete.json selon PhaseSignal et lit
// audit-verdict.json selon QAVerdict. Tout le reste est interne à Mango QA.

// Import de TYPE seulement (effacé à la compilation) : `conventions.ts` dépend de
// `project-files.ts` qui dépend de ce fichier. Le cycle n'existe donc qu'au niveau des
// types, jamais à l'exécution.
import type { ConventionsScan } from './conventions.js'

/** Signal émis par MangoOS après chaque commit de phase
 *  (mangoqa.ts → emitPhaseComplete). Écrit dans <projet>/.mangoqa/phase-complete.json */
export interface PhaseSignal {
  projectName: string
  phase: string
  timestamp: string
  projectDir: string
  changedFiles: string[]
  retryCount: number
}

/** Bloc rejet du verdict (Degré 1 — instruction de guidage déterministe). */
export interface Rejection {
  rejection_id: string
  corrective_action: string
  rule_ref: string
  branch: string
  retry_count: number
}

/** Résumé par branche, exposé tel quel dans le verdict. */
export interface BranchSummary {
  status: string
  summary: string
}

/** Couverture agrégée d'un verdict — quelles branches n'ont pas tout lu.
 *
 *  (2026-08-05, J1 défaut n°2) Ajout STRICTEMENT ADDITIF au contrat figé :
 *  `verdict` reste `'green' | 'red'` — introduire un 3ᵉ état casserait le lecteur
 *  de MangoOS. Un lecteur qui ignore ce champ retrouve donc EXACTEMENT le
 *  comportement d'avant ; celui qui le lit sait quand un Feu Vert ne porte que
 *  sur une partie du code. La mention est en plus recopiée en clair dans le
 *  `summary` de chaque branche concernée, pour qu'aucun affichage ne puisse
 *  passer à côté sans avoir été mis à jour. */
export interface VerdictCoverage {
  /** Vrai si CHAQUE branche a vu 100 % des fichiers qui la concernaient. */
  complete: boolean
  /** Les branches à lecture partielle, et leur ratio. Vide si `complete`. */
  partial: Array<{ branch: string; filesRendered: number; filesTotal: number }>
}

/** Pourquoi une branche a rendu `skip`. Toutes les abstentions ne se valent pas —
 *  les confondre est le défaut J4-a (un cerveau muet produisait un Feu Vert).
 *
 *  Deux familles, et c'est la seule distinction qui compte :
 *  • un JUGEMENT a eu lieu (`hors-perimetre`, `juge-sans-avis`) — rien à signaler ;
 *  • aucun jugement n'a eu lieu (`reponse-illisible`, `cerveau-injoignable`) — une
 *    PANNE de l'auditeur, qui ne doit jamais ressembler à « rien à signaler ».
 *
 *  « Le produit distinguait déjà "n'a pas LU" de "a lu et n'a rien trouvé".
 *    Il lui manquait "n'a pas JUGÉ" contre "a jugé et n'a rien trouvé". » */
export type CauseAbstention =
  /** `relevant()` n'a retenu aucun fichier : la branche n'avait rien à regarder.
   *  NON-ÉVÉNEMENT — ni un mérite, ni une panne. */
  | 'hors-perimetre'
  /** Le cerveau a répondu dans le contrat et a lui-même choisi `skip` (« pas ma
   *  spécialité »). C'est un jugement RENDU, il ne masque aucune panne. */
  | 'juge-sans-avis'
  /** Le cerveau a répondu, mais hors contrat : aucun JSON exploitable. PANNE. */
  | 'reponse-illisible'
  /** Le cerveau n'a pas répondu du tout (injoignable, timeout, erreur). PANNE. */
  | 'cerveau-injoignable'
  /** `skip` produit sans motif déclaré (producteur non mis à jour). Traité comme une
   *  PANNE : inventer un motif serait pire que dire qu'on ne le connaît pas. */
  | 'cause-inconnue'

/** Le motif d'un `skip`, porté par le finding. Présent UNIQUEMENT si `status === 'skip'`.
 *  Le prédicat qui tranche panne / jugement vit dans `verdict.ts` (`estPanne`). */
export interface Abstention {
  cause: CauseAbstention
  /** Message technique brut (erreur, extrait de réponse) — pour le diagnostic, jamais
   *  pour la décision. */
  detail?: string
}

/** Abstentions agrégées d'un verdict — quelles branches n'ont pas PU juger.
 *
 *  (2026-08-05, J4-a) Ajout STRICTEMENT ADDITIF, calqué sur `VerdictCoverage` :
 *  `verdict` reste `'green' | 'red'`. Un lecteur qui ignore ce champ retrouve
 *  exactement le comportement d'avant — c'est ce qui préserve le fail-open de
 *  l'intégration MangoOS : une panne de Mango QA ne bloque toujours pas la
 *  production. Ce qui change, c'est qu'elle ne peut plus passer pour un succès :
 *  le champ la porte, et la mention est recopiée EN CLAIR dans le résumé de chaque
 *  branche concernée pour qu'aucun affichage non mis à jour ne l'efface. */
export interface VerdictAbstentions {
  /** Vrai si toutes les branches BLOQUANTES ont effectivement rendu un jugement.
   *  Faux dès qu'une seule n'a pas pu juger. */
  jugementComplet: boolean
  /** Les branches qui n'ont PAS PU juger (pannes seulement — les branches hors
   *  périmètre et les `skip` assumés par le juge n'y figurent pas). */
  nonJugees: Array<{ branch: string; cause: CauseAbstention; blocking: boolean }>
}

/** Verdict lu par MangoOS (mangoqa.ts → QAVerdict). CONTRAT FIGÉ. */
export interface QAVerdict {
  verdict: 'green' | 'red'
  rejection: Rejection | null
  branches: Record<string, BranchSummary>
  /** Ajout additif 2026-08-05 — voir `VerdictCoverage`. `undefined` = non mesurée. */
  coverage?: VerdictCoverage
  /** Ajout additif 2026-08-05 (J4-a) — voir `VerdictAbstentions`. `undefined` = aucune
   *  branche n'a abstenu (le cas courant), donc rien à déclarer. */
  abstentions?: VerdictAbstentions
}

// ── Types internes Mango QA ──────────────────────────────────────────────────

export type BranchStatus = 'pass' | 'fail' | 'skip'

/** Fichier de projet lu (borné) et passé aux branches. */
export interface ProjectFile {
  path: string
  content: string
  /** `content` a été COUPÉ à la lecture (dépassait `MAX_FILE_CHARS`). Optionnel :
   *  absent = non coupé / information non calculée par l'appelant. */
  truncated?: boolean
  /** Taille réelle du fichier sur disque, avant toute coupe. Sert à calculer une
   *  couverture honnête (dénominateur = le code réel, pas ce qu'on a bien voulu lire). */
  fullChars?: number
}

/** Contexte d'audit fourni à chaque branche pour une phase donnée. */
export interface AuditContext {
  signal: PhaseSignal
  files: ProjectFile[]
  /** Contraintes héritées de la Boîte Noire (Retex) — erreurs passées à éviter. */
  retex: string
  /** #10 — des fichiers `*.test.*`/`*.spec.*` existent QUELQUE PART dans le
   *  projet (pas seulement dans le delta `files`/`changedFiles` de cette phase).
   *  `undefined` si non calculé (rétrocompat des appelants qui ne le fournissent
   *  pas). Sert à la branche Tests à éviter un Feu Rouge fantôme. */
  testsElsewhereInProject?: boolean
  /** Plafond de caractères de code injectés dans le prompt de CETTE branche.
   *
   *  (2026-08-08, faille L2-a) Il passait par `process.env.QA_FILE_PAYLOAD_CAP`, écrit
   *  par trois appelants. Sans conséquence pour une CLI — un process, un audit — mais
   *  le serveur MCP est LONG-VIVANT : un seul appel passant `cap` imposait sa couverture
   *  réduite à tous les suivants, et deux audits concurrents se corrompaient l'un
   *  l'autre. `undefined` → repli sur l'environnement (rétrocompatible). */
  cap?: number
  /** (2026-08-08, lot 3) Les règles que CE dépôt a écrites, localisées. `undefined` =
   *  non scanné (le chemin MangoOS ne le fournit pas) → prompt byte-identique à avant.
   *  Un scan présent mais `absent: true` est une information DIFFÉRENTE : le projet a
   *  été regardé et ne documente rien, ce qu'on dit au modèle pour qu'il n'invente pas. */
  conventions?: ConventionsScan
}

/** Ce que le modèle a RÉELLEMENT vu, mesuré au moment du rendu du prompt
 *  (J1, défaut n°2 — l'audit partiel silencieux).
 *
 *  Le cap de payload s'arrête à un fichier et abandonne les suivants : c'est un
 *  comportement légitime, mais le TAIRE ne l'est pas. Un vrai défaut situé dans
 *  la partie non lue produit un Feu Vert que rien n'indique comme partiel.
 *  Cette structure est la trace qui rend l'omission déclarable de bout en bout
 *  (prompt → finding → rapport → verdict).
 *
 *  « Un auditeur a le droit de ne pas tout lire ; il n'a pas le droit de le taire. » */
export interface AuditCoverage {
  /** Fichiers soumis au rendu (= ceux que la branche jugeait pertinents). */
  filesTotal: number
  /** Fichiers présents dans le payload, en entier OU coupés. */
  filesRendered: number
  /** Chemins jamais envoyés au modèle (le cap les a abandonnés). */
  omitted: string[]
  /** Chemins présents mais COUPÉS par le cap de payload. */
  truncated: string[]
  /** Chemins déjà coupés en amont, à la lecture disque (`MAX_FILE_CHARS`). */
  sourceTruncated: string[]
  /** Caractères de code réels (taille disque quand connue via `ProjectFile.fullChars`). */
  charsTotal: number
  /** Caractères de code effectivement injectés (hors en-têtes `----- chemin -----`). */
  charsRendered: number
  /** Vrai seulement si TOUT le code a été vu : rien d'omis, rien de coupé — ni au
   *  rendu, ni en amont à la lecture. C'est la seule valeur qui autorise un
   *  raisonnement par ABSENCE (« aucun test », « aucune validation »). */
  complete: boolean
}

/** Verdict d'une branche d'audit. */
export interface BranchFinding {
  status: BranchStatus
  summary: string
  rejectionId?: string
  correctiveAction?: string
  ruleRef?: string
  /** Couverture de lecture de CETTE branche. `undefined` = branche non-LLM ou
   *  couverture non mesurée (ne jamais lire ça comme « couverture complète »). */
  coverage?: AuditCoverage
  /** Pourquoi ce `skip`. Renseigné par tout producteur de `skip`. `undefined` sur un
   *  `skip` = cause inconnue, donc traitée comme une PANNE (voir `estPanne`) : c'est
   *  le sens prudent, celui qui ne peut pas fabriquer un faux Feu Vert. */
  abstention?: Abstention
  /** (2026-08-08, lot 3) Les règles du dépôt que cette trouvaille invoque. */
  conventions?: CitationsConventions
}

/** Ce que le modèle a cité comme règle du dépôt, **après vérification**.
 *
 *  Une citation n'est retenue que si son identifiant correspond à une règle réellement
 *  extraite d'un fichier du dépôt. Le reste part dans `rejetees` — et y reste visible.
 *  Effacer une citation inventée reviendrait à corriger la copie du modèle en silence :
 *  c'est le symptôme (J1-b) qu'il affirme un fait que la source contredit, et ce
 *  symptôme mérite d'être vu, pas nettoyé. */
export interface CitationsConventions {
  /** Identifiants `fichier:ligne` vérifiés — ils désignent une vraie ligne du dépôt. */
  citees: string[]
  /** Citations qui ne correspondent à aucune règle extraite : inventées ou déformées. */
  rejetees: string[]
}

/** Une branche d'audit (Junior Inspecteur spécialisé). */
export interface Branch {
  id: string
  label: string
  emoji: string
  /** Une branche bloquante peut déclencher un Feu Rouge ; design-system = false. */
  blocking: boolean
  /** Sélectionne les fichiers pertinents pour cette branche ([] → skip). */
  relevant(files: ProjectFile[]): ProjectFile[]
  /** Audite et renvoie un verdict de branche. Ne doit JAMAIS throw (fail-open). */
  audit(ctx: AuditContext): Promise<BranchFinding>
}
