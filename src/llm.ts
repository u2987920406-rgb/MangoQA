// Cerveau d'audit de Mango QA.
//
// Réplique le pattern askClaude de MangoOS (server/src/llm-engine.ts) : query()
// via l'ABONNEMENT Claude Code ($0, pas de crédits API). La présence de
// ANTHROPIC_API_KEY détournerait silencieusement vers les crédits payants —
// subscriptionEnv() la neutralise.
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { AuditContext, BranchFinding, BranchStatus } from './types.js'

const QA_MODEL = process.env.QA_MODEL ?? 'sonnet'
/** Plafond de caractères de code injectés dans un prompt d'audit (anti-saturation). */
const FILE_PAYLOAD_CAP = 24_000

/** Secrets à neutraliser de l'environnement transmis au SDK (liste non-exhaustive). */
const SECRET_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'STRIPE_SECRET_KEY',
  'STRIPE_API_KEY',
  'VERCEL_TOKEN',
  'VERCEL_ACCESS_TOKEN',
  'KREA_API_KEY',
  'BWS_ACCESS_TOKEN',
  'MANGO_VAULT_KEY',
  'ELEVE_API_KEY',
  'TAVILY_API_KEY',
  'OPENAI_API_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'DATABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'POSTGRES_PASSWORD',
  'NPM_TOKEN',
]

function subscriptionEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const key of SECRET_ENV_KEYS) delete env[key]
  // Suppression en plus de toute var dont le nom contient SECRET/TOKEN/PASSWORD/KEY/API_KEY.
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase()
    if (
      upper.includes('SECRET') ||
      upper.includes('PASSWORD') ||
      upper.includes('_TOKEN') ||
      upper.endsWith('_KEY') ||
      upper === 'APIKEY' ||
      upper.endsWith('_API_KEY')
    ) {
      delete env[key]
    }
  }
  // Préserve explicitement les vars non-secrets utiles au SDK.
  env.OLLAMA_URL = process.env.OLLAMA_URL
  env.PORT = process.env.PORT
  env.HOST = process.env.HOST
  return env
}

/** Supprime les secrets visibles dans le code source avant injection dans le prompt LLM.
 * _patterns est appliqué séquentiellement ; l'ordre n'a pas d'importance car les
 *  patterns sont disjoints (formats tokenisés vs assignments génériques). */
const SECRET_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // Clés OpenAI / Anthropic "sk-..."
  { re: /sk-[a-zA-Z0-9]{20,}/g, replacement: 'sk-«redacted»' },
  // GitHub PAT "ghp_..."
  { re: /ghp_[a-zA-Z0-9]{36}/g, replacement: 'ghp_«redacted»' },
  // GitHub fine-grained "github_pat_..."
  { re: /github_pat_[a-zA-Z0-9_]{22,}/g, replacement: 'github_pat_«redacted»' },
  // Tokens Bearer dans les headers HTTP
  { re: /Bearer\s+[A-Za-z0-9._-]+/gi, replacement: 'Bearer «redacted»' },
  // Assignments génériques apiKey|token|secret|password|apikey = "..."
  // Capture group $1 = nom de la clé (api_key, token, secret, password, apikey)
  {
    re: /\b(api[_-]?key|token|secret|password|apikey)\s*[=:]\s*["'][^"']*["']/gi,
    replacement: '$1 = "«redacted»"',
  },
]

export function redactSecrets(code: string): string {
  let out = code
  for (const { re, replacement } of SECRET_PATTERNS) {
    // réinitialise lastIndex car les regex sont globales et réutilisées
    re.lastIndex = 0
    out = out.replace(re, replacement)
  }
  return out
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

/** Concatène les fichiers pertinents en un payload borné pour le prompt.
 *  Les secrets visibles dans le code source sont rédatés AVANT injection. */
function renderFiles(files: AuditContext['files']): string {
  let out = ''
  for (const f of files) {
    const content = redactSecrets(f.content)
    const header = `\n----- ${f.path} -----\n`
    if (out.length + header.length + content.length > FILE_PAYLOAD_CAP) {
      const room = Math.max(0, FILE_PAYLOAD_CAP - out.length - header.length)
      if (room > 200) out += header + content.slice(0, room) + '\n…(tronqué)…\n'
      break
    }
    out += header + content
  }
  return out
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
  const user = `Projet : ${ctx.signal.projectName} — phase : ${ctx.signal.phase} (tentative ${ctx.signal.retryCount}).${retexBlock}\n\nFichiers livrés à auditer :\n${renderFiles(ctx.files)}`

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
