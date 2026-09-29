// Cerveau d'audit de Mango QA (#165 — souveraineté).
//
// DÉCISION RAF 2026-09-29 : le cerveau d'audit est désormais Claude SONNET 5
// (`QA_MODEL`, abonnement Claude Code) — l'audit est le juge du harnais, il mérite
// le modèle le plus fiable, et le quota consommé reste borné (6 branches par audit).
//
// PRIMAIRE : askClaude (ABONNEMENT Claude Code, $0 crédits API — subscriptionEnv()
// neutralise les secrets pour ne jamais dériver vers les crédits payants NI fuiter
// un secret vers le SDK).
// REPLI : askOllama (ollama-client.ts, souverain, n'entame PAS le quota d'abonnement)
// — déclenché UNIQUEMENT si askClaude lève (abonnement en limite de fenêtre 5 h,
// réseau, SDK), ce qui est le cas réel observé le 2026-09-28 (« You've hit your
// session limit ») ; il ne doit jamais laisser un audit sans verdict.
// Un retour Illisible n'est PAS une indisponibilité : parseFirstJson/auditWithLLM
// le traitent en fail-open plus bas sans re-solliciter un second cerveau (axiome 16/17).
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { AuditContext, BranchFinding, BranchStatus } from './types.js'
import { askOllama } from './ollama-client.js'
import { decouperEnLots, agregerConstats, type ConstatLot } from './lots-audit.js'

const QA_MODEL = process.env.QA_MODEL ?? 'sonnet'
/** Plafond de caractères de code injectés dans un prompt d'audit (anti-saturation). */
const FILE_PAYLOAD_CAP = 24_000
/** D4 (B3) — nombre max de lots audités par branche : garde-fou de coût. Chaque lot
 *  tient dans FILE_PAYLOAD_CAP. Au-delà, les fichiers non vus sont COMPTÉS (couverture
 *  partielle assumée, jamais dissimulée). 8 lots ≈ 192 000 caractères vus par branche,
 *  contre 24 000 avant — de quoi couvrir etang-des-roseaux (12 %) ou toeic-quest (2 %). */
const MAX_LOTS_PAR_BRANCHE = Number(process.env.QA_MAX_LOTS ?? 8)

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

// limites.md L128 : le repli Claude tourne sur l'ABONNEMENT Claude Code — le MÊME
// compteur de session que l'usage interactif de Raf. Basculer dès le 1er échec Ollama
// confond un TIMEOUT/instabilité réseau transitoire (l'immense majorité des cas
// observés en réel) avec une VRAIE indisponibilité, et grille du quota partagé pour
// rien. Récidive constatée le 2026-07-16 (SOUV-D) : 5 échecs Ollama consécutifs →
// repli Claude → Claude a LUI-MÊME buté sur sa limite de session peu après. Ce
// nombre de tentatives + ce backoff sont un compromis pragmatique, pas une science —
// à resserrer si des replis restent encore trop fréquents en usage réel.
const OLLAMA_RETRY_ATTEMPTS = 2 // tentatives SUPPLÉMENTAIRES → 3 essais Ollama au total
const OLLAMA_RETRY_DELAY_MS = 1_500
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** (system, user) → texte. ORDRE 2026-09-29 : PRIMAIRE askClaude (Sonnet 5,
 *  abonnement — décision Raf : l'audit mérite le modèle le plus fiable), REPLI askOllama
 *  si Claude lève (limite de fenêtre 5 h, réseau, SDK). Ne lève QUE si les deux échouent.
 *  Dépendances injectables (tests) — défaut = le vrai dispatcher Claude/Ollama/setTimeout.
 *
 *  ⚠ Les noms `deps.ask`/`deps.askFallback` gardent leur sens HISTORIQUE (primaire =
 *  `ask`, repli = `askFallback`) : les tests existants injectent ce qu'ils veulent dans
 *  chaque slot et restent valides. Seuls les DÉFAUTS ont été inversés. */
export async function askLLM(
  system: string,
  user: string,
  deps: {
    ask?: (system: string, user: string) => Promise<string>
    askFallback?: (system: string, user: string) => Promise<string>
    sleep?: (ms: number) => Promise<void>
    retryAttempts?: number
    retryDelayMs?: number
  } = {},
): Promise<string> {
  const ask = deps.ask ?? askClaude
  const askFallback = deps.askFallback ?? askOllama
  const sleep = deps.sleep ?? defaultSleep
  const retryAttempts = deps.retryAttempts ?? OLLAMA_RETRY_ATTEMPTS
  const retryDelayMs = deps.retryDelayMs ?? OLLAMA_RETRY_DELAY_MS
  const maxTries = 1 + retryAttempts
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      return await ask(system, user)
    } catch (err) {
      const willRetry = attempt < maxTries
      console.warn(
        `[mango-qa] ${QA_MODEL} tentative ${attempt}/${maxTries} échouée (${(err as Error)?.message ?? err})` +
          (willRetry ? ` — nouvel essai dans ${retryDelayMs}ms.` : ' — repli Ollama (souverain).'),
      )
      if (willRetry) await sleep(retryDelayMs)
    }
  }
  return askFallback(system, user)
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
 *  bloquer la production à cause de sa PROPRE défaillance).
 *  `ask` (optionnel, défaut askLLM = Ollama primaire + repli Claude) — injectable
 *  pour les tests, zéro réseau, comme auditFluxDeep. */
export async function auditWithLLM(
  meta: BranchMeta,
  ctx: AuditContext,
  ask: (system: string, user: string) => Promise<string> = askLLM,
): Promise<BranchFinding> {
  if (ctx.files.length === 0) {
    return { status: 'not_applicable', summary: 'Aucun fichier pertinent pour cette branche.' }
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
  // ── D4 (audit 2026-09-28, B3) : LOTS successifs, plus un préfixe unique ────
  // Avant : `renderFiles` s'arrêtait au premier fichier qui déborde → 12 % du projet
  // vu sur etang-des-roseaux, 2 % sur toeic-quest, et l'audit ne le savait même pas.
  // Maintenant : on TRIE par risque (sortByPriority, écrit pour ça et jamais branché)
  // puis on découpe en lots bornés, et chaque lot est audité. Les constats sont agrégés
  // par une règle de sûreté (un `fail` gagne, un `pass` exige l'unanimité).
  const payloadFiles = ctx.files.map(f => ({ ...f, content: redactSecrets(f.content) }))
  const lots = decouperEnLots(payloadFiles, FILE_PAYLOAD_CAP, MAX_LOTS_PAR_BRANCHE)
  // Couverture partielle : soit le cap a mordu DANS un fichier, soit des fichiers n'ont
  // pas été vus faute de lots. Dans les deux cas l'audit ne peut pas conclure « conforme ».
  const coverageIncomplete = lots.tronque || lots.fichiersOmis > 0
  const coverageBlock = coverageIncomplete
    ? `\n\n⚠️ COUVERTURE PARTIELLE : tu ne vois qu'une PARTIE du projet${lots.tronque ? ' (le dernier fichier du lot est coupé en plein milieu)' : ''}. Le reste ne t'a PAS été montré. En conséquence : ne déclare JAMAIS "skip" (hors de ta spécialité) — tu n'as pas vu assez pour l'affirmer. Si tu ne peux pas juger, réponds "fail" en expliquant dans correctiveAction quelle partie du projet il faut te montrer.`
    : ''

  try {
    // Un appel par lot, borné. Le premier lot est le plus prioritaire (risque décroissant).
    const constats: ConstatLot[] = []
    for (let i = 0; i < lots.lots.length; i++) {
      const numero = lots.lots.length > 1 ? ` [lot ${i + 1}/${lots.lots.length}]` : ''
      const user = `Projet : ${ctx.signal.projectName} — phase : ${ctx.signal.phase} (tentative ${ctx.signal.retryCount}).${retexBlock}${testsSignalBlock}${coverageBlock}\n\nFichiers livrés à auditer${numero} :\n${lots.lots[i]}`
      const raw = await ask(system, user)
      const parsed = parseFirstJson<{
        status?: string
        summary?: string
        rejectionId?: string
        correctiveAction?: string
        ruleRef?: string
      }>(raw)
      if (!parsed) {
        constats.push({ status: 'skip', summary: `Réponse d'audit illisible (lot ${i + 1}).` })
        continue
      }
      let status = (typeof parsed.status === 'string' ? parsed.status.toLowerCase() : 'skip') as BranchStatus
      // Un « skip » du modèle = hors spécialité. Si la couverture était partielle, ce
      // jugement est invérifiable (il n'a pas vu le projet) → il reste 'skip', donc le
      // verdict global reste 'unknown' et jamais 'green'.
      if (status === 'skip' && parsed.status === 'skip') {
        status = coverageIncomplete ? 'skip' : 'not_applicable'
      } else if (!['pass', 'fail'].includes(status)) status = 'skip'
      // Une branche de conseil ne bloque jamais.
      if (meta.adviceOnly && status === 'fail') status = 'pass'
      constats.push({
        status,
        summary: (parsed.summary ?? '').trim() || (status === 'pass' ? 'Conforme.' : 'Sans détail.'),
        rejectionId: parsed.rejectionId?.trim(),
        correctiveAction: parsed.correctiveAction?.trim(),
        ruleRef: parsed.ruleRef?.trim(),
      })
    }
    // Agrégation : fusion des constats de tous les lots en UN constat de branche.
    const agrege = agregerConstats(constats, coverageIncomplete)
    const finding: BranchFinding = { status: agrege.status, summary: agrege.summary }
    if (agrege.status === 'fail') {
      finding.rejectionId = (agrege.rejectionId ?? `${meta.id}-anomalie`).trim()
      finding.correctiveAction = (agrege.correctiveAction ?? finding.summary).trim()
      finding.ruleRef = (agrege.ruleRef ?? meta.id).trim()
    }
    return finding
  } catch (err) {
    return {
      status: 'skip',
      summary: `Audit ignoré (erreur interne : ${err instanceof Error ? err.message : String(err)}).`,
    }
  }
}
