// Tests du Visage 1 — Le Disjoncteur. Exécution : npx tsx test-disjoncteur.ts
// Déterministe, zéro réseau, zéro LLM, zéro disque (I/O injectée).
import {
  evaluateBreakers,
  tripSignature,
  DEFAULT_BREAKER_CONFIG,
  type BreakerConfig,
  type BreakerId,
  type BusEvent,
} from './src/breakers/disjoncteur.js'
import { runDisjoncteurOnce } from './src/breakers/runner.js'

let passed = 0
let failed = 0
function check(name: string, cond: boolean): void {
  if (cond) {
    passed++
  } else {
    failed++
    console.error(`  ❌ ${name}`)
  }
}

const FROZEN = () => 1_000_000
const cfg: BreakerConfig = { ...DEFAULT_BREAKER_CONFIG }

// Petit constructeur d'enveloppe.
let seq = 0
function ev(partial: Partial<BusEvent> & { type: string; sender: string }): BusEvent {
  return { kind: 'success', ts: ++seq, payload: {}, ...partial }
}
function tripIds(events: BusEvent[], c: BreakerConfig = cfg, opts = {}): BreakerId[] {
  return evaluateBreakers(events, c, { now: FROZEN, ...opts }).trips.map(t => t.breaker)
}

// ── Sécurité de base : flux vide / nominal ───────────────────────────────────
{
  const empty = evaluateBreakers([], cfg, { now: FROZEN })
  check('flux vide → safe', empty.safe === true)
  check('flux vide → 0 trip', empty.trips.length === 0)
  check('flux vide → evaluatedAt = horloge', empty.evaluatedAt === 1_000_000)

  const ok = [ev({ type: 't', sender: 'a', kind: 'success' }), ev({ type: 't', sender: 'a', kind: 'success' })]
  check('flux nominal → safe', evaluateBreakers(ok, cfg, { now: FROZEN }).safe === true)
}

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

// ── 3. Verrou régression ─────────────────────────────────────────────────────
{
  const good = [ev({ type: 'qa.audit', sender: 'qa', payload: { score: 0.9 } })]
  check('score 0.9 ≥ seuil → pas de trip', !tripIds(good).includes('regression-lock'))

  const bad = [ev({ type: 'qa.audit', sender: 'qa', payload: { score: 0.4 } })]
  check('score 0.4 < seuil 0.6 → trip', tripIds(bad).includes('regression-lock'))

  // Le DERNIER audit compte (régression récente prime).
  const evolving = [
    { ...ev({ type: 'qa.audit', sender: 'qa', payload: { score: 0.9 } }), ts: 10 },
    { ...ev({ type: 'qa.audit', sender: 'qa', payload: { score: 0.3 } }), ts: 20 },
  ]
  check('dernier audit (0.3) prime → trip', tripIds(evolving).includes('regression-lock'))

  const recovered = [
    { ...ev({ type: 'qa.audit', sender: 'qa', payload: { score: 0.3 } }), ts: 10 },
    { ...ev({ type: 'qa.audit', sender: 'qa', payload: { score: 0.8 } }), ts: 20 },
  ]
  check('dernier audit (0.8) rétabli → pas de trip', !tripIds(recovered).includes('regression-lock'))
}

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
  check('tempête → 3 disjoncteurs', r.trips.length === 3)
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

// ── Runner : I/O injectée, verdict écrit, alertes dédupliquées ────────────────
{
  const events: BusEvent[] = [
    ev({ type: 'task', sender: 'x', kind: 'error' }),
    ev({ type: 'task', sender: 'x', kind: 'error' }),
    ev({ type: 'task', sender: 'x', kind: 'error' }),
  ]
  const writes: Record<string, string> = {}
  const appends: string[] = []
  const known = new Set<string>()
  const deps = {
    readEvents: () => events,
    writeFile: (f: string, d: string) => {
      writes[f] = d
    },
    appendLine: (_f: string, l: string) => {
      appends.push(l)
    },
    knownTrips: known,
    now: FROZEN,
  }

  const r1 = runDisjoncteurOnce('/ws', cfg, deps)
  check('runner → non safe', r1.safe === false)
  check('runner → verdict écrit', Object.keys(writes).some(f => f.includes('breaker-verdict.json')))
  check('runner → 1 alerte ajoutée', appends.length === 1)

  // 2ᵉ cycle, même trip toujours levé → PAS de ré-alerte (dédup via known).
  runDisjoncteurOnce('/ws', cfg, deps)
  check('runner → trip persistant non ré-alerté', appends.length === 1)

  // Le trip disparaît (flux nettoyé) → known se réarme.
  events.length = 0
  events.push(ev({ type: 'task', sender: 'x', kind: 'success' }))
  const r3 = runDisjoncteurOnce('/ws', cfg, deps)
  check('runner → safe après nettoyage', r3.safe === true)
  check('runner → known réarmé', known.size === 0)
}

// ── Bilan ────────────────────────────────────────────────────────────────────
console.log(`\n[disjoncteur] ${passed} ✅  ${failed ? failed + ' ❌' : '0 ❌'}  (${passed + failed} assertions)`)
if (failed > 0) process.exit(1)
