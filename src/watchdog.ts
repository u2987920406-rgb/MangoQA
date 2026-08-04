// Superviseur de process MangoQA (#Q-watchdog, limites.md L127).
//
// Câblage uniquement — la logique de décision (heartbeat périmé ? backoff ?) vit dans
// watchdog-core.ts (pur, testé). Relance `src/index.ts` (le vrai worker MangoQA) : (a) s'il
// crashe (event 'exit' du child_process), (b) si sa sentinelle `.mangoqa-active` cesse
// d'être rafraîchie (process vivant mais bloqué — un crash n'est pas le seul mode de panne
// observé, cf. L127). Fail-open par construction : ce script ne doit JAMAIS lui-même
// planter silencieusement — toute erreur est loggée, jamais avalée sans trace.
//
// Lancer :  npm run watch:supervised   (au lieu de `npm start` en direct pour une session
//           longue durée sans supervision manuelle)
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  heartbeatAgeMs,
  isHeartbeatStale,
  respawnDelayMs,
  DEFAULT_STALE_THRESHOLD_MS,
  FAST_FAILURE_THRESHOLD_MS,
} from "./watchdog-core.js";
import { mangoqaRoot } from "./config.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORKSPACE = mangoqaRoot();
const SENTINEL_PATH = WORKSPACE ? path.join(WORKSPACE, ".mangoqa-active") : "";
const LOG_PATH = path.join(ROOT, "watchdog.log");
const HEARTBEAT_CHECK_INTERVAL_MS = 15_000;
const BASE_RESPAWN_DELAY_MS = 3_000;
const MAX_RESPAWN_DELAY_MS = 60_000;

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] [watchdog] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, line + "\n");
  } catch {
    /* le log est un confort, jamais un point de blocage */
  }
}

function readSentinelRaw(): string | null {
  if (!SENTINEL_PATH) return null;
  try {
    return fs.readFileSync(SENTINEL_PATH, "utf8");
  } catch {
    return null;
  }
}

let child: ChildProcess | null = null;
let stopping = false;
let consecutiveFastFailures = 0;
let lastSpawnAt = 0;

function spawnChild(): void {
  lastSpawnAt = Date.now();
  log(`démarrage de MangoQA (src/index.ts)…`);
  // node <tsx/cli.mjs> plutôt que le binstub .bin/tsx(.cmd) : `child_process.spawn` sans
  // `shell:true` échoue en EINVAL sur les .cmd Windows (constaté en vérif live 2026-07-21).
  // Invoquer le CLI tsx directement via `node` est portable Windows/Unix sans shell.
  const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  child = spawn(process.execPath, [tsxCli, path.join(ROOT, "src", "index.ts")], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });

  child.on("exit", (code, signal) => {
    child = null;
    if (stopping) return;
    const ranMs = Date.now() - lastSpawnAt;
    consecutiveFastFailures = ranMs < FAST_FAILURE_THRESHOLD_MS ? consecutiveFastFailures + 1 : 0;
    const delay = respawnDelayMs(consecutiveFastFailures, BASE_RESPAWN_DELAY_MS, MAX_RESPAWN_DELAY_MS);
    log(`MangoQA arrêté (code=${code} signal=${signal}, actif ${Math.round(ranMs / 1000)}s) — relance dans ${delay}ms`);
    setTimeout(spawnChild, delay);
  });

  child.on("error", (err) => {
    log(`erreur de spawn : ${err.message}`);
  });
}

// Surveillance du heartbeat, EN PLUS de l'exit du process — couvre le cas d'un process
// vivant mais bloqué (hang) qui ne déclenche jamais 'exit' (cf. watchdog-core.ts).
setInterval(() => {
  if (!child || stopping) return;
  const age = heartbeatAgeMs(readSentinelRaw(), Date.now());
  if (isHeartbeatStale(age, DEFAULT_STALE_THRESHOLD_MS)) {
    log(`heartbeat périmé (${age === Infinity ? "sentinelle absente" : Math.round(age / 1000) + "s"}) — process jugé bloqué, kill (relance automatique via 'exit')`);
    try {
      child.kill("SIGKILL");
    } catch {
      /* déjà mort entre-temps — le prochain tick s'en apercevra via 'exit' */
    }
  }
}, HEARTBEAT_CHECK_INTERVAL_MS);

function shutdown(): void {
  stopping = true;
  log("arrêt demandé — coupe MangoQA et sort proprement.");
  try {
    child?.kill();
  } catch {
    /* rien à faire de plus */
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (!WORKSPACE) {
  log("MANGOQA_ROOT (ou MANGOAI_WORKSPACE) absent — le worker se coupera lui-même au démarrage (comportement normal de index.ts), le watchdog le relancera quand même en boucle. Vérifie .env.");
}
log(`watchdog démarré (workspace="${WORKSPACE || "?"}", seuil heartbeat=${DEFAULT_STALE_THRESHOLD_MS}ms)`);
spawnChild();
