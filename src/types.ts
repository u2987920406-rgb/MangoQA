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

/** Verdict lu par MangoOS (mangoqa.ts → QAVerdict). CONTRAT FIGÉ. */
export interface QAVerdict {
  signalTimestamp?: string
  verdict: 'green' | 'red' | 'unknown'
  rejection: Rejection | null
  branches: Record<string, BranchSummary>
}

// ── Types internes Mango QA ──────────────────────────────────────────────────

export type BranchStatus = 'pass' | 'fail' | 'skip' | 'not_applicable'

/** Fichier de projet lu (borné) et passé aux branches. */
export interface ProjectFile {
  path: string
  content: string
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

/** Verdict d'une branche d'audit. */
export interface BranchFinding {
  status: BranchStatus
  summary: string
  rejectionId?: string
  correctiveAction?: string
  ruleRef?: string
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
