// Mango QA — Visage 2 : runner I/O de l'Observateur-Conseil (câblage #D2a).
//
// observer.ts est le moteur PUR (zéro I/O) : analyse un tableau d'ObserverEvent déjà
// en mémoire. Ici vit la couche I/O autour : lire la queue du Retex (jsonl.ts, bornée —
// anti-OOM, même famille que #L70), la mapper en ObserverEvent, appeler analyzeEvents,
// et écrire un CONSTAT à côté du verdict d'audit — jamais une action, jamais un garde.
//
// Gaté par QA_OBSERVER (défaut OFF = comportement historique, comme SUITE_EYE dans
// orchestrator.ts). Gate OFF => index.ts n'appelle même pas runObserver : zéro lecture,
// zéro écriture, zéro log. Gate ON => best-effort : runObserver ne lève JAMAIS vers
// l'appelant (try/catch), mais trace tout échec en console.warn (fail-open ≠ fail-silent,
// philosophie du repo — cf. jsonl.ts).
import fs from 'node:fs'
import path from 'node:path'
import { readJsonlTail } from './jsonl.js'
import { retexPath, type RetexEntry } from './retex.js'
import { analyzeEvents, renderObserverReport, type ObserverEvent, type ObserverReport } from './observer.js'

/** Fenêtre relue par l'Observateur : plus large que les 6 entrées réinjectées dans les
 *  prompts par `loadRetexConstraints` (retex.ts) — on veut assez d'historique pour que
 *  des patterns émergent — mais toujours BORNÉE (anti-OOM, même garantie que jsonl.ts). */
export const OBSERVER_TAIL_LINES = 500
export const OBSERVER_TAIL_BYTES = 1024 * 1024 // 1 Mo, cohérent avec le Retex (retex.ts)

export const OBSERVER_REPORT_FILE = 'observer-report.json'

/** RetexEntry → ObserverEvent. Une entrée malformée (champ manquant/mal typé — JSONL
 *  toléré par nature) est ignorée SILENCIEUSEMENT : le mapping est best-effort, pas un
 *  contrat strict — l'Observateur est un conseil, pas un garde. */
export function mapRetexToObserverEvents(entries: RetexEntry[]): ObserverEvent[] {
  const out: ObserverEvent[] = []
  for (const e of entries) {
    if (
      !e ||
      typeof e.ts !== 'string' ||
      typeof e.projectName !== 'string' ||
      typeof e.phase !== 'string' ||
      typeof e.branch !== 'string' ||
      typeof e.rejection_id !== 'string' ||
      typeof e.rule_ref !== 'string'
    ) {
      continue
    }
    out.push({
      ts: e.ts,
      projectName: e.projectName,
      phase: e.phase,
      branch: e.branch,
      rejectionId: e.rejection_id,
      ruleRef: e.rule_ref,
    })
  }
  return out
}

/** Le CONTRAT écrit dans <workspace>/.mangoqa/observer-report.json — lu côté MangoOS. */
export interface ObserverReportFile {
  generatedAt: string
  windowEvents: number
  report: ObserverReport
  rendered: string
}

export interface ObserverRunnerDeps {
  /** Lit les entrées Retex brutes (déjà bornées) pour un workspace. */
  readEntries?: (workspace: string) => RetexEntry[]
  writeReport?: (file: string, data: string) => void
  now?: () => Date
}

function defaultReadEntries(workspace: string): RetexEntry[] {
  return readJsonlTail<RetexEntry>(retexPath(workspace), {
    maxBytes: OBSERVER_TAIL_BYTES,
    maxLines: OBSERVER_TAIL_LINES,
  })
}

/** Écriture atomique (tmp + rename) : le rapport n'est jamais lu à moitié écrit. Le repo
 *  n'a pas de helper partagé pour ça (vérifié) — implémentation minimale locale. */
function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, data, 'utf8')
  fs.renameSync(tmp, file)
}

/** Gate d'activation — QA_OBSERVER=on|1|true|yes (insensible casse), défaut OFF. Même
 *  esprit que SUITE_EYE (index.ts) : opt-in, ne change rien au comportement historique
 *  tant que la variable n'est pas posée. */
export function observerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.QA_OBSERVER ?? '').trim().toLowerCase()
  return v === 'on' || v === '1' || v === 'true' || v === 'yes'
}

/** Un passage de l'Observateur : lit le Retex (borné), mappe, analyse, écrit le constat.
 *  NE LÈVE JAMAIS vers l'appelant — l'Observateur est un conseil, pas un garde. Tout
 *  échec est avalé mais TRACÉ (console.warn, fail-open ≠ fail-silent). */
export function runObserver(workspace: string, deps: ObserverRunnerDeps = {}): void {
  const readEntries = deps.readEntries ?? defaultReadEntries
  const writeReport = deps.writeReport ?? atomicWrite
  const now = deps.now ?? (() => new Date())

  try {
    const entries = readEntries(workspace)
    const events = mapRetexToObserverEvents(entries)
    const report = analyzeEvents(events)
    const rendered = renderObserverReport(report)
    const payload: ObserverReportFile = {
      generatedAt: now().toISOString(),
      windowEvents: events.length,
      report,
      rendered,
    }
    const dir = path.join(workspace, '.mangoqa')
    fs.mkdirSync(dir, { recursive: true })
    writeReport(path.join(dir, OBSERVER_REPORT_FILE), JSON.stringify(payload, null, 2))
  } catch (err) {
    console.warn('[observer]', (err as Error)?.message ?? err)
  }
}
