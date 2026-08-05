// Agrégation des verdicts de branches en un QAVerdict (Contrat I/O Strict).
//
// Règle : Feu Rouge (red) dès qu'UNE branche BLOQUANTE échoue. La première
// branche bloquante en échec (dans l'ordre de priorité = ordre du registre)
// devient la `rejection` injectée à MangoOS. Les branches de conseil
// (design-system) n'entrent jamais dans la décision red/green.
import type { Branch, BranchFinding, QAVerdict, Rejection, VerdictCoverage } from './types.js'

export interface BranchResult {
  branch: Branch
  finding: BranchFinding
}

/** Mention recopiée EN CLAIR dans le résumé d'une branche à lecture partielle.
 *  Le champ structuré `QAVerdict.coverage` est la source de vérité ; ce texte
 *  existe pour qu'un affichage non mis à jour (console, log, MangoOS) ne puisse
 *  pas présenter un verdict partiel comme un verdict complet. */
function partialMention(filesRendered: number, filesTotal: number): string {
  return ` [lecture partielle : ${filesRendered}/${filesTotal} fichiers audités]`
}

export function buildVerdict(results: BranchResult[], retryCount: number): QAVerdict {
  const branches: Record<string, { status: string; summary: string }> = {}
  const partial: VerdictCoverage['partial'] = []
  let measured = false
  for (const { branch, finding } of results) {
    const cov = finding.coverage
    if (cov) measured = true
    const incomplete = cov !== undefined && !cov.complete
    if (incomplete) {
      partial.push({ branch: branch.id, filesRendered: cov.filesRendered, filesTotal: cov.filesTotal })
    }
    branches[branch.id] = {
      status: finding.status,
      summary: incomplete ? finding.summary + partialMention(cov.filesRendered, cov.filesTotal) : finding.summary,
    }
  }
  // Aucune branche n'a mesuré sa couverture → champ ABSENT, jamais `complete: true`.
  // « Non mesuré » et « tout lu » sont deux choses différentes ; les confondre est
  // exactement le mensonge par omission que ce champ existe pour empêcher.
  const coverage: VerdictCoverage | undefined = measured
    ? { complete: partial.length === 0, partial }
    : undefined

  // Première branche BLOQUANTE en échec → le rejet déterministe (Degré 1).
  const firstFail = results.find(r => r.branch.blocking && r.finding.status === 'fail')

  if (!firstFail) {
    // Un Feu Vert à couverture partielle reste un Feu Vert (le contrat figé n'a que
    // deux états) — mais il ne part plus SANS le dire : `coverage.partial` le porte.
    return { verdict: 'green', rejection: null, branches, ...(coverage ? { coverage } : {}) }
  }

  const f = firstFail.finding
  const rejection: Rejection = {
    rejection_id: f.rejectionId ?? `${firstFail.branch.id}-anomalie`,
    corrective_action: f.correctiveAction ?? f.summary,
    rule_ref: f.ruleRef ?? firstFail.branch.id,
    branch: firstFail.branch.id,
    retry_count: retryCount,
  }
  return { verdict: 'red', rejection, branches, ...(coverage ? { coverage } : {}) }
}
