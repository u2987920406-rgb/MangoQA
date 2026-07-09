// Tests du Visage 1 — Le Disjoncteur : memory-drift (dérive mémoire).
// Exécution : npx tsx test-disjoncteur-memory.ts
// Déterministe, zéro réseau, zéro LLM, zéro disque.
import { evaluateBreakers, cfg, FROZEN, makeEv, tripIds, makeChecker } from './disjoncteur-shared.js'

const { check, report } = makeChecker('disjoncteur-memory')
const ev = makeEv()

// ── 4. Dérive mémoire ────────────────────────────────────────────────────────
{
  const small = [ev({ type: 'memory.write', sender: 'core', payload: { storeSize: 100, store: 'skills' } })]
  check('magasin 100 < max → pas de trip', !tripIds(small).includes('memory-drift'))

  const saturated = [ev({ type: 'memory.write', sender: 'core', payload: { storeSize: 9999, store: 'skills' } })]
  check('magasin saturé > 5000 → trip', tripIds(saturated).includes('memory-drift'))

  const contra = [ev({ type: 'memory.write', sender: 'core', payload: { contradiction: true, store: 'axiomes' } })]
  const rc = evaluateBreakers(contra, cfg, { now: FROZEN })
  const tc = rc.trips.find(x => x.breaker === 'memory-drift')!
  check('contradiction → trip', !!tc)
  check('memory-drift → action freeze-memory', tc.action === 'freeze-memory')
  check('memory-drift → subject = magasin', tc.subject === 'axiomes')
}

report()
