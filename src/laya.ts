// Visage 4 — Laya (SHADOW) : 2ᵉ avis calibré à CÔTÉ du verdict, jamais dedans.
//
// Pourquoi SHADOW et pas décisionnaire : le checkpoint Laya en zéro-shot est
// ≈ hasard sur typed-decisions (0.362 vs 0.318 random — README « Honest
// Limits »). La capacité vient du fine-tuning. On journalise donc LLM ⟷ Laya
// dans `.mangoqa/laya-shadow.jsonl` : c'est le dataset qui servira à affiner
// Laya sur le corpus MangoQA.
//
// Contrat non négociable :
//   - NE JAMAIS modifier `audit-verdict.json` (contrat figé MangoOS) ;
//   - échec → console.warn + rien de plus (#Q3 : fail-open, jamais silencieux) ;
//   - gaté par QA_LAYA=on — défaut off = comportement historique inchangé.
//
// Le pont Python (laya-bridge/server.py) expose POST /decide : toutes les
// questions d'un appel partagent UN SEUL forward pass (force de Laya).
import type { PhaseSignal, ProjectFile } from './types.js'
import type { BranchResult } from './verdict.js'

/** Surface fs minimaliste pour le journal shadow (FsLike est assignable ici). */
export interface ShadowFs {
  existsSync(p: string): boolean
  writeFileSync(p: string, data: string): void
  mkdirSync(p: string): string | void
  /** Absent des fakes de test → journalisation sautée (warn, pas de crash). */
  appendFileSync?(p: string, data: string): void
}

export interface LayaAnswer {
  type?: 'noul' | 'choice' | 'score'
  noul?: number
  choice?: string
  probabilities?: Record<string, number>
  confidence?: number
}

export interface LayaReply {
  answers: Record<string, LayaAnswer>
  ms?: number
  model?: string
}

/** Une ligne du journal shadow — une par branche soumise, jamais plus. */
export interface ShadowRecord {
  ts: string
  project: string
  phase: string
  retry: number
  branch: string
  /** Verdict du LLM (source de vérité actuelle). */
  llm: string
  /** P(violation) retournée par Laya (noul) — null si indisponible. */
  violation: number | null
  confidence: number | null
  /** Choix Laya : confirmé / infirmé vs le verdict LLM. */
  verdict: string | null
  /** Latence du pont (ms). */
  ms: number
}

export const SHADOW_FILE = 'laya-shadow.jsonl'

export function layaEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.QA_LAYA === 'on'
}

export function layaUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.QA_LAYA_URL ?? 'http://127.0.0.1:8791').replace(/\/$/, '')
}

/** État compact passé à Laya — budget ~768 tokens (checkpoint multilingual).
 *  MangoQA injecte 24 k de caractères aux branches : on n'en garde qu'un
 *  extrait, sinon le modèle tronque arbitrairement la queue. */
export function buildState(args: {
  signal: PhaseSignal
  branchId: string
  label: string
  finding: { status: string; summary: string; correctiveAction?: string }
  files: ProjectFile[]
  maxChars?: number
}): string {
  const max = args.maxChars ?? 1_400
  const excerpt = args.files
    .slice(0, 3)
    .map(f => `--- ${f.path}\n${f.content}`)
    .join('\n')
    .slice(0, max)
  const lines = [
    `Project: ${args.signal.projectName} | Phase: ${args.signal.phase} | Retry: ${args.signal.retryCount}`,
    `Branch: ${args.branchId} (${args.label}) — audit finding: ${args.finding.status}`,
    `Summary: ${args.finding.summary.slice(0, 400)}`,
    args.finding.correctiveAction ? `Corrective action: ${args.finding.correctiveAction.slice(0, 300)}` : '',
    `Code excerpt:\n${excerpt || '(no file selected for this branch)'}`,
  ].filter(Boolean)
  return lines.join('\n\n')
}

/** 2 questions résolues en UN forward pass. Les intitulés sont en anglais :
 *  le checkpoint racine est anglais-only (README « Honest Limits »). */
export function buildQuestions(): Record<string, unknown> {
  return {
    violation: {
      type: 'noul',
      instructions:
        'Does this QA finding describe a concrete violation actually present in the provided code?',
    },
    verdict: {
      type: 'choice',
      instructions: 'Given the code, is the auditor verdict justified?',
      criteria: {
        keep: 'the finding is real, the verdict stands',
        override: 'false positive, no real violation in the code',
      },
    },
  }
}

export interface ShadowArgs {
  signal: PhaseSignal
  results: BranchResult[]
  /** Fichiers pertinents PAR branche (re-filtrés via branch.relevant). */
  relevantOf: (branchId: string) => ProjectFile[]
  fs: ShadowFs
  projDir: string
  log?: (line: string) => void
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => Date
}

/** Soumet chaque branche BLOQUANTE à Laya et journalise. Renvoie les enregistrements.
 *  Ne throw JAMAIS (fail-open) : un pont mort = warn + sortie silencieuse. */
export async function shadowWithLaya(args: ShadowArgs): Promise<ShadowRecord[]> {
  const env = args.env ?? process.env
  if (!layaEnabled(env)) return []
  const log = args.log ?? (l => console.log(l))
  const warn = (m: string) => console.warn(`[mango-qa] laya: ${m}`)
  const doFetch = args.fetchImpl ?? fetch
  const url = `${layaUrl(env)}/decide`
  const out: ShadowRecord[] = []

  for (const { branch, finding } of args.results) {
    // Seules les branches BLOQUANTES pèsent sur red/green → elles seules
    // valent la peine d'être étiquetées pour le futur fine-tuning.
    if (!branch.blocking) continue
    if (finding.status !== 'fail' && finding.status !== 'pass') continue

    const state = buildState({
      signal: args.signal,
      branchId: branch.id,
      label: branch.label,
      finding,
      files: args.relevantOf(branch.id),
    })

    let reply: LayaReply | null = null
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, questions: buildQuestions() }),
        signal: AbortSignal.timeout(Number(env.QA_LAYA_TIMEOUT_MS ?? 5_000)),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      reply = (await res.json()) as LayaReply
    } catch (err) {
      // #Q3 : on avale (le verdict LLM est déjà écrit) mais JAMAIS silencieux.
      warn(`branche ${branch.id}: ${(err as Error)?.message ?? err}`)
      continue
    }

    const v = reply.answers?.violation
    const verdict = reply.answers?.verdict
    const rec: ShadowRecord = {
      ts: (args.now?.() ?? new Date()).toISOString(),
      project: args.signal.projectName,
      phase: args.signal.phase,
      retry: args.signal.retryCount,
      branch: branch.id,
      llm: finding.status,
      violation: typeof v?.noul === 'number' ? v.noul : null,
      confidence: typeof v?.confidence === 'number' ? v.confidence : null,
      verdict: verdict?.choice ?? null,
      ms: reply.ms ?? 0,
    }
    out.push(rec)

    // Journalisation best-effort : appendFileSync absent (fake de test) → warn.
    try {
      const dir = `${args.projDir}/.mangoqa`
      const file = `${dir}/${SHADOW_FILE}`
      if (!args.fs.existsSync(dir)) args.fs.mkdirSync(dir)
      if (typeof args.fs.appendFileSync !== 'function') {
        warn('appendFileSync absent du fs fourni — ligne shadow non journalisée')
      } else {
        args.fs.appendFileSync(file, `${JSON.stringify(rec)}\n`)
      }
    } catch (err) {
      warn(`journalisation: ${(err as Error)?.message ?? err}`)
    }

    const agrees =
      (rec.llm === 'fail' && rec.verdict === 'keep') || (rec.llm === 'pass' && rec.verdict === 'override')
    const flag = agrees ? '＝' : '≠'
    log(
      `  🔀 laya ${branch.id}: LLM=${rec.llm} ${flag} Laya=${rec.verdict} ` +
        `(P(violation)=${rec.violation ?? 'n/a'}, conf=${rec.confidence ?? 'n/a'}, ${rec.ms}ms)`,
    )
  }
  return out
}
