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
    const blocking = results.filter(r => r.branch.blocking)
    const audited = blocking.some(r => r.finding.status === 'pass')
    // D3 (audit 2026-09-28, B2) — durcissement de la règle verte.
    //
    // `not_applicable` recouvre deux situations OPPOSÉES : « il n'y avait rien à voir
    // ici » (inoffensif — un projet statique n'a pas de logique à tester) et « je n'ai
    // rien pu voir » (un TROU dans l'audit). Les confondre laissait une seule branche
    // bloquante en `pass` peindre tout le projet en vert : le faux positif rassurant de
    // B2 (preuve : galerie-albatre — verdict `green` alors que l'architecture écrivait
    // elle-même « le code fourni (App.jsx tronqué) ne contient pas d'éléments auditable »).
    //
    // La condition est donc une MAJORITÉ, pas une existence — c'est la lettre de l'audit
    // (« un projet où presque rien n'a été vu ») et ça préserve le cas légitime :
    //   • 1 conclu / 1 muet  → pas de majorité muette → `green` (projet statique : OK)
    //   • 0 conclu / 1 muet  → majorité muette        → `unknown` (rien n'a été jugé)
    //   • 2 conclu / 3 muets → majorité muette        → `unknown` (galerie-albatre)
    // Un `skip` reste bloquant même en minorité : il signale une PANNE ou un doute
    // (transport, couverture partielle), pas une absence de sujet — c'est B1.
    const muettes = blocking.filter(
      r => r.finding.status === 'skip' || r.finding.status === 'not_applicable',
    ).length
    const conclu = blocking.length - muettes
    const incomplete =
      blocking.some(r => r.finding.status === 'skip') || // panne/doute → toujours bloquant
      muettes > conclu // la majorité n'a pas jugé → on ne peut pas dire « vert »
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
