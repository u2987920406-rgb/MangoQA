// Mango QA — point d'entrée : CÂBLAGE uniquement (#Q2).
//
// Cycle : MangoOS écrit <projet>/.mangoqa/phase-complete.json après chaque phase
// → Mango QA « entre sans frapper », lance ses 6 branches en parallèle, et
// répond <projet>/.mangoqa/audit-verdict.json (Feu Vert / Feu Rouge). Une
// sentinelle heartbeat (.mangoqa-active) permet à MangoOS de détecter qu'on
// tourne (isMangoQaActive). Fail-open partout : une défaillance de Mango QA ne
// doit jamais bloquer la production (MangoOS continue après timeout).
//
// Toute la LOGIQUE d'un signal (dédup, verrou, branches, verdict, visages) vit
// dans src/orchestrator.ts (testable, dépendances injectées). Ici : env, watcher
// chokidar, heartbeat, Disjoncteur, arrêt propre.
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import chokidar from 'chokidar'
import type { Branch } from './types.js'
import { createOrchestrator } from './orchestrator.js'
import { architecture } from './branches/architecture.js'
import { accessibility } from './branches/accessibility.js'
import { security } from './branches/security.js'
import { performance } from './branches/performance.js'
import { tests } from './branches/tests.js'
import { designSystem } from './branches/design-system.js'
import { startDisjoncteur } from './breakers/runner.js'
import { runObserver, observerEnabled } from './observer-runner.js'

// Ordre = priorité de rejet (la 1ʳᵉ branche bloquante en échec porte le Feu Rouge).
const BRANCHES: Branch[] = [architecture, security, accessibility, performance, tests, designSystem]

const WORKSPACE = (process.env.MANGOAI_WORKSPACE ?? '').trim()
const HEARTBEAT_MS = 10_000
/** Auditeur de Suite câblé dans le cycle de phase — opt-in (défaut off = comportement historique). */
const SUITE_EYE = (process.env.SUITE_EYE ?? '').trim().toLowerCase() === 'on'
/** Visage 2 — Observateur-Conseil : opt-in (QA_OBSERVER=on), défaut OFF = zéro lecture,
 *  zéro écriture, zéro log (comportement historique inchangé). */
const OBSERVER_ON = observerEnabled()

if (!WORKSPACE || !fs.existsSync(WORKSPACE)) {
  console.error(`[mango-qa] MANGOAI_WORKSPACE introuvable : "${WORKSPACE}". Vérifie .env.`)
  process.exit(1)
}

// ── Sentinelle heartbeat ─────────────────────────────────────────────────────
const sentinelPath = path.join(WORKSPACE, '.mangoqa-active')
function beat(): void {
  try {
    fs.writeFileSync(
      sentinelPath,
      JSON.stringify({ heartbeat: new Date().toISOString(), pid: process.pid, branches: BRANCHES.map(b => b.id) }),
      'utf8',
    )
  } catch (err) {
    console.warn('[mango-qa] heartbeat:', err instanceof Error ? err.message : err)
  }
}

// ── Démarrage ────────────────────────────────────────────────────────────────
beat()
setInterval(beat, HEARTBEAT_MS)

// Visage 2 — Observateur-Conseil : un run au boot (constat sur l'historique déjà là),
// gaté strictement — gate OFF = cette ligne ne fait RIEN (pas d'appel à runObserver).
if (OBSERVER_ON) runObserver(WORKSPACE)

const orchestrator = createOrchestrator({ workspace: WORKSPACE, branches: BRANCHES, suiteEye: SUITE_EYE })

const pattern = path.join(WORKSPACE, '*', '.mangoqa', 'phase-complete.json').replace(/\\/g, '/')
const watcher = chokidar.watch(pattern, {
  ignoreInitial: true, // ne pas rejouer un signal périmé au boot
  awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
})
async function handleAndObserve(f: string): Promise<void> {
  await orchestrator.handleSignal(f)
  // Après délégation à l'orchestrateur : nouveau constat sur l'historique à jour.
  // Gaté (QA_OBSERVER) — OFF = aucun appel, comportement historique inchangé.
  if (OBSERVER_ON) runObserver(WORKSPACE)
}
watcher.on('add', f => void handleAndObserve(f))
watcher.on('change', f => void handleAndObserve(f))

// ── Visage 1 : le Disjoncteur (réflexes durs, zéro LLM) ──────────────────────
// Surveille en continu le flux du Bus (.mangoqa/bus-events.jsonl, exporté par le
// pont MangoOS) et écrit ses constats (breaker-verdict.json / breaker-alerts.jsonl).
// Indépendant du watcher d'audit : les deux visages tournent côte à côte.
const stopDisjoncteur = startDisjoncteur(WORKSPACE)

console.log(
  `[mango-qa] 🥭 Mango QA actif — ${BRANCHES.length} branches + ⚡ Disjoncteur + 👁️ Œil Design + 🧭 Auditeur de Flux${SUITE_EYE ? ' + 🧩 Auditeur de Suite' : ''}${OBSERVER_ON ? ' + 🔭 Observateur-Conseil' : ''}`,
)
console.log(`[mango-qa] workspace : ${WORKSPACE}`)
console.log(`[mango-qa] sentinelle : ${sentinelPath}`)
console.log('[mango-qa] en attente de phase-complete.json…')

function shutdown(): void {
  try {
    fs.unlinkSync(sentinelPath)
  } catch (err) {
    /* déjà absente = normal ; toute autre erreur est tracée */
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn('[mango-qa] shutdown:', (err as Error)?.message ?? err)
    }
  }
  stopDisjoncteur()
  void watcher.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
