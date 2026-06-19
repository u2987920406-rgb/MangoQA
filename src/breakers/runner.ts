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

/** Le pont MangoOS exporte ici (cf. kernel-mangoqa-bridge.ts : BUS_EVENTS_FILE). */
export const BUS_EVENTS_FILE = 'bus-events.jsonl'
export const VERDICT_FILE = 'breaker-verdict.json'
export const ALERTS_FILE = 'breaker-alerts.jsonl'

/** Dossier où le pont écrit et où l'on dépose nos constats. */
function qaDir(workspace: string): string {
  return path.join(workspace, '.mangoqa')
}

/** Lit le flux du Bus (tolérant : lignes corrompues ignorées, comme le Retex). */
export function readBusEvents(workspace: string): BusEvent[] {
  let raw: string
  try {
    raw = fs.readFileSync(path.join(qaDir(workspace), BUS_EVENTS_FILE), 'utf8')
  } catch {
    return [] // pas encore de flux → rien à surveiller
  }
  const out: BusEvent[] = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const e = JSON.parse(t) as BusEvent
      if (e && typeof e.type === 'string' && typeof e.sender === 'string' && typeof e.ts === 'number') {
        out.push(e)
      }
    } catch {
      /* ligne partielle/corrompue ignorée */
    }
  }
  return out
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

  const events = readEvents(workspace)
  const report = evaluateBreakers(events, cfg, { now, costWindowStartTs })

  const dir = qaDir(workspace)
  try {
    fs.mkdirSync(dir, { recursive: true })
    writeFile(path.join(dir, VERDICT_FILE), JSON.stringify(report, null, 2))
  } catch {
    /* fail-open : un échec d'écriture du snapshot ne casse pas la surveillance */
  }

  // Journal d'alertes : on n'ajoute QUE les nouveaux disjoncteurs sautés.
  for (const trip of report.trips) {
    const sig = tripSignature(trip)
    if (known.has(sig)) continue
    known.add(sig)
    try {
      appendLine(path.join(dir, ALERTS_FILE), JSON.stringify({ ...trip, alertedAt: now() }))
    } catch {
      /* fail-open */
    }
  }
  // Un disjoncteur réarmé (plus dans les trips) pourra ré-alerter plus tard.
  const live = new Set(report.trips.map(tripSignature))
  for (const sig of known) if (!live.has(sig)) known.delete(sig)

  return report
}

/** Surveillance continue : un cycle toutes les `intervalMs`. Renvoie un arrêt propre.
 * Mémoire de dédup partagée entre cycles via une seule closure `known`. */
export function startDisjoncteur(
  workspace: string,
  cfg: BreakerConfig = DEFAULT_BREAKER_CONFIG,
  intervalMs = 5_000,
): () => void {
  const known = new Set<string>()
  const tick = (): void => {
    const report = runDisjoncteurOnce(workspace, cfg, { knownTrips: known })
    if (!report.safe) {
      for (const t of report.trips) {
        console.log(`[mango-qa] ⚡ DISJONCTEUR « ${t.breaker} » → ${t.reason}`)
      }
    }
  }
  tick()
  const handle = setInterval(tick, intervalMs)
  return () => clearInterval(handle)
}
