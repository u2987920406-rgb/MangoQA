// Agrégation des verdicts de branches en un QAVerdict (Contrat I/O Strict).
//
// Règle : Feu Rouge (red) dès qu'UNE branche BLOQUANTE échoue. La première
// branche bloquante en échec (dans l'ordre de priorité = ordre du registre)
// devient la `rejection` injectée à MangoOS. Les branches de conseil
// (design-system) n'entrent jamais dans la décision red/green.
import type {
  Abstention,
  Branch,
  BranchFinding,
  CauseAbstention,
  QAVerdict,
  Rejection,
  VerdictAbstentions,
  VerdictCoverage,
} from './types.js'

export interface BranchResult {
  branch: Branch
  finding: BranchFinding
}

/** Les causes d'abstention qui signent une PANNE de l'auditeur — celles qui
 *  interdisent de lire un `skip` comme « rien à signaler ». Source unique : dupliquer
 *  cette liste, c'est se garantir qu'une des deux copies oubliera une cause le jour
 *  où on en ajoute une. */
export const CAUSES_PANNE: readonly CauseAbstention[] = [
  'reponse-illisible',
  'cerveau-injoignable',
  'cause-inconnue',
]

/** Vrai si cette abstention est une panne de l'auditeur, par opposition à un jugement
 *  rendu (`hors-perimetre`, `juge-sans-avis`).
 *
 *  `undefined` → `true`. C'est le choix décisif de ce module : un `skip` de cause
 *  INCONNUE est traité comme une panne, jamais comme un jugement. Même règle que
 *  `coverage.complete`, qui n'est jamais vrai par défaut — l'optimisme par défaut est
 *  exactement le défaut qu'on corrige ici. Conséquence assumée : un producteur de
 *  `skip` qui oublierait de renseigner `abstention` fait bruire l'alarme au lieu de
 *  l'éteindre. C'est le bon sens de l'erreur. */
export function estPanne(a: Abstention | undefined): boolean {
  return a === undefined || CAUSES_PANNE.includes(a.cause)
}

/** Un Feu Vert est-il en réalité un NON-VERDICT ?
 *
 *  Vrai quand le contrat figé dit `green` alors qu'une branche bloquante n'a pas pu
 *  juger. Les trois surfaces de présentation (CLI, MCP, harnais d'éval) et le code de
 *  sortie doivent trancher **identiquement** : une seule d'entre elles qui oublierait
 *  la condition réafficherait « FEU VERT » sur un audit qui n'a pas eu lieu — le
 *  défaut J4-a réintroduit par la présentation.
 *
 *  Un ROUGE n'est jamais dégradé : un défaut TROUVÉ est un fait, et le silence d'une
 *  branche voisine ne l'annule pas. Seul le vert affirme une absence, donc seul le
 *  vert peut mentir ici.
 *
 *  (Défaut trouvé par Mango QA sur son propre diff, 2026-08-05 : la règle avait été
 *  recopiée à l'identique dans trois surfaces. Elle vit désormais ici, une fois.) */
export function estNonVerifie(verdict: 'green' | 'red', jugementComplet: boolean): boolean {
  return verdict === 'green' && !jugementComplet
}

/** Libellés lisibles des causes de panne — repris tels quels par la CLI, MCP et le
 *  `summary` recopié en clair. Un seul endroit à traduire. */
export const LIBELLE_CAUSE: Record<CauseAbstention, string> = {
  'hors-perimetre': 'aucun fichier dans son domaine',
  'juge-sans-avis': 'le juge a répondu « sans avis »',
  'reponse-illisible': "le cerveau n'a pas tenu le contrat JSON",
  'cerveau-injoignable': "le cerveau n'a pas répondu",
  'cause-inconnue': 'abstention sans motif déclaré',
}

/** Mention recopiée EN CLAIR dans le résumé d'une branche à lecture partielle.
 *  Le champ structuré `QAVerdict.coverage` est la source de vérité ; ce texte
 *  existe pour qu'un affichage non mis à jour (console, log, MangoOS) ne puisse
 *  pas présenter un verdict partiel comme un verdict complet. */
function partialMention(filesRendered: number, filesTotal: number): string {
  return ` [lecture partielle : ${filesRendered}/${filesTotal} fichiers audités]`
}

/** Mention recopiée EN CLAIR dans le résumé d'une branche qui n'a PAS PU juger.
 *  Même raison d'être que `partialMention` : le champ structuré est la source de
 *  vérité, ce texte existe pour qu'un affichage non mis à jour ne puisse pas
 *  présenter une panne comme un « rien à signaler ». */
function abstentionMention(cause: CauseAbstention): string {
  return ` [NON JUGÉ — ${LIBELLE_CAUSE[cause]}]`
}

export function buildVerdict(results: BranchResult[], retryCount: number): QAVerdict {
  const branches: Record<string, { status: string; summary: string }> = {}
  const partial: VerdictCoverage['partial'] = []
  const nonJugees: VerdictAbstentions['nonJugees'] = []
  let measured = false
  for (const { branch, finding } of results) {
    const cov = finding.coverage
    if (cov) measured = true
    const incomplete = cov !== undefined && !cov.complete
    if (incomplete) {
      partial.push({ branch: branch.id, filesRendered: cov.filesRendered, filesTotal: cov.filesTotal })
    }
    // Une PANNE ne se lit que sur un `skip` : un `pass` ou un `fail` est, par
    // construction, un jugement rendu.
    const panne = finding.status === 'skip' && estPanne(finding.abstention)
    const cause: CauseAbstention = finding.abstention?.cause ?? 'cause-inconnue'
    if (panne) nonJugees.push({ branch: branch.id, cause, blocking: branch.blocking })
    let summary = finding.summary
    if (incomplete) summary += partialMention(cov.filesRendered, cov.filesTotal)
    if (panne) summary += abstentionMention(cause)
    branches[branch.id] = { status: finding.status, summary }
  }
  // Champ ABSENT quand rien n'a abstenu — le cas courant, où il n'y a rien à
  // déclarer. Dès qu'une branche n'a pas pu juger, le champ existe et le dit.
  const abstentions: VerdictAbstentions | undefined =
    nonJugees.length > 0 ? { jugementComplet: !nonJugees.some(b => b.blocking), nonJugees } : undefined
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
    // Même raisonnement pour les abstentions : `verdict` reste `green` pour que
    // l'intégration MangoOS ne soit jamais bloquée par une panne de Mango QA
    // (fail-open, invariant), et `abstentions` interdit de lire ce vert comme une
    // vérification. Les surfaces autonomes (CLI, MCP) s'appuient dessus pour refuser
    // d'afficher « Feu Vert » et pour rendre un code de sortie distinct.
    return {
      verdict: 'green',
      rejection: null,
      branches,
      ...(coverage ? { coverage } : {}),
      ...(abstentions ? { abstentions } : {}),
    }
  }

  const f = firstFail.finding
  const rejection: Rejection = {
    rejection_id: f.rejectionId ?? `${firstFail.branch.id}-anomalie`,
    corrective_action: f.correctiveAction ?? f.summary,
    rule_ref: f.ruleRef ?? firstFail.branch.id,
    branch: firstFail.branch.id,
    retry_count: retryCount,
  }
  return {
    verdict: 'red',
    rejection,
    branches,
    ...(coverage ? { coverage } : {}),
    ...(abstentions ? { abstentions } : {}),
  }
}
