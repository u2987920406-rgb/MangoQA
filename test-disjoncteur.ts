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
import { runDisjoncteurOnce, readBusEvents, createBusEventsReader } from './src/breakers/runner.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

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

// ── 3. Verrou régression — #11 (constat B) : INERTE par défaut ──────────────
// Rien n'émet `payload.score` sur un event `qa.audit*` aujourd'hui (côté MangoOS,
// ChatTurnOutcome n'a que cost/turns/duration, QAVerdict n'a pas de score
// numérique) → gaté OFF par défaut (`regressionLockEnabled: false`) pour ne pas
// le compter comme actif silencieusement. On teste explicitement les deux états.
{
  const bad = [ev({ type: 'qa.audit', sender: 'qa', payload: { score: 0.4 } })]
  check(
    '#11 défaut (regressionLockEnabled=false) : score bas → PAS de trip (inerte)',
    !tripIds(bad).includes('regression-lock'),
  )
  check('#11 défaut : DEFAULT_BREAKER_CONFIG.regressionLockEnabled === false', DEFAULT_BREAKER_CONFIG.regressionLockEnabled === false)

  const enabledCfg: BreakerConfig = { ...cfg, regressionLockEnabled: true }
  const good = [ev({ type: 'qa.audit', sender: 'qa', payload: { score: 0.9 } })]
  check('activé : score 0.9 ≥ seuil → pas de trip', !tripIds(good, enabledCfg).includes('regression-lock'))
  check('activé : score 0.4 < seuil 0.6 → trip', tripIds(bad, enabledCfg).includes('regression-lock'))

  // Le DERNIER audit compte (régression récente prime).
  const evolving = [
    { ...ev({ type: 'qa.audit', sender: 'qa', payload: { score: 0.9 } }), ts: 10 },
    { ...ev({ type: 'qa.audit', sender: 'qa', payload: { score: 0.3 } }), ts: 20 },
  ]
  check('activé : dernier audit (0.3) prime → trip', tripIds(evolving, enabledCfg).includes('regression-lock'))

  const recovered = [
    { ...ev({ type: 'qa.audit', sender: 'qa', payload: { score: 0.3 } }), ts: 10 },
    { ...ev({ type: 'qa.audit', sender: 'qa', payload: { score: 0.8 } }), ts: 20 },
  ]
  check('activé : dernier audit (0.8) rétabli → pas de trip', !tripIds(recovered, enabledCfg).includes('regression-lock'))
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

// ── #L70 : runner applique la staleness (agent périmé → non alerté) ───────────
{
  const NOW = () => 10_000_000
  const staleAgent = [ev({ type: 'agent', sender: 'mort', ts: 500, payload: { durationMs: 999_999 } })]
  const r = runDisjoncteurOnce('/ws', cfg, {
    readEvents: () => staleAgent,
    writeFile: () => {},
    appendLine: () => {},
    knownTrips: new Set<string>(),
    now: NOW,
    agentStalenessMs: 30 * 60_000,
  })
  check('#L70 runner : agent périmé → safe (kill switch éteint)', !r.trips.some(t => t.breaker === 'agent-killswitch'))
}

// ── #L70 : readBusEvents ne lit que la QUEUE d'un gros fichier (anti-OOM) ──────
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mangoqa-l70-'))
  const qa = path.join(tmp, '.mangoqa')
  fs.mkdirSync(qa, { recursive: true })
  const pad = 'y'.repeat(250)
  const lines: string[] = []
  // ~5 Mo (> MAX_BUS_BYTES 4 Mo) → readBusEvents doit ne lire que la queue.
  for (let i = 0; i < 20_000; i++) lines.push(JSON.stringify({ type: 'x', sender: `old-${i}`, ts: i, payload: { pad } }))
  lines.push(JSON.stringify({ type: 'x', sender: 'RECENT', ts: 9_999_999, payload: {} }))
  fs.writeFileSync(path.join(qa, 'bus-events.jsonl'), lines.join('\n') + '\n', 'utf8')
  const sizeMb = fs.statSync(path.join(qa, 'bus-events.jsonl')).size / (1024 * 1024)
  const got = readBusEvents(tmp)
  check('#L70 readBusEvents : gros fichier lu PARTIELLEMENT (queue)', sizeMb > 4 && got.length > 0 && got.length < 20_001)
  check('#L70 readBusEvents : la queue garde le plus RÉCENT', got.some(e => e.sender === 'RECENT'))
  check('#L70 readBusEvents : le TOUT début (old-0) est hors queue', !got.some(e => e.sender === 'old-0'))
  fs.rmSync(tmp, { recursive: true, force: true })
}

// ── #Q5 : lecteur incrémental — seuls les octets NOUVEAUX sont lus par cycle ──
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mangoqa-q5-'))
  const qa = path.join(tmp, '.mangoqa')
  fs.mkdirSync(qa, { recursive: true })
  const busFile = path.join(qa, 'bus-events.jsonl')
  const line = (sender: string, ts: number) => JSON.stringify({ type: 'x', sender, ts, payload: {} }) + '\n'

  const read = createBusEventsReader()
  // Fichier pas encore créé → [].
  check('#Q5 incrémental : flux absent → []', read(tmp).length === 0)

  // 1ᵉʳ cycle : tout le fichier.
  fs.writeFileSync(busFile, line('a', 1) + line('b', 2), 'utf8')
  const c1 = read(tmp)
  check('#Q5 incrémental : 1ᵉʳ cycle lit tout', c1.length === 2)

  // 2ᵉ cycle sans écriture : rien de relu, tampon stable.
  const c2 = read(tmp)
  check('#Q5 incrémental : rien de neuf → tampon stable', c2.length === 2)

  // Append : SEUL le delta est lu, cumulé au tampon.
  fs.appendFileSync(busFile, line('c', 3), 'utf8')
  const c3 = read(tmp)
  check('#Q5 incrémental : append → événement cumulé', c3.length === 3 && c3[2].sender === 'c')

  // Ligne corrompue + événement mal formé : ignorés, le flux continue.
  fs.appendFileSync(busFile, '{pas du json\n' + JSON.stringify({ type: 'x' }) + '\n' + line('d', 4), 'utf8')
  const c4 = read(tmp)
  check('#Q5 incrémental : corrompu/mal formé ignorés', c4.length === 4 && c4[3].sender === 'd')

  // Fin de fichier en cours d'écriture (pas de \n) : relue une fois complète.
  fs.appendFileSync(busFile, '{"type":"x","sender":"e"', 'utf8')
  check('#Q5 incrémental : ligne partielle non consommée', read(tmp).length === 4)
  fs.appendFileSync(busFile, ',"ts":5,"payload":{}}\n', 'utf8')
  const c5 = read(tmp)
  check('#Q5 incrémental : ligne complétée lue au cycle suivant', c5.length === 5 && c5[4].sender === 'e')

  // Rotation : le fichier RÉTRÉCIT → reset complet (curseur + tampon) puis relecture.
  fs.writeFileSync(busFile, line('rotated', 9), 'utf8')
  const c6 = read(tmp)
  check('#Q5 incrémental : rotation → reset complet', c6.length === 1 && c6[0].sender === 'rotated')

  // Le cycle complet du runner fonctionne avec le lecteur incrémental injecté.
  fs.writeFileSync(
    busFile,
    line('ok', 10) +
      JSON.stringify({ type: 'task', sender: 'x', kind: 'error', ts: 11, payload: {} }) + '\n' +
      JSON.stringify({ type: 'task', sender: 'x', kind: 'error', ts: 12, payload: {} }) + '\n' +
      JSON.stringify({ type: 'task', sender: 'x', kind: 'error', ts: 13, payload: {} }) + '\n',
    'utf8',
  )
  const readForRunner = createBusEventsReader()
  const rep = runDisjoncteurOnce(tmp, cfg, {
    readEvents: readForRunner,
    writeFile: () => {},
    appendLine: () => {},
    knownTrips: new Set<string>(),
    now: FROZEN,
  })
  check('#Q5 runner : cycle complet avec lecteur incrémental → trip détecté', rep.trips.some(t => t.breaker === 'nightly-circuit'))

  fs.rmSync(tmp, { recursive: true, force: true })
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

// ── #11 (constat C) : le runner alerte une fois puis se tait tant que stale ──
{
  const NOW_BASE = 10_000_000
  let now = NOW_BASE
  const staleEvents = [ev({ type: 'x', sender: 'pont', ts: NOW_BASE })]
  const warns: string[] = []
  const origWarn = console.warn
  console.warn = (...args: unknown[]) => {
    warns.push(String(args[0]))
  }
  try {
    // Import dynamique du runner (déjà importé en tête de fichier via startDisjoncteur
    // non utilisé ici — on exerce runDisjoncteurOnce directement à seuil serré).
    const cycle = () =>
      runDisjoncteurOnce('/ws', cfg, {
        readEvents: () => staleEvents,
        writeFile: () => {},
        appendLine: () => {},
        knownTrips: new Set<string>(),
        now: () => now,
        busStaleThresholdMs: 100,
      })
    const rep1 = cycle()
    check('#11 runner : flux tari détecté (busLiveness.stale)', rep1.busLiveness.stale === false) // au t0, âge = 0 < seuil
    now = NOW_BASE + 5000 // 5s plus tard, aucun nouvel event → tari
    const rep2 = cycle()
    check('#11 runner : après silence prolongé → busLiveness.stale', rep2.busLiveness.stale === true)
  } finally {
    console.warn = origWarn
  }
}

// ── Bilan ────────────────────────────────────────────────────────────────────
console.log(`\n[disjoncteur] ${passed} ✅  ${failed ? failed + ' ❌' : '0 ❌'}  (${passed + failed} assertions)`)
if (failed > 0) process.exit(1)
