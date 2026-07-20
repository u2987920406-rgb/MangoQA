// Mango QA — Visage 2 : l'Observateur-Conseil (amorce, #R-bonus).
//
// Rôle prévu par fondation.md (§ Visage 2) : lire l'historique des audits (verdicts/rejets)
// dans la durée, détecter les PATTERNS de défaillance récurrents (« 40% des audits échouent
// sur la même branche X »), et PROPOSER des suggestions à Raf. Jamais d'action — Raf décide,
// MangoOS évolue. C'est la boucle méta : Mango QA aide MangoOS à s'améliorer sans le toucher.
//
// Ce module est PUR (zéro I/O, zéro LLM, zéro horloge) : les événements sont INJECTÉS par
// l'appelant (ex. le Retex existant — retex.ts — ou tout futur historique de verdicts). Il
// n'est PAS câblé dans le runtime (orchestrator.ts / index.ts) : amorce délibérément non
// branchée, pour rester sûre (cf. consigne de la session — juste le module + son test).

/** Un événement d'audit passé (forme minimale, dérivable du Retex ou de l'historique de
 *  verdicts). Ne contient QUE ce qui sert à détecter des patterns — pas le contrat figé
 *  QAVerdict (types.ts) que MangoOS lit, pour ne pas coupler l'Observateur à ce contrat. */
export interface ObserverEvent {
  /** ISO 8601. Utilisé pour la fenêtre glissante (ObserverOptions.windowDays) — un `ts`
   *  invalide/absent-de-fenêtre exclut simplement l'événement de l'analyse (best-effort,
   *  jamais une exception, cohérent avec le mapping tolérant de mapRetexToObserverEvents). */
  ts: string
  projectName: string
  phase: string
  /** Branche d'audit ayant motivé le Feu Rouge (architecture, security, …). */
  branch: string
  /** Identifiant court de la règle enfreinte (ex. "missing-form-label"). */
  rejectionId: string
  ruleRef: string
}

export type ObserverPatternKind = 'branche-recurrente' | 'regle-recurrente' | 'projet-recurrent'

export interface ObserverPattern {
  kind: ObserverPatternKind
  /** Le nom du groupe concerné (branche, règle, ou projet). */
  subject: string
  count: number
  /** Part du total des événements analysés (0..1). */
  share: number
  /** Quelques rejectionId/ruleRef d'exemple, pour que Raf retrouve le contexte. */
  examples: string[]
}

export interface ObserverReport {
  totalEvents: number
  patterns: ObserverPattern[]
  /** Une phrase de suggestion par pattern retenu — jamais une action, toujours une proposition. */
  suggestions: string[]
  summary: string
}

export interface ObserverOptions {
  /** Occurrences minimales pour qu'un pattern soit retenu (évite le bruit sur peu de données). */
  minCount?: number
  /** Part minimale (0..1) du total pour qu'un pattern soit retenu. */
  minShare?: number
  /** Nombre max de patterns retenus, PAR catégorie (branche / règle / projet). */
  topN?: number
  /** Exemples affichés par pattern retenu. */
  examplesPerPattern?: number
  /** Taille de la fenêtre glissante en jours. Sans effet si `now` n'est pas fourni (module
   *  pur — pas d'horloge implicite) : dans ce cas l'agrégation reste globale, comme avant. */
  windowDays?: number
  /** Instant de référence ISO 8601 pour la fenêtre glissante — fourni par l'appelant
   *  (ex. observer-runner.ts) pour que le module reste déterministe et testable. */
  now?: string
}

const DEFAULT_OPTIONS: Required<Omit<ObserverOptions, 'now'>> & { now?: string } = {
  minCount: 2,
  minShare: 0.2,
  topN: 3,
  examplesPerPattern: 3,
  windowDays: 0,
  now: undefined,
}

/** Ne garde que les événements dans [now - windowDays, now]. Un `ts` illisible exclut
 *  l'événement (best-effort). Pas de fenêtre (windowDays<=0 ou now absent) → identité. */
function applyWindow(events: ObserverEvent[], windowDays: number, now: string | undefined): ObserverEvent[] {
  if (!windowDays || windowDays <= 0 || !now) return events
  const nowMs = new Date(now).getTime()
  if (Number.isNaN(nowMs)) return events
  const sinceMs = nowMs - windowDays * 24 * 60 * 60 * 1000
  return events.filter((e) => {
    const t = new Date(e.ts).getTime()
    return !Number.isNaN(t) && t >= sinceMs && t <= nowMs
  })
}

interface Bucket {
  subject: string
  count: number
  examples: string[]
}

/** Regroupe des événements par une clé (branche / règle / projet), en conservant quelques
 *  exemples d'identifiants de règle pour le contexte. */
function bucketBy(events: ObserverEvent[], key: (e: ObserverEvent) => string, examplesPerPattern: number): Bucket[] {
  const byKey = new Map<string, Bucket>()
  for (const e of events) {
    const k = key(e)
    if (!k) continue
    let b = byKey.get(k)
    if (!b) {
      b = { subject: k, count: 0, examples: [] }
      byKey.set(k, b)
    }
    b.count++
    if (b.examples.length < examplesPerPattern && !b.examples.includes(e.rejectionId)) {
      b.examples.push(e.rejectionId)
    }
  }
  return [...byKey.values()]
}

/** Ne retient que les buckets au-dessus des seuils, triés par part décroissante, bornés à `topN`. */
function toPatterns(
  buckets: Bucket[],
  kind: ObserverPatternKind,
  total: number,
  opts: Pick<Required<ObserverOptions>, 'minCount' | 'minShare' | 'topN'>,
): ObserverPattern[] {
  return buckets
    .map((b) => ({ kind, subject: b.subject, count: b.count, share: total > 0 ? b.count / total : 0, examples: b.examples }))
    .filter((p) => p.count >= opts.minCount && p.share >= opts.minShare)
    .sort((a, b) => b.share - a.share || b.count - a.count)
    .slice(0, opts.topN)
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`
}

function suggestionFor(p: ObserverPattern): string {
  const ex = p.examples.length ? ` (ex. ${p.examples.join(', ')})` : ''
  switch (p.kind) {
    case 'branche-recurrente':
      return `${pct(p.share)} des rejets (${p.count}) tombent sur la branche « ${p.subject} »${ex} — envisager de renforcer cette branche ou de vérifier si la règle est trop stricte.`
    case 'regle-recurrente':
      return `La règle « ${p.subject} » revient dans ${pct(p.share)} des rejets (${p.count})${ex} — un correctif systémique (au lieu d'un retry par retry) réglerait peut-être la cause racine.`
    case 'projet-recurrent':
      return `Le projet « ${p.subject} » concentre ${pct(p.share)} des rejets (${p.count})${ex} — vérifier si ce projet a une contrainte particulière (stack, brief, complexité) qui explique la récurrence.`
  }
}

/** Analyse un historique d'événements (déterministe, zéro I/O) et détecte les patterns de
 *  défaillance récurrents. Ne bloque jamais, ne modifie rien : renvoie un RAPPORT à lire. */
export function analyzeEvents(events: ObserverEvent[], options: ObserverOptions = {}): ObserverReport {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const windowed = applyWindow(events, opts.windowDays, opts.now)
  const total = windowed.length

  if (total === 0) {
    const reason = events.length > 0 && windowed.length === 0
      ? `Aucun événement dans la fenêtre des ${opts.windowDays} derniers jours (${events.length} au total hors fenêtre).`
      : 'Aucun événement à analyser — historique vide.'
    return { totalEvents: 0, patterns: [], suggestions: [], summary: reason }
  }

  const byBranch = toPatterns(bucketBy(windowed, (e) => e.branch, opts.examplesPerPattern), 'branche-recurrente', total, opts)
  const byRule = toPatterns(bucketBy(windowed, (e) => e.ruleRef, opts.examplesPerPattern), 'regle-recurrente', total, opts)
  const byProject = toPatterns(bucketBy(windowed, (e) => e.projectName, opts.examplesPerPattern), 'projet-recurrent', total, opts)

  const patterns = [...byBranch, ...byRule, ...byProject]
  const suggestions = patterns.map(suggestionFor)

  const windowNote = opts.windowDays > 0 && opts.now ? ` (fenêtre ${opts.windowDays}j)` : ''
  const summary =
    patterns.length === 0
      ? `${total} événement(s) analysé(s)${windowNote} — aucun pattern récurrent au-dessus du seuil (bruit normal).`
      : `${total} événement(s) analysé(s)${windowNote} — ${patterns.length} pattern(s) récurrent(s) détecté(s).`

  return { totalEvents: total, patterns, suggestions, summary }
}

/** Met en forme un rapport en texte lisible pour Raf (jamais une action — une proposition). */
export function renderObserverReport(report: ObserverReport): string {
  const lines: string[] = [`Observateur-Conseil — ${report.summary}`]
  if (report.suggestions.length > 0) {
    lines.push('')
    for (const s of report.suggestions) lines.push(`- ${s}`)
  }
  return lines.join('\n')
}
