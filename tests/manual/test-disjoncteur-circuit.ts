// Tests du Visage 1 — Le Disjoncteur : nightly-circuit (N échecs de suite,
// comptage par sender/projet). Exécution : npx tsx test-disjoncteur-circuit.ts
// Déterministe, zéro réseau, zéro LLM, zéro disque.
import { evaluateBreakers, cfg, FROZEN, makeEv, tripIds, makeChecker } from './disjoncteur-shared.js'

const { check, report } = makeChecker('disjoncteur-circuit')
const ev = makeEv()

// ── 1. Circuit breaker — N échecs de suite ───────────────────────────────────
{
  const e = [
    ev({ type: 'task', sender: 'x', kind: 'error' }),
    ev({ type: 'task', sender: 'x', kind: 'error' }),
    ev({ type: 'task', sender: 'x', kind: 'error' }),
  ]
  check('3 échecs de suite → trip', tripIds(e).includes('nightly-circuit'))

  const reset = [
    ev({ type: 'task', sender: 'x', kind: 'error' }),
    ev({ type: 'task', sender: 'x', kind: 'error' }),
    ev({ type: 'task', sender: 'x', kind: 'success' }), // remet à zéro
    ev({ type: 'task', sender: 'x', kind: 'error' }),
  ]
  check('succès intercalé remet le compteur → pas de trip', !tripIds(reset).includes('nightly-circuit'))

  const two = [ev({ type: 'task', sender: 'x', kind: 'error' }), ev({ type: 'task', sender: 'x', kind: 'error' })]
  check('2 échecs < seuil 3 → pas de trip', !tripIds(two).includes('nightly-circuit'))

  // progress/request n'interrompent pas la série mais ne comptent pas non plus.
  const withNoise = [
    ev({ type: 'task', sender: 'x', kind: 'error' }),
    ev({ type: 'task', sender: 'x', kind: 'progress' }),
    ev({ type: 'task', sender: 'x', kind: 'error' }),
    ev({ type: 'task', sender: 'x', kind: 'error' }),
  ]
  check('progress n’interrompt pas la série → trip', tripIds(withNoise).includes('nightly-circuit'))
}

// ── #11 (constat A) : comptage PAR sender/projet, pas global ────────────────
{
  // Projet A enchaîne 3 échecs ; un SUCCÈS du projet B, entrelacé, ne doit PAS
  // remettre à zéro la série du projet A (c'était le bug avant #11).
  const interleaved = [
    ev({ type: 'task', sender: 'projet-A', kind: 'error' }),
    ev({ type: 'task', sender: 'projet-B', kind: 'success' }),
    ev({ type: 'task', sender: 'projet-A', kind: 'error' }),
    ev({ type: 'task', sender: 'projet-B', kind: 'success' }),
    ev({ type: 'task', sender: 'projet-A', kind: 'error' }),
  ]
  const r = evaluateBreakers(interleaved, cfg, { now: FROZEN })
  const trip = r.trips.find(t => t.breaker === 'nightly-circuit')
  check('#11 sender entrelacé : projet A en échec chronique → trip malgré succès de B', !!trip)
  check('#11 sender entrelacé : trip ciblé sur projet-A', trip?.subject === 'projet-A')

  // Projet B, lui, reste sain (ses 2 succès l'attestent) → pas de trip pour lui.
  const tripsB = r.trips.filter(t => t.breaker === 'nightly-circuit' && t.subject === 'projet-B')
  check('#11 sender entrelacé : projet B sain → aucun trip pour lui', tripsB.length === 0)

  // Deux projets en échec chronique EN MÊME TEMPS → 2 trips distincts (comme le kill switch).
  const twoBroken = [
    ev({ type: 'task', sender: 'projet-A', kind: 'error' }),
    ev({ type: 'task', sender: 'projet-A', kind: 'error' }),
    ev({ type: 'task', sender: 'projet-A', kind: 'error' }),
    ev({ type: 'task', sender: 'projet-B', kind: 'error' }),
    ev({ type: 'task', sender: 'projet-B', kind: 'error' }),
    ev({ type: 'task', sender: 'projet-B', kind: 'error' }),
  ]
  const r2 = evaluateBreakers(twoBroken, cfg, { now: FROZEN })
  const trips2 = r2.trips.filter(t => t.breaker === 'nightly-circuit')
  check('#11 2 projets en échec chronique → 2 trips distincts', trips2.length === 2)
  check('#11 subjects triés (projet-A, projet-B)', trips2[0].subject === 'projet-A' && trips2[1].subject === 'projet-B')
}

report()
