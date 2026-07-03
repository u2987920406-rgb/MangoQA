// Mango QA — Visage 1 : runner du Disjoncteur (couche I/O).
//
// Le moteur (disjoncteur.ts) est pur ; ici vit le seul contact avec le monde :
//   LIRE   .mangoqa/bus-events.jsonl   (flux exporté par le pont MangoOS)
//   ÉCRIRE .mangoqa/breaker-verdict.json   (snapshot du dernier verdict — état courant)
//   ÉCRIRE .mangoqa/breaker-alerts.jsonl   (journal append-only des disjoncteurs sautés)
//
// Le Disjoncteur n'ARRÊTE rien lui-même : il ÉCRIT un constat que MangoOS (et Raf)
// lisent. Conforme à la fondation : « défensif uniquement, n'alerte que Raf ». Pas
// une ligne de LLM, pas un octet de réseau. Fail-open : un échec I/O ne casse rien.
import fs from 'node:fs'
import path from 'node:path'
import {
  evaluateBreakers,
  tripSignature,
  DEFAULT_BREAKER_CONFIG,
  type BreakerConfig,
  type BreakerReport,
  type BusEvent,
} from './disjoncteur.js'
import { readJsonlTail, readJsonlSince, type JsonlCursor } from '../jsonl.js'

/** Le pont MangoOS exporte ici (cf. kernel-mangoqa-bridge.ts : BUS_EVENTS_FILE). */
export const BUS_EVENTS_FILE = 'bus-events.jsonl'
export const VERDICT_FILE = 'breaker-verdict.json'
export const ALERTS_FILE = 'breaker-alerts.jsonl'

/** Dossier où le pont écrit et où l'on dépose nos constats. */
function qaDir(workspace: string): string {
  return path.join(workspace, '.mangoqa')
}

// #L70 — Bornes de lecture. Le flux .jsonl est APPEND-ONLY et grossit sans limite ; le
// relire ENTIER à chaque cycle (toutes les 5 s) allouait une string de la taille du fichier
// → sur une session de plusieurs heures, pression heap → OOM V8 (exit 134). On ne lit donc
// que la QUEUE (events récents, seuls pertinents) et on borne le tableau en mémoire.
const MAX_BUS_BYTES = 4 * 1024 * 1024 // 4 Mo lus au maximum par cycle
const MAX_BUS_EVENTS = 20_000 // borne dure du tableau d'événements gardé en mémoire

/** Garde de forme : seuls les événements bien formés entrent dans l'évaluation. */
function isBusEvent(e: unknown): e is BusEvent {
  const v = e as BusEvent
  return !!v && typeof v.type === 'string' && typeof v.sender === 'string' && typeof v.ts === 'number'
}

/** Lit le flux du Bus (tolérant : lignes corrompues ignorées). Au-delà de MAX_BUS_BYTES,
 *  ne lit que la queue du fichier (#L70) — allocation bornée quelle que soit sa taille.
 *  Délègue au lecteur JSONL partagé (src/jsonl.ts). */
export function readBusEvents(workspace: string): BusEvent[] {
  const file = path.join(qaDir(workspace), BUS_EVENTS_FILE)
  const rows = readJsonlTail<BusEvent>(file, { maxBytes: MAX_BUS_BYTES, maxLines: Number.POSITIVE_INFINITY })
  const out = rows.filter(isBusEvent)
  // Borne dure : si la queue contient énormément de lignes courtes, on ne garde que les plus récentes.
  return out.length > MAX_BUS_EVENTS ? out.slice(-MAX_BUS_EVENTS) : out
}

/** #Q5 — Lecteur INCRÉMENTAL du flux du Bus pour le polling continu (cycle 5 s).
 *  Mémorise la position (octets) du dernier cycle et ne lit que les octets NOUVEAUX
 *  depuis — le cycle nominal coûte un statSync + le delta, plus jamais 4 Mo entiers.
 *  Le tampon d'événements est borné (MAX_BUS_EVENTS) ; fichier rétréci = rotation →
 *  reset complet (curseur + tampon) puis relecture bornée de la queue. */
export function createBusEventsReader(): (workspace: string) => BusEvent[] {
  const cursor: JsonlCursor = { offset: 0 }
  let buffer: BusEvent[] = []
  return (workspace: string): BusEvent[] => {
    const file = path.join(qaDir(workspace), BUS_EVENTS_FILE)
    const { entries, reset } = readJsonlSince<BusEvent>(file, cursor, {
      maxBytes: MAX_BUS_BYTES, // cap 4 Mo conservé comme borne dure par lecture
      maxLines: Number.POSITIVE_INFINITY,
    })
    if (reset) buffer = []
    for (const e of entries) if (isBusEvent(e)) buffer.push(e)
    if (buffer.length > MAX_BUS_EVENTS) buffer = buffer.slice(-MAX_BUS_EVENTS)
    return buffer
  }
}

export interface RunnerDeps {
  /** Lecture du flux (injectable en test). Défaut : readBusEvents. */
  readEvents?: (workspace: string) => BusEvent[]
  /** Écriture d'un fichier (injectable en test). Défaut : fs.writeFileSync. */
  writeFile?: (file: string, data: string) => void
  /** Append d'une ligne (injectable en test). Défaut : fs.appendFileSync. */
  appendLine?: (file: string, line: string) => void
  /** Signatures de trips déjà alertées (évite de ré-alerter un trip qui reste levé). */
  knownTrips?: Set<string>
  now?: () => number
  costWindowStartTs?: number
  /** #L70 — durée au-delà de laquelle un agent inactif est périmé (kill switch ignoré).
   *  Défaut : Infinity (comportement historique — les tests runner restent inchangés). */
  agentStalenessMs?: number
}

/** Un cycle complet : lit le flux, évalue les 5 disjoncteurs, écrit le verdict, et
 * n'ajoute au journal d'alertes que les trips NOUVEAUX (pas vus au cycle précédent).
 * Renvoie le rapport pour log/diagnostic. */
export function runDisjoncteurOnce(
  workspace: string,
  cfg: BreakerConfig = DEFAULT_BREAKER_CONFIG,
  deps: RunnerDeps = {},
): BreakerReport {
  const readEvents = deps.readEvents ?? readBusEvents
  const writeFile = deps.writeFile ?? ((f, d) => fs.writeFileSync(f, d, 'utf8'))
  const appendLine = deps.appendLine ?? ((f, l) => fs.appendFileSync(f, l + '\n', 'utf8'))
  const known = deps.knownTrips ?? new Set<string>()
  const now = deps.now ?? (() => Date.now())
  // Garde-fou coût = « par nuit » (fondation). Le flux .jsonl est append-only et
  // grossit ; sans fenêtre on sommerait TOUT l'historique → faux déclenchement
  // garanti. Défaut : les 12 dernières heures (couvre une nuit), surchargeable.
  const costWindowStartTs = deps.costWindowStartTs ?? now() - 12 * 60 * 60 * 1000
  const agentStalenessMs = deps.agentStalenessMs ?? Infinity

  const events = readEvents(workspace)
  const report = evaluateBreakers(events, cfg, { now, costWindowStartTs, agentStalenessMs })

  const dir = qaDir(workspace)
  try {
    fs.mkdirSync(dir, { recursive: true })
    writeFile(path.join(dir, VERDICT_FILE), JSON.stringify(report, null, 2))
  } catch (err) {
    /* fail-open : un échec d'écriture du snapshot ne casse pas la surveillance */
    console.warn('[mango-qa] disjoncteur:', (err as Error)?.message ?? err)
  }

  // Journal d'alertes : on n'ajoute QUE les nouveaux disjoncteurs sautés.
  for (const trip of report.trips) {
    const sig = tripSignature(trip)
    if (known.has(sig)) continue
    known.add(sig)
    try {
      appendLine(path.join(dir, ALERTS_FILE), JSON.stringify({ ...trip, alertedAt: now() }))
    } catch (err) {
      /* fail-open */
      console.warn('[mango-qa] disjoncteur:', (err as Error)?.message ?? err)
    }
  }
  // Un disjoncteur réarmé (plus dans les trips) pourra ré-alerter plus tard.
  const live = new Set(report.trips.map(tripSignature))
  for (const sig of known) if (!live.has(sig)) known.delete(sig)

  return report
}

/** Surveillance continue : un cycle toutes les `intervalMs`. Renvoie un arrêt propre.
 * Mémoire de dédup partagée entre cycles via une seule closure `known`. */
/** #L70 — Au-delà de 30 min sans événement, un agent est périmé (le projet a fini) : le
 *  kill switch cesse de le re-déclencher. Borne le nombre de trips vivants → borne les logs. */
export const STALE_AGENT_MS = 30 * 60_000

export function startDisjoncteur(
  workspace: string,
  cfg: BreakerConfig = DEFAULT_BREAKER_CONFIG,
  intervalMs = 5_000,
): () => void {
  const known = new Set<string>()
  // #L70 — anti-spam : un trip DÉJÀ affiché n'est pas re-loggé à chaque cycle (5 s). Sans ce
  // dédup, ~40 trips restaient affichés en boucle → journaux qui explosent + bruit inutile.
  const logged = new Set<string>()
  // #Q5 — lecture incrémentale : seuls les octets NOUVEAUX depuis le dernier cycle
  // sont lus (état local du runner : curseur + tampon borné, rotation = reset).
  const readEvents = createBusEventsReader()
  const tick = (): void => {
    const report = runDisjoncteurOnce(workspace, cfg, { knownTrips: known, agentStalenessMs: STALE_AGENT_MS, readEvents })
    if (!report.safe) {
      for (const t of report.trips) {
        const sig = tripSignature(t)
        if (logged.has(sig)) continue // déjà affiché → pas de re-log
        logged.add(sig)
        console.log(`[mango-qa] ⚡ DISJONCTEUR « ${t.breaker} » → ${t.reason}`)
      }
    }
    // Un trip réarmé (plus dans le rapport) est retiré → il pourra ré-alerter s'il resaute.
    const live = new Set(report.trips.map(tripSignature))
    for (const sig of logged) if (!live.has(sig)) logged.delete(sig)
  }
  tick()
  const handle = setInterval(tick, intervalMs)
  return () => clearInterval(handle)
}
