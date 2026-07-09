// Tests du Visage 1 — Le Disjoncteur : agent-killswitch (kill switch agent,
// y compris la staleness #L70 mesurée directement via evaluateBreakers).
// Exécution : npx tsx test-disjoncteur-killswitch.ts
// Déterministe, zéro réseau, zéro LLM, zéro disque.
import { evaluateBreakers, cfg, FROZEN, makeEv, tripIds, makeChecker } from './disjoncteur-shared.js'

const { check, report } = makeChecker('disjoncteur-killswitch')
const ev = makeEv()

// ── 5. Kill switch agent ─────────────────────────────────────────────────────
{
  const calm = [ev({ type: 'agent', sender: 'builder', payload: { turns: 5, tokens: 1000, durationMs: 2000 } })]
  check('agent calme → pas de trip', !tripIds(calm).includes('agent-killswitch'))

  const runaway = [ev({ type: 'agent', sender: 'builder', payload: { turns: 99 } })]
  check('agent à 99 tours > 40 → trip', tripIds(runaway).includes('agent-killswitch'))

  // Ciblage : seul l'agent emballé est visé, pas l'autre.
  const mixed = [
    ev({ type: 'agent', sender: 'builder', payload: { turns: 99 } }),
    ev({ type: 'agent', sender: 'design', payload: { turns: 3 } }),
    ev({ type: 'agent', sender: 'vision', payload: { tokens: 500_000 } }),
  ]
  const rm = evaluateBreakers(mixed, cfg, { now: FROZEN })
  const ks = rm.trips.filter(t => t.breaker === 'agent-killswitch')
  check('2 agents emballés → 2 trips', ks.length === 2)
  check('subjects = builder + vision (triés)', ks[0].subject === 'builder' && ks[1].subject === 'vision')
  check('design (calme) non visé', !ks.some(t => t.subject === 'design'))

  // Le MAX des compteurs cumulés est retenu sur plusieurs événements du même agent.
  const cumulative = [
    ev({ type: 'agent', sender: 'builder', payload: { turns: 10 } }),
    ev({ type: 'agent', sender: 'builder', payload: { turns: 45 } }),
  ]
  check('max cumulé (45 > 40) → trip', tripIds(cumulative).includes('agent-killswitch'))
}

// ── #L70 : kill switch — agent PÉRIMÉ ignoré, agent RÉCENT toujours déclenché ─
{
  const NOW = () => 10_000_000
  const STALE = 30 * 60_000
  // Agent emballé (99 tours) mais dernier événement très ancien → périmé → PAS de trip.
  const stale = [ev({ type: 'agent', sender: 'vieux', ts: 1_000, payload: { turns: 99 } })]
  check('#L70 agent périmé (staleness) → pas de kill switch',
    !evaluateBreakers(stale, cfg, { now: NOW, agentStalenessMs: STALE }).trips.some(t => t.breaker === 'agent-killswitch'))
  // Sans staleness (défaut Infinity) → trip (rétrocompat : comportement historique préservé).
  check('#L70 sans staleness (Infinity) → trip (rétrocompat)',
    evaluateBreakers(stale, cfg, { now: NOW }).trips.some(t => t.breaker === 'agent-killswitch'))
  // Agent emballé RÉCENT (dans la fenêtre) → trip malgré la staleness.
  const fresh = [ev({ type: 'agent', sender: 'actif', ts: 10_000_000 - 1_000, payload: { turns: 99 } })]
  check('#L70 agent récent → trip malgré staleness',
    evaluateBreakers(fresh, cfg, { now: NOW, agentStalenessMs: STALE }).trips.some(t => t.breaker === 'agent-killswitch'))
}

report()
