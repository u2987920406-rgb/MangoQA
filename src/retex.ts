// Boîte Noire (Retex) — composant systémique [1] de la spec.
//
// Registre persistant et autonome géré par Mango QA : chaque Feu Rouge validé
// est journalisé, puis réinjecté PRÉEMPTIVEMENT dans les audits suivants du même
// type de projet/branche (« erreurs historiques à éviter »). Boucle
// d'apprentissage continue, 100 % locale (un fichier JSONL dans le workspace).
import fs from 'node:fs'
import path from 'node:path'
import type { PhaseSignal, Rejection } from './types.js'
import { readJsonlTail } from './jsonl.js'

const RETEX_FILE = '.mangoqa-retex.jsonl'
/** Nombre max d'entrées Retex réinjectées dans un prompt (anti-saturation). */
const RETEX_INJECT_CAP = 6

export interface RetexEntry {
  ts: string
  projectName: string
  phase: string
  branch: string
  rejection_id: string
  corrective_action: string
  rule_ref: string
}

/** Exporté pour l'Observateur-Conseil (observer-runner.ts, #D2a) : même fichier,
 *  lu en tail borné mais avec une fenêtre plus large que `loadRetexConstraints`. */
export function retexPath(workspaceDir: string): string {
  return path.join(workspaceDir, RETEX_FILE)
}

/** Journalise un rejet validé (append-only, tolérant aux erreurs disque). */
export function recordRejection(workspaceDir: string, signal: PhaseSignal, rejection: Rejection): void {
  const entry: RetexEntry = {
    ts: new Date().toISOString(),
    projectName: signal.projectName,
    phase: signal.phase,
    branch: rejection.branch,
    rejection_id: rejection.rejection_id,
    corrective_action: rejection.corrective_action,
    rule_ref: rejection.rule_ref,
  }
  try {
    fs.appendFileSync(retexPath(workspaceDir), JSON.stringify(entry) + '\n', 'utf8')
  } catch (err) {
    /* le Retex est best-effort : ne jamais casser l'audit pour un échec d'écriture */
    console.warn('[mango-qa] retex:', (err as Error)?.message ?? err)
  }
}

/** Bornes de relecture du journal Retex (#Q1) : seuls les rejets RÉCENTS sont
 *  réinjectés (RETEX_INJECT_CAP = 6 après dédup) — relire tout le fichier à chaque
 *  audit était la même famille d'OOM que #L70. 1 Mo / 2000 lignes = très large. */
const RETEX_TAIL_BYTES = 1024 * 1024
const RETEX_TAIL_LINES = 2_000

function loadAll(workspaceDir: string): RetexEntry[] {
  return readJsonlTail<RetexEntry>(retexPath(workspaceDir), {
    maxBytes: RETEX_TAIL_BYTES,
    maxLines: RETEX_TAIL_LINES,
  })
}

/** Contraintes préemptives pour un projet : les rejets passés les plus récents
 *  (toutes branches), formatés pour injection dans les prompts d'audit. */
export function loadRetexConstraints(workspaceDir: string, signal: PhaseSignal): string {
  const all = loadAll(workspaceDir)
  if (all.length === 0) return ''
  // Priorité aux mêmes nom de projet, puis aux plus récents ; dédup par rejection_id.
  const seen = new Set<string>()
  const ranked = all
    .slice()
    .reverse()
    .filter(e => {
      if (seen.has(e.rejection_id)) return false
      seen.add(e.rejection_id)
      return true
    })
    .sort((a, b) => {
      const sa = a.projectName === signal.projectName ? 1 : 0
      const sb = b.projectName === signal.projectName ? 1 : 0
      return sb - sa
    })
    .slice(0, RETEX_INJECT_CAP)

  return ranked
    .map(e => `- [${e.branch}] ${e.rejection_id} (${e.rule_ref}) : ${e.corrective_action}`)
    .join('\n')
}
