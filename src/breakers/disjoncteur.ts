// Mango QA — Visage 1 : LE DISJONCTEUR (cf. fondation.md §V).
//
// Réflexes de sécurité DURS. Quatre règles intouchables, gravées dans la fondation :
//   • DÉFENSIF      — il peut ARRÊTER, jamais créer ni modifier quoi que ce soit.
//   • DÉTERMINISTE  — zéro LLM dans la décision. Mêmes événements ⇒ même verdict.
//   • BORNÉ         — exactement 5 disjoncteurs, non-extensible (pas de plugin).
//   • ALERTE RAF    — il ne fait que constater et signaler ; Raf décide.
//
// Comme un disjoncteur électrique : trop simple pour être corrompu. Ce module est
// une FONCTION PURE sur un flux d'enveloppes du Bus (exporté par le pont MangoOS
// dans .mangoqa/bus-events.jsonl). Aucun accès disque, aucun réseau ici — l'I/O
// vit dans runner.ts. C'est ce qui le rend entièrement testable hors-ligne.

// ── Miroir minimal de l'Enveloppe Standard v1 (kernel-bus.ts côté MangoOS) ─────
// On ne lit que les champs nécessaires aux réflexes, et toujours défensivement :
// un champ absent n'arme jamais un disjoncteur par erreur.
export interface BusEvent {
  type: string
  sender: string
  recipient?: string
  kind?: 'success' | 'error' | 'progress' | 'request'
  payload?: unknown
  ts: number
}

// ── Les 5 disjoncteurs et leur réflexe ────────────────────────────────────────
export type BreakerId =
  | 'nightly-circuit' //   1. N échecs de suite     → pause + alerte
  | 'cost-guard' //        2. coût/nuit > plafond   → bascule full local
  | 'regression-lock' //   3. score d'audit < seuil → bloque le commit
  | 'memory-drift' //      4. magasin saturé/contra → gèle l'écriture mémoire
  | 'agent-killswitch' //  5. agent emballé         → termine l'agent proprement

export type BreakerAction =
  | 'pause-and-alert'
  | 'fallback-local'
  | 'block-commit'
  | 'freeze-memory'
  | 'terminate-agent'

/** Un disjoncteur qui a sauté : un constat déterministe, jamais une action menée. */
export interface BreakerTrip {
  breaker: BreakerId
  action: BreakerAction
  reason: string
  /** Valeur observée qui a fait sauter le disjoncteur. */
  observed: number
  /** Seuil franchi. */
  threshold: number
  /** Sujet concerné quand le réflexe est ciblé (ex. agentId pour le kill switch). */
  subject?: string
  /** ts du dernier événement ayant compté dans la décision. */
  lastEventTs: number
}

/** Rapport global : sûr tant qu'aucun disjoncteur n'a sauté. */
export interface BreakerReport {
  safe: boolean
  trips: BreakerTrip[]
  evaluatedAt: number
  eventCount: number
}

/** Seuils. Bornés et explicites — un disjoncteur n'a pas de réglage caché. */
export interface BreakerConfig {
  /** 1. échecs consécutifs tolérés avant pause. */
  maxConsecutiveFailures: number
  /** 2. plafond de coût cumulé sur la fenêtre (USD). */
  nightlyCostCeilingUsd: number
  /** 3. score d'audit minimal (0..1) sous lequel on bloque le commit. */
  minAuditScore: number
  /** 4. taille max d'un magasin mémoire avant gel. */
  maxMemoryStoreSize: number
  /** 5. bornes d'emballement d'un agent. */
  maxAgentTurns: number
  maxAgentTokens: number
  maxAgentDurationMs: number
}

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  maxConsecutiveFailures: 3,
  nightlyCostCeilingUsd: 5,
  minAuditScore: 0.6,
  maxMemoryStoreSize: 5_000,
  maxAgentTurns: 40,
  maxAgentTokens: 200_000,
  maxAgentDurationMs: 10 * 60_000,
}

export interface EvaluateOptions {
  /** Horloge (déterminisme en test). Défaut : Date.now. */
  now?: () => number
  /** Début de fenêtre pour le garde-fou coût (cumul depuis ce ts). Défaut : tout. */
  costWindowStartTs?: number
}

// ── Helpers de lecture défensive du payload ──────────────────────────────────
function field(env: BusEvent, key: string): unknown {
  const p = env.payload
  return p && typeof p === 'object' ? (p as Record<string, unknown>)[key] : undefined
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

// ── 1. Circuit breaker — N échecs de suite ───────────────────────────────────
// Compte la série d'échecs LA PLUS RÉCENTE (en partant de la fin), parmi les seuls
// événements concluants (success/error ; progress/request ignorés). Un succès
// remet le compteur à zéro : c'est « N échecs de suite », pas « N échecs en tout ».
function nightlyCircuit(events: BusEvent[], cfg: BreakerConfig): BreakerTrip | null {
  let streak = 0
  let lastTs = 0
  for (let i = events.length - 1; i >= 0; i--) {
    const k = events[i].kind
    if (k === 'success') break
    if (k === 'error') {
      if (streak === 0) lastTs = events[i].ts
      streak++
    }
  }
  if (streak < cfg.maxConsecutiveFailures) return null
  return {
    breaker: 'nightly-circuit',
    action: 'pause-and-alert',
    reason: `${streak} échecs consécutifs (seuil ${cfg.maxConsecutiveFailures}) — pause et alerte Raf.`,
    observed: streak,
    threshold: cfg.maxConsecutiveFailures,
    lastEventTs: lastTs,
  }
}

// ── 2. Garde-fou coût — escalade > plafond/nuit ──────────────────────────────
// Cumule payload.costUsd sur la fenêtre. Tout dépassement = bascule full local.
function costGuard(events: BusEvent[], cfg: BreakerConfig, windowStart: number): BreakerTrip | null {
  let sum = 0
  let lastTs = 0
  for (const env of events) {
    if (env.ts < windowStart) continue
    const c = num(field(env, 'costUsd'))
    if (c !== undefined && c > 0) {
      sum += c
      lastTs = env.ts
    }
  }
  if (sum <= cfg.nightlyCostCeilingUsd) return null
  return {
    breaker: 'cost-guard',
    action: 'fallback-local',
    reason: `Coût cumulé ${sum.toFixed(2)}$ > plafond ${cfg.nightlyCostCeilingUsd.toFixed(2)}$ — bascule cerveau local.`,
    observed: Math.round(sum * 100) / 100,
    threshold: cfg.nightlyCostCeilingUsd,
    lastEventTs: lastTs,
  }
}

// ── 3. Verrou régression — score d'audit sous seuil ──────────────────────────
// Lit le score du dernier audit publié (payload.score sur un événement qa.audit*).
// Sous le seuil = on bloque le commit. Au-dessus = on laisse passer.
function regressionLock(events: BusEvent[], cfg: BreakerConfig): BreakerTrip | null {
  let latest: { score: number; ts: number } | null = null
  for (const env of events) {
    if (!/audit/i.test(env.type)) continue
    const s = num(field(env, 'score'))
    if (s === undefined) continue
    if (!latest || env.ts >= latest.ts) latest = { score: s, ts: env.ts }
  }
  if (!latest || latest.score >= cfg.minAuditScore) return null
  return {
    breaker: 'regression-lock',
    action: 'block-commit',
    reason: `Score d'audit ${latest.score.toFixed(2)} < seuil ${cfg.minAuditScore.toFixed(2)} — commit bloqué.`,
    observed: latest.score,
    threshold: cfg.minAuditScore,
    lastEventTs: latest.ts,
  }
}

// ── 4. Détecteur de dérive mémoire — magasin saturé ou contradictoire ────────
// Saute si un magasin dépasse sa taille max (payload.storeSize) ou si un événement
// signale une contradiction (payload.contradiction === true) → gèle l'écriture.
function memoryDrift(events: BusEvent[], cfg: BreakerConfig): BreakerTrip | null {
  let worst: { size: number; ts: number; store?: string } | null = null
  let contradiction: { ts: number; store?: string } | null = null
  for (const env of events) {
    const size = num(field(env, 'storeSize'))
    if (size !== undefined && (!worst || size > worst.size)) {
      worst = { size, ts: env.ts, store: (field(env, 'store') as string) || undefined }
    }
    if (field(env, 'contradiction') === true) contradiction = { ts: env.ts, store: (field(env, 'store') as string) || undefined }
  }
  if (contradiction) {
    return {
      breaker: 'memory-drift',
      action: 'freeze-memory',
      reason: `Contradiction détectée dans le magasin${contradiction.store ? ` « ${contradiction.store} »` : ''} — écriture gelée.`,
      observed: 1,
      threshold: 0,
      subject: contradiction.store,
      lastEventTs: contradiction.ts,
    }
  }
  if (worst && worst.size > cfg.maxMemoryStoreSize) {
    return {
      breaker: 'memory-drift',
      action: 'freeze-memory',
      reason: `Magasin${worst.store ? ` « ${worst.store} »` : ''} saturé : ${worst.size} > ${cfg.maxMemoryStoreSize} — écriture gelée.`,
      observed: worst.size,
      threshold: cfg.maxMemoryStoreSize,
      subject: worst.store,
      lastEventTs: worst.ts,
    }
  }
  return null
}

// ── 5. Kill switch agent — agent emballé (tours / temps / tokens) ────────────
// Par émetteur, retient le MAX des compteurs cumulés rapportés (turns/tokens/
// durationMs). Tout dépassement = un trip ciblé sur cet agent (terminaison propre).
function agentKillswitch(events: BusEvent[], cfg: BreakerConfig): BreakerTrip[] {
  interface Acc {
    turns: number
    tokens: number
    durationMs: number
    lastTs: number
  }
  const per = new Map<string, Acc>()
  for (const env of events) {
    const turns = num(field(env, 'turns'))
    const tokens = num(field(env, 'tokens'))
    const durationMs = num(field(env, 'durationMs'))
    if (turns === undefined && tokens === undefined && durationMs === undefined) continue
    const a = per.get(env.sender) ?? { turns: 0, tokens: 0, durationMs: 0, lastTs: 0 }
    if (turns !== undefined) a.turns = Math.max(a.turns, turns)
    if (tokens !== undefined) a.tokens = Math.max(a.tokens, tokens)
    if (durationMs !== undefined) a.durationMs = Math.max(a.durationMs, durationMs)
    a.lastTs = Math.max(a.lastTs, env.ts)
    per.set(env.sender, a)
  }
  const trips: BreakerTrip[] = []
  for (const [sender, a] of per) {
    let observed: number | null = null
    let threshold = 0
    let what = ''
    if (a.turns > cfg.maxAgentTurns) {
      observed = a.turns
      threshold = cfg.maxAgentTurns
      what = `${a.turns} tours`
    } else if (a.tokens > cfg.maxAgentTokens) {
      observed = a.tokens
      threshold = cfg.maxAgentTokens
      what = `${a.tokens} tokens`
    } else if (a.durationMs > cfg.maxAgentDurationMs) {
      observed = a.durationMs
      threshold = cfg.maxAgentDurationMs
      what = `${Math.round(a.durationMs / 1000)}s`
    }
    if (observed === null) continue
    trips.push({
      breaker: 'agent-killswitch',
      action: 'terminate-agent',
      reason: `Agent « ${sender} » emballé (${what} > seuil ${threshold}) — terminaison propre.`,
      observed,
      threshold,
      subject: sender,
      lastEventTs: a.lastTs,
    })
  }
  // Ordre déterministe (les Map itèrent en ordre d'insertion, mais on stabilise).
  trips.sort((x, y) => (x.subject! < y.subject! ? -1 : x.subject! > y.subject! ? 1 : 0))
  return trips
}

// ── Évaluation globale ───────────────────────────────────────────────────────
/** Passe le flux d'événements dans les 5 disjoncteurs. Pur et déterministe :
 * mêmes événements + même config ⇒ même rapport. */
export function evaluateBreakers(
  events: BusEvent[],
  cfg: BreakerConfig = DEFAULT_BREAKER_CONFIG,
  opts: EvaluateOptions = {},
): BreakerReport {
  const now = opts.now ?? (() => Date.now())
  const windowStart = opts.costWindowStartTs ?? -Infinity
  const trips: BreakerTrip[] = []

  const t1 = nightlyCircuit(events, cfg)
  if (t1) trips.push(t1)
  const t2 = costGuard(events, cfg, windowStart)
  if (t2) trips.push(t2)
  const t3 = regressionLock(events, cfg)
  if (t3) trips.push(t3)
  const t4 = memoryDrift(events, cfg)
  if (t4) trips.push(t4)
  trips.push(...agentKillswitch(events, cfg))

  return {
    safe: trips.length === 0,
    trips,
    evaluatedAt: now(),
    eventCount: events.length,
  }
}

/** Signature stable d'un trip (dédup d'une alerte qui reste levée d'un cycle à l'autre). */
export function tripSignature(t: BreakerTrip): string {
  return `${t.breaker}:${t.subject ?? ''}`
}
