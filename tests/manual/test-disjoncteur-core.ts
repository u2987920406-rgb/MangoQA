// Tests du Visage 1 — Le Disjoncteur : socle (sécurité de base, cumul de
// plusieurs disjoncteurs, déterminisme, signature de trip, liveness du bus).
// Exécution : npx tsx test-disjoncteur-core.ts
// Déterministe, zéro réseau, zéro LLM, zéro disque.
import { evaluateBreakers, tripSignature, cfg, FROZEN, makeEv, makeChecker } from './disjoncteur-shared.js'

const { check, report } = makeChecker('disjoncteur-core')
const ev = makeEv()

// ── Sécurité de base : flux vide / nominal ───────────────────────────────────
{
  const empty = evaluateBreakers([], cfg, { now: FROZEN })
  check('flux vide → safe', empty.safe === true)
  check('flux vide → 0 trip', empty.trips.length === 0)
  check('flux vide → evaluatedAt = horloge', empty.evaluatedAt === 1_000_000)

  const ok = [ev({ type: 't', sender: 'a', kind: 'success' }), ev({ type: 't', sender: 'a', kind: 'success' })]
  check('flux nominal → safe', evaluateBreakers(ok, cfg, { now: FROZEN }).safe === true)
}

// ── Cumul : plusieurs disjoncteurs sautent ensemble ──────────────────────────
{
  // Les 3 erreurs doivent être EN FIN de flux : un succès intercalé réarmerait
  // le circuit (c'est voulu — « cassé maintenant », pas « cassé une fois »).
  const storm = [
    ev({ type: 'qa.audit', sender: 'qa', payload: { score: 0.2 } }),
    ev({ type: 'agent', sender: 'builder', payload: { turns: 99 } }),
    ev({ type: 'task', sender: 'x', kind: 'error' }),
    ev({ type: 'task', sender: 'x', kind: 'error' }),
    ev({ type: 'task', sender: 'x', kind: 'error' }),
  ]
  const r = evaluateBreakers(storm, cfg, { now: FROZEN })
  check('tempête → non safe', r.safe === false)
  // #11 : regression-lock est INERTE par défaut (constat B) → 2 disjoncteurs
  // sautent avec la config par défaut (nightly-circuit + agent-killswitch), pas 3.
  check('tempête (défaut) → 2 disjoncteurs (regression-lock inerte)', r.trips.length === 2)

  const rEnabled = evaluateBreakers(storm, { ...cfg, regressionLockEnabled: true }, { now: FROZEN })
  check('tempête (regression-lock activé) → 3 disjoncteurs', rEnabled.trips.length === 3)
}

// ── Déterminisme : deux passes identiques ⇒ rapports identiques ───────────────
{
  const e = [ev({ type: 'qa.audit', sender: 'qa', payload: { score: 0.1 } })]
  const a = JSON.stringify(evaluateBreakers(e, cfg, { now: FROZEN }))
  const b = JSON.stringify(evaluateBreakers(e, cfg, { now: FROZEN }))
  check('même entrée ⇒ même rapport', a === b)
}

// ── Signature de trip (dédup) ────────────────────────────────────────────────
{
  const e = [ev({ type: 'agent', sender: 'builder', payload: { turns: 99 } })]
  const t = evaluateBreakers(e, cfg, { now: FROZEN }).trips[0]
  check('signature inclut breaker + subject', tripSignature(t) === 'agent-killswitch:builder')
}

// ── #11 (constat C) : liveness du Bus — flux jamais vu vs flux tari ──────────
{
  const empty = evaluateBreakers([], cfg, { now: FROZEN, busStaleThresholdMs: 1000 })
  check('#11 liveness : flux vide → pas stale (jamais démarré ≠ panne)', empty.busLiveness.stale === false)
  check('#11 liveness : flux vide → lastEventTs null', empty.busLiveness.lastEventTs === null)

  const recent = [ev({ type: 'x', sender: 'a', ts: FROZEN() - 10 })]
  const r1 = evaluateBreakers(recent, cfg, { now: FROZEN, busStaleThresholdMs: 1000 })
  check('#11 liveness : dernier event récent (< seuil) → pas stale', r1.busLiveness.stale === false)

  const old = [ev({ type: 'x', sender: 'a', ts: FROZEN() - 5000 })]
  const r2 = evaluateBreakers(old, cfg, { now: FROZEN, busStaleThresholdMs: 1000 })
  check('#11 liveness : dernier event ancien (> seuil) → stale', r2.busLiveness.stale === true)
  check('#11 liveness : ageMs cohérent', r2.busLiveness.ageMs === 5000)

  // Défaut (busStaleThresholdMs non fourni → Infinity) : jamais stale, rétrocompat.
  const r3 = evaluateBreakers(old, cfg, { now: FROZEN })
  check('#11 liveness : sans seuil (défaut Infinity) → jamais stale (rétrocompat)', r3.busLiveness.stale === false)

  // La liveness ne doit JAMAIS influencer `safe` — signal séparé des disjoncteurs.
  check('#11 liveness : stale ne change pas `safe`', r2.safe === true && r2.trips.length === 0)
}

report()
