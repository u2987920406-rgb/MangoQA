// Contrats de données Mango QA.
//
// ⚠️ Les types PhaseSignal / QAVerdict / Rejection / BranchSummary sont le
// CONTRAT FIGÉ partagé avec MangoOS (server/src/mangoqa.ts). Ne pas en changer
// la forme : MangoOS écrit phase-complete.json selon PhaseSignal et lit
// audit-verdict.json selon QAVerdict. Tout le reste est interne à Mango QA.

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

/** Verdict lu par MangoOS (mangoqa.ts → QAVerdict). CONTRAT FIGÉ. */
export interface QAVerdict {
  verdict: 'green' | 'red'
  rejection: Rejection | null
  branches: Record<string, BranchSummary>
  /** Ajout additif 2026-08-05 — voir `VerdictCoverage`. `undefined` = non mesurée. */
  coverage?: VerdictCoverage
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
