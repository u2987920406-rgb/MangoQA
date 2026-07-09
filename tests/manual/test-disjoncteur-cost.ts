// Tests du Visage 1 — Le Disjoncteur : cost-guard (garde-fou coût).
// Exécution : npx tsx test-disjoncteur-cost.ts
// Déterministe, zéro réseau, zéro LLM, zéro disque.
import { evaluateBreakers, cfg, FROZEN, makeEv, tripIds, makeChecker } from './disjoncteur-shared.js'

const { check, report } = makeChecker('disjoncteur-cost')
const ev = makeEv()

// ── 2. Garde-fou coût ────────────────────────────────────────────────────────
{
  const cheap = [ev({ type: 'llm', sender: 'brain', payload: { costUsd: 2 } })]
  check('coût 2$ < plafond 5$ → pas de trip', !tripIds(cheap).includes('cost-guard'))

  const pricey = [
    ev({ type: 'llm', sender: 'brain', payload: { costUsd: 3 } }),
    ev({ type: 'llm', sender: 'brain', payload: { costUsd: 2.5 } }),
  ]
  check('coût cumulé 5.5$ > plafond → trip', tripIds(pricey).includes('cost-guard'))

  const r = evaluateBreakers(pricey, cfg, { now: FROZEN })
  const t = r.trips.find(x => x.breaker === 'cost-guard')!
  check('cost-guard → action fallback-local', t.action === 'fallback-local')
  check('cost-guard → observed = 5.5', t.observed === 5.5)

  // Fenêtre : un coût antérieur au début de fenêtre est ignoré.
  const windowed = [
    { ...ev({ type: 'llm', sender: 'brain', payload: { costUsd: 10 } }), ts: 5 },
    { ...ev({ type: 'llm', sender: 'brain', payload: { costUsd: 1 } }), ts: 100 },
  ]
  check(
    'coût hors fenêtre ignoré → pas de trip',
    !tripIds(windowed, cfg, { costWindowStartTs: 50 }).includes('cost-guard'),
  )
}

report()
