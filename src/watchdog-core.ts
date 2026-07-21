// Cœur PUR du superviseur de process MangoQA (limites.md L127).
//
// Constat réel : MangoQA (`npm start`) a crashé 2× par heap-overflow lors de la fenêtre
// SOUV-D (2026-07-15, ~5h45 puis ~3h de fonctionnement), et le ré-audit du 2026-07-21 a
// constaté qu'AUCUN process MangoQA n'était vivant au moment du contrôle — la limite est
// restée ouverte 6 jours faute d'un mécanisme de relance automatique. Ce module fournit la
// LOGIQUE de décision (relance ou non), testable sans jamais lancer de vrai process ni
// toucher au disque — l'orchestration (spawn, setInterval, lecture fichier réelle) vit dans
// `watchdog.ts`, comme le veut la séparation câblage/logique déjà établie (orchestrator.ts,
// watch-fallback.ts).

/** Contenu attendu de la sentinelle `.mangoqa-active` (écrite par index.ts::beat()). */
export interface HeartbeatData {
  heartbeat: string;
  pid: number;
}

/** Parse best-effort — une sentinelle absente/corrompue est un cas normal (process pas
 *  encore démarré, ou coupé au milieu d'une écriture), jamais une exception qui remonte. */
export function parseHeartbeat(raw: string): HeartbeatData | null {
  try {
    const data = JSON.parse(raw);
    if (typeof data?.heartbeat !== "string" || typeof data?.pid !== "number") return null;
    const ms = Date.parse(data.heartbeat);
    if (Number.isNaN(ms)) return null;
    return { heartbeat: data.heartbeat, pid: data.pid };
  } catch {
    return null;
  }
}

/** Âge du heartbeat en ms. `null` (sentinelle absente/illisible) → Infinity : un process
 *  jamais démarré ou mort depuis longtemps doit être traité comme périmé, pas comme frais. */
export function heartbeatAgeMs(raw: string | null, nowMs: number): number {
  if (raw === null) return Infinity;
  const parsed = parseHeartbeat(raw);
  if (parsed === null) return Infinity;
  return nowMs - Date.parse(parsed.heartbeat);
}

/** Un process VIVANT (pas d'exit détecté) mais BLOQUÉ (hang, deadlock) ne déclenche jamais
 *  l'event 'exit' du child_process — seul un heartbeat périmé le révèle. Seuil par défaut :
 *  6× l'intervalle d'écriture du heartbeat (10s, cf. index.ts HEARTBEAT_MS) = marge large
 *  pour absorber un cycle de branches d'audit lent sans fausse alerte. */
export const DEFAULT_STALE_THRESHOLD_MS = 60_000;

export function isHeartbeatStale(ageMs: number, thresholdMs: number = DEFAULT_STALE_THRESHOLD_MS): boolean {
  return ageMs > thresholdMs;
}

/** Anti-tempête de relances : si le process meurt en boucle très rapprochée (ex. crash au
 *  démarrage, config cassée), reculer le délai de relance au lieu de marteler indéfiniment
 *  au même rythme. Backoff linéaire borné — simple et suffisant (pas besoin d'exponentiel
 *  pour un superviseur local). */
export function respawnDelayMs(consecutiveFastFailures: number, baseDelayMs: number, maxDelayMs: number): number {
  const delay = baseDelayMs * (1 + consecutiveFastFailures);
  return Math.min(delay, maxDelayMs);
}

/** Un crash est "rapide" (échec au démarrage probable) s'il survient avant ce délai après
 *  le spawn — sert à alimenter `consecutiveFastFailures` côté appelant. */
export const FAST_FAILURE_THRESHOLD_MS = 10_000;
