// Cerveau d'audit de Mango QA.
//
// Réplique le pattern askClaude de MangoOS (server/src/llm-engine.ts) : query()
// via l'ABONNEMENT Claude Code ($0, pas de crédits API). La présence de
// ANTHROPIC_API_KEY détournerait silencieusement vers les crédits payants —
// subscriptionEnv() la neutralise.
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { AuditContext, BranchFinding, BranchStatus } from './types.js'
import { renderFiles } from './fs-shared.js'

const QA_MODEL = process.env.QA_MODEL ?? 'sonnet'
/** Plafond de caractères de code injectés dans un prompt d'audit (anti-saturation). */
const FILE_PAYLOAD_CAP = 24_000

function subscriptionEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  return env
}

/** (system, user) → texte, via l'abonnement Claude Code. Lève en cas d'échec. */
export async function askClaude(system: string, user: string): Promise<string> {
  const env = subscriptionEnv()
  const q = query({
    prompt: user,
    options: {
      model: QA_MODEL,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: system },
      maxTurns: 1,
      allowedTools: [],
      env,
    },
  })
  let text = ''
  for await (const m of q) {
    if (m.type === 'assistant') {
      const content =
        (m as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content ?? []
      for (const b of content) if (b.type === 'text' && b.text) text += b.text
    }
  }
  return text.trim()
}

/** Extrait le premier objet JSON d'une sortie LLM bruitée (robuste au texte autour). */
export function parseFirstJson<T>(raw: string): T | null {
  const start = raw.indexOf('{')
  if (start === -1) return null
  // Recherche de l'accolade fermante équilibrée.
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < raw.length; i++) {
    const c = raw[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1)) as T
        } catch {
          return null
        }
      }
    }
  }
  return null
}

const JSON_CONTRACT = `
Réponds UNIQUEMENT par un objet JSON valide, sans aucun texte autour :
{
  "status": "pass" | "fail" | "skip",
  "summary": "<une phrase courte en français>",
  "rejectionId": "<identifiant-court-kebab si fail, ex: missing-form-label>",
  "correctiveAction": "<action corrective CHIRURGICALE et précise si fail>",
  "ruleRef": "<référence de règle si fail, ex: WCAG 2.2 1.3.1>"
}
Règles de décision (scepticisme méthodique, raisonnement par falsification) :
- "skip" si la phase ne concerne pas ta spécialité (aucun élément pertinent à auditer).
- "fail" UNIQUEMENT pour une violation CONCRÈTE, vérifiable et citable dans le code fourni. En cas de doute, ne bloque pas.
- "pass" si rien de bloquant dans ton domaine.
- N'invente jamais un défaut. Tu cites ce que tu vois, pas ce que tu supposes.`

export interface BranchMeta {
  id: string
  /** Spécialité + famille de règles + ce qui constitue un fail dans ce domaine. */
  specialty: string
  /** design-system : conseil seulement → ne renvoie jamais "fail". */
  adviceOnly?: boolean
  /** #10 — branche Tests uniquement : injecte dans le prompt si des tests
   *  existent AILLEURS dans le projet (hors delta), pour éviter un Feu Rouge
   *  fantôme quand la branche ne voit qu'un delta sans fichier `*.test.*`. */
  includeTestsSignal?: boolean
}

/** Exécute un audit LLM générique pour une branche. Ne throw jamais : toute
 *  erreur (réseau, parsing) devient un "skip" (fail-open — Mango QA ne doit pas
 *  bloquer la production à cause de sa PROPRE défaillance). */
export async function auditWithLLM(meta: BranchMeta, ctx: AuditContext): Promise<BranchFinding> {
  if (ctx.files.length === 0) {
    return { status: 'skip', summary: 'Aucun fichier pertinent pour cette branche.' }
  }
  const adviceClause = meta.adviceOnly
    ? '\nIMPORTANT : tu donnes des CONSEILS, tu ne bloques jamais. N\'utilise que "pass" (avec tes suggestions dans summary) ou "skip", JAMAIS "fail".'
    : ''
  const system = `Tu es un auditeur QA spécialisé (Audit Fantôme, posture Zero-Trust). ${meta.specialty}${adviceClause}\n${JSON_CONTRACT}`
  const retexBlock = ctx.retex
    ? `\n\nErreurs historiques à vérifier en priorité (Boîte Noire / Retex) :\n${ctx.retex}`
    : ''
  // #10 — désamorce le Feu Rouge fantôme : la branche Tests ne voit que le
  // delta de cette phase, mais le projet peut avoir des tests ailleurs.
  const testsSignalBlock =
    meta.includeTestsSignal && ctx.testsElsewhereInProject !== undefined
      ? ctx.testsElsewhereInProject
        ? "\n\nSignal projet (hors delta) : des fichiers de test (*.test.*/*.spec.*) EXISTENT ailleurs dans ce projet. Ne conclus PAS à une absence totale de tests sur la seule base de ce delta — juge seulement si LA LOGIQUE LIVRÉE ICI aurait dû être testée."
        : "\n\nSignal projet (hors delta) : aucun fichier de test (*.test.*/*.spec.*) n'existe nulle part dans ce projet."
      : ''
  const user = `Projet : ${ctx.signal.projectName} — phase : ${ctx.signal.phase} (tentative ${ctx.signal.retryCount}).${retexBlock}${testsSignalBlock}\n\nFichiers livrés à auditer :\n${renderFiles(ctx.files, FILE_PAYLOAD_CAP)}`

  try {
    const raw = await askClaude(system, user)
    const parsed = parseFirstJson<{
      status?: string
      summary?: string
      rejectionId?: string
      correctiveAction?: string
      ruleRef?: string
    }>(raw)
    if (!parsed) return { status: 'skip', summary: 'Réponse d\'audit illisible (ignorée).' }

    let status = (parsed.status ?? 'pass').toLowerCase() as BranchStatus
    if (!['pass', 'fail', 'skip'].includes(status)) status = 'pass'
    // Une branche de conseil ne bloque jamais.
    if (meta.adviceOnly && status === 'fail') status = 'pass'

    const finding: BranchFinding = {
      status,
      summary: (parsed.summary ?? '').trim() || (status === 'pass' ? 'Conforme.' : 'Sans détail.'),
    }
    if (status === 'fail') {
      finding.rejectionId = (parsed.rejectionId ?? `${meta.id}-anomalie`).trim()
      finding.correctiveAction = (parsed.correctiveAction ?? finding.summary).trim()
      finding.ruleRef = (parsed.ruleRef ?? meta.id).trim()
    }
    return finding
  } catch (err) {
    return {
      status: 'skip',
      summary: `Audit ignoré (erreur interne : ${err instanceof Error ? err.message : String(err)}).`,
    }
  }
}
