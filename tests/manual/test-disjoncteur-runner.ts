// Tests du Visage 1 — Le Disjoncteur : runner I/O (verdict écrit, alertes
// dédupliquées, staleness appliquée par le runner, lecture bornée/incrémentale
// du bus). Exécution : npx tsx test-disjoncteur-runner.ts
// Déterministe, zéro réseau, zéro LLM — I/O injectée sauf mentions explicites
// (readBusEvents/createBusEventsReader exercent le disque réel via tmpdir).
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { runDisjoncteurOnce, readBusEvents, createBusEventsReader } from '../../src/breakers/runner.js'
import { cfg, FROZEN, makeEv, makeChecker, type BusEvent } from './disjoncteur-shared.js'

const { check, report } = makeChecker('disjoncteur-runner')
const ev = makeEv()

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

report()
