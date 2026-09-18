// Agrégation des verdicts de branches en un QAVerdict (Contrat I/O Strict).
//
// Règle : Feu Rouge (red) dès qu'UNE branche BLOQUANTE échoue. La première
// branche bloquante en échec (dans l'ordre de priorité = ordre du registre)
// devient la `rejection` injectée à MangoOS. Les branches de conseil
// (design-system) n'entrent jamais dans la décision red/green.
import type { Branch, BranchFinding, QAVerdict, Rejection } from './types.js'

export interface BranchResult {
  branch: Branch
  finding: BranchFinding
}

export function buildVerdict(results: BranchResult[], retryCount: number): QAVerdict {
  const branches: Record<string, { status: string; summary: string }> = {}
  for (const { branch, finding } of results) {
    branches[branch.id] = { status: finding.status, summary: finding.summary }
  }

  // Première branche BLOQUANTE en échec → le rejet déterministe (Degré 1).
  const firstFail = results.find(r => r.branch.blocking && r.finding.status === 'fail')

  if (!firstFail) {
    const audited = results.some(r => r.branch.blocking && r.finding.status === 'pass')
    const incomplete = results.some(r => r.branch.blocking && r.finding.status === 'skip')
    return { verdict: audited && !incomplete ? 'green' : 'unknown', rejection: null, branches }
  }

  const f = firstFail.finding
  const rejection: Rejection = {
    rejection_id: f.rejectionId ?? `${firstFail.branch.id}-anomalie`,
    corrective_action: f.correctiveAction ?? f.summary,
    rule_ref: f.ruleRef ?? firstFail.branch.id,
    branch: firstFail.branch.id,
    retry_count: retryCount,
  }
  return { verdict: 'red', rejection, branches }
}
