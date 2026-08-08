// Cerveau d'audit de Mango QA — CHOIX de l'utilisateur, plus une hiérarchie figée.
//
// (2026-08-05, décision de cadrage) Le cerveau est désormais SÉLECTIONNABLE par
// `QA_BRAIN`, et le choix par défaut recommandé est **Claude Opus 5**. Ce qui a
// changé : un cerveau local ne fait pas le poids face à un cerveau cloud sur la
// qualité de jugement, et le nier ne servait que l'argument de souveraineté. Cet
// argument reste servi — `QA_BRAIN=ollama` fait tourner l'audit sans qu'un octet
// de code quitte la machine — mais il devient une OPTION assumée, pas la promesse.
//
//   QA_BRAIN=claude   → Claude en PRIMAIRE (défaut recommandé, `QA_MODEL`)
//   QA_BRAIN=ollama   → Ollama en primaire, Claude en repli (comportement historique,
//                       conservé par défaut pour ne pas casser l'intégration MangoOS)
//
// Pourquoi le repli n'existe QUE dans le sens ollama → claude : le repli sert à
// couvrir une INDISPONIBILITÉ du primaire. Quand le primaire est déjà le cerveau le
// plus capable, se rabattre sur un modèle plus faible rendrait un verdict de moindre
// qualité SANS le dire — exactement le mensonge par omission que ce produit combat.
// Claude en primaire échoue donc visiblement, et `auditWithLLM` en fait un `skip`
// déclaré.
//
// `askClaude` tourne sur l'ABONNEMENT Claude Code ; `subscriptionEnv()` neutralise
// les secrets pour ne jamais dériver vers des crédits payants NI fuiter un secret
// vers le SDK. Le repli (mode ollama) ne se déclenche QUE si askOllama lève
// (injoignable / HTTP en erreur / timeout) — jamais sur une réponse simplement
// illisible : ça, c'est un problème de FORMAT, pas de DISPONIBILITÉ, et
// parseFirstJson/auditWithLLM le traitent déjà plus bas.
// (2026-08-05, J3 packaging) Import de TYPE seulement — effacé à la compilation. Le SDK
// est chargé DYNAMIQUEMENT dans askClaude, et déclaré en dépendance de pair OPTIONNELLE.
//
// Motif mesuré : `@anthropic-ai/claude-agent-sdk` pèse **280 Mo** installé, à lui seul
// 79 % du poids de la CLI. Or c'est le cerveau de REPLI : le chemin primaire est Ollama,
// joint en HTTP sans aucune dépendance. Imposer 280 Mo à quelqu'un qui audite en local
// contredit frontalement l'argument de souveraineté du produit. Qui veut le repli
// l'installe ; les autres tournent en `QA_LOCAL_ONLY` et ne le voient jamais.
import type { query as QueryFn } from '@anthropic-ai/claude-agent-sdk'
import type { AuditContext, AuditCoverage, BranchFinding, BranchStatus, CitationsConventions } from './types.js'
import { askOllama } from './ollama-client.js'
import { renderFilesWithCoverage } from './fs-shared.js'
import { conventionsBlock, indexer } from './conventions.js'

/** Modèle Claude utilisé, en primaire comme en repli. Lecture PARESSEUSE : un
 *  appelant (CLI, test, harnais) doit pouvoir le fixer avant le premier usage. */
const qaModel = (): string => process.env.QA_MODEL ?? 'claude-opus-5'

/** Les cerveaux sélectionnables. Ajouter une entrée ici est le seul endroit à
 *  toucher pour en proposer un nouveau (passerelle OpenAI, etc.). */
export const CERVEAUX = ['claude', 'ollama'] as const
export type Cerveau = (typeof CERVEAUX)[number]

/** Cerveau PRIMAIRE choisi par l'utilisateur (`QA_BRAIN`).
 *
 *  Défaut `ollama` — comportement historique préservé, pour ne pas changer sous les
 *  pieds de l'intégration MangoOS ni des évals déjà mesurées. La CLI et la
 *  documentation, elles, recommandent `claude` : c'est un défaut de PRODUIT, pas un
 *  défaut de bibliothèque. Valeur inconnue → `ollama`, jamais une erreur silencieuse. */
export function cerveauPrimaire(): Cerveau {
  const brut = (process.env.QA_BRAIN ?? '').trim().toLowerCase()
  return (CERVEAUX as readonly string[]).includes(brut) ? (brut as Cerveau) : 'ollama'
}

/** Plafond de caractères de code injectés dans un prompt d'audit (anti-saturation).
 *
 *  (2026-08-05) Relevé de 24 000 à 100 000. Pourquoi maintenant, et pas avant :
 *
 *  • MESURE — la sonde plafond du 2026-08-04 (`eval/rapports/PLAFOND-CONTEXTE.md`)
 *    montre que le projet abyss ENTIER (20 fichiers, 95 731 car. rendus, 28 930
 *    tokens) passe en UN SEUL appel à `qwen2.5-coder:14b`, sans troncature
 *    silencieuse et sans forcer `num_ctx`. À 24 000, l'auditeur ne voyait que 27 %
 *    du code d'un projet réel — un cap hérité, jamais mesuré.
 *  • ORDRE — ce relèvement arrive APRÈS la déclaration de couverture, jamais avant.
 *    Relever le cap seul rendrait la troncature silencieuse plus RARE sans la rendre
 *    IMPOSSIBLE : au premier projet dépassant le nouveau cap, l'auditeur mentirait
 *    comme avant, en plus rare donc en moins détectable. Le pire des deux mondes.
 *
 *  Réglable par `QA_FILE_PAYLOAD_CAP` (caractères) : un cerveau à petite fenêtre
 *  peut avoir besoin de moins, un cerveau cloud d'accepter plus. Quelle que soit la
 *  valeur, la couverture reste MESURÉE et DÉCLARÉE — c'est ça qui rend le réglage
 *  sans danger. Valeur invalide/absente → 100 000. */
export const DEFAULT_FILE_PAYLOAD_CAP = 100_000
function filePayloadCap(): number {
  const raw = parseInt((process.env.QA_FILE_PAYLOAD_CAP ?? '').trim(), 10)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FILE_PAYLOAD_CAP
}

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

/** (2026-08-04) Mode SOUVERAIN STRICT — `QA_LOCAL_ONLY=on` : jamais de repli Claude.
 *
 *  Deux usages, l'un produit, l'autre méthodologique :
 *  • PRODUIT — un utilisateur qui veut la garantie qu'aucun octet de son code ne
 *    quitte sa machine. Pendant du gate BRAIN_LOCAL_ONLY côté MangoOS.
 *  • MESURE — sans ça, évaluer un cerveau local est IMPOSSIBLE : à chaque échec
 *    d'Ollama le repli Claude répond à sa place, et on croit mesurer le modèle local
 *    alors qu'on mesure Claude. L'échec doit rester VISIBLE pour être compté.
 *
 *  OFF (défaut) → comportement byte-identique : le repli Claude reste actif. */
function localOnly(): boolean {
  return /^(on|1|true|yes)$/i.test((process.env.QA_LOCAL_ONLY ?? '').trim())
}

/** (system, user) → texte, PRIMAIRE Ollama (retry + backoff avant d'abandonner) + REPLI
 *  Claude seulement après épuisement des tentatives. Ne lève QUE si Claude échoue aussi.
 *  Dépendances injectables (tests) — défaut = le vrai dispatcher Ollama/Claude/setTimeout. */
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
  // CERVEAU CLAUDE EN PRIMAIRE — pas de repli, et c'est délibéré. Se rabattre sur un
  // modèle moins capable rendrait un verdict de moindre qualité sans le déclarer.
  // L'échec reste visible ; `auditWithLLM` le transforme en `skip` déclaré.
  // (`deps.ask` reste prioritaire : les tests injectent leur propre cerveau.)
  if (!deps.ask && cerveauPrimaire() === 'claude') {
    return askClaude(system, user)
  }

  const ask = deps.ask ?? askOllama
  const askFallback = deps.askFallback ?? askClaude
  const sleep = deps.sleep ?? defaultSleep
  const retryAttempts = deps.retryAttempts ?? OLLAMA_RETRY_ATTEMPTS
  const retryDelayMs = deps.retryDelayMs ?? OLLAMA_RETRY_DELAY_MS
  const maxTries = 1 + retryAttempts
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      return await ask(system, user)
    } catch (err) {
      const willRetry = attempt < maxTries
      const strict = localOnly()
      console.warn(
        `[mango-qa] Ollama tentative ${attempt}/${maxTries} échouée (${(err as Error)?.message ?? err})` +
          (willRetry
            ? ` — nouvel essai dans ${retryDelayMs}ms.`
            : strict
              ? ' — QA_LOCAL_ONLY=on : AUCUN repli, échec assumé.'
              : ' — repli Claude.'),
      )
      // Souveraineté stricte : on lève au lieu de sortir vers un cloud. L'appelant
      // (auditWithLLM) est déjà fail-open — l'audit devient un `skip`, jamais un crash.
      if (!willRetry && strict) throw err
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

/** Charge le SDK Claude à la demande. Lève un message ACTIONNABLE s'il n'est pas
 *  installé — pas un `ERR_MODULE_NOT_FOUND` brut, qui laisserait l'utilisateur croire
 *  à un bug de Mango QA plutôt qu'à un paquet optionnel qu'il n'a pas voulu. */
async function chargerSdkClaude(): Promise<typeof QueryFn> {
  try {
    const mod = await import('@anthropic-ai/claude-agent-sdk')
    return mod.query
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw new Error(
        "Repli Claude indisponible : @anthropic-ai/claude-agent-sdk n'est pas installé " +
          '(dépendance optionnelle, ~280 Mo). Deux issues : `npm i @anthropic-ai/claude-agent-sdk` ' +
          'pour activer le repli, ou `QA_LOCAL_ONLY=on` pour assumer le tout-local.',
      )
    }
    throw err
  }
}

/** (system, user) → texte, via l'abonnement Claude Code. Lève en cas d'échec. */
export async function askClaude(system: string, user: string): Promise<string> {
  const query = await chargerSdkClaude()
  const env = subscriptionEnv()
  const q = query({
    prompt: user,
    options: {
      model: qaModel(),
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
  "ruleRef": "<référence de règle si fail, ex: WCAG 2.2 1.3.1>",
  "conventionRefs": ["<identifiants [fichier:ligne] des conventions du dépôt invoquées, [] sinon>"]
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

/** Phrase de couverture INJECTÉE DANS LE PROMPT quand la lecture est partielle.
 *
 *  (2026-08-05, J1 défaut n°2) Déclarer la couverture dans le rapport ne suffit
 *  pas : tant que le modèle croit voir tout le projet, il conclut par ABSENCE
 *  (« aucun fichier de test n'existe », « aucune validation nulle part ») alors
 *  qu'il n'a lu qu'une fraction du code. C'est un faux positif fabriqué par notre
 *  propre cap, pas par le modèle. On le désamorce comme le signal Tests de #10 :
 *  en disant au juge ce qu'il ne voit pas.
 *
 *  EXPORTÉE et paramétrée pour que les DEUX visages qui rendent un payload borné
 *  (les 6 branches ici, l'Auditeur de Flux dans flux-eye/deep.ts) partagent le même
 *  texte. Deux formulations divergentes de la même garantie, c'est une garantie qu'on
 *  corrige à un seul endroit sur deux.
 *
 *  Couverture complète → chaîne vide, prompt byte-identique à avant. */
export function coverageBlock(
  cov: AuditCoverage,
  opts: {
    /** Consigne finale, propre au vocabulaire du visage (verdict `fail` vs observation). */
    consigne?: string
    /** Nom du signal DÉTERMINISTE, calculé hors payload, auquel le modèle peut se fier. */
    signalDeterministe?: string
  } = {},
): string {
  if (cov.complete) return ''
  const pct = cov.charsTotal > 0 ? Math.round((cov.charsRendered / cov.charsTotal) * 100) : 0
  const lines = [
    `\n\nCOUVERTURE DE CETTE LECTURE : tu ne vois que ${cov.filesRendered} des ${cov.filesTotal} fichiers pertinents (${pct} % du code).`,
  ]
  if (cov.omitted.length > 0) {
    const shown = cov.omitted.slice(0, 15)
    lines.push(
      `Fichiers NON fournis : ${shown.join(', ')}${cov.omitted.length > shown.length ? `, … (+${cov.omitted.length - shown.length})` : ''}.`,
    )
  }
  const cut = [...new Set([...cov.truncated, ...cov.sourceTruncated])]
  if (cut.length > 0) lines.push(`Fichiers fournis mais COUPÉS avant la fin : ${cut.join(', ')}.`)
  const consigne =
    opts.consigne ?? 'Ne signale un "fail" que sur une violation VISIBLE dans les fichiers ci-dessous.'
  const signal = opts.signalDeterministe ?? '« Signal projet »'
  lines.push(
    "Conséquence sur ton jugement : ne conclus rien d'une absence constatée DANS CES FICHIERS. " +
      "N'écris pas « aucun X n'existe dans ce projet » sur la seule base de ce que tu reçois — le X " +
      `manquant est peut-être dans ce que tu ne reçois pas. ${consigne}`,
    // EXCEPTION indispensable, apprise à l'usage (run du 2026-08-05, cap 24 000) : sans elle,
    // la branche Tests répondait « impossible de conclure » alors qu'un « Signal projet » lui
    // disait, sur la foi d'un balayage COMPLET du disque, qu'aucun test n'existe nulle part.
    // Une interdiction trop large ne rend pas l'auditeur prudent, elle le rend muet — et un
    // auditeur muet ne vaut pas mieux qu'un auditeur qui se tait sur ce qu'il n'a pas lu.
    `EXCEPTION : un ${signal} énoncé plus haut porte sur TOUT le projet (il vient d'une ` +
      "analyse complète, pas de ces fichiers) — celui-là, tu peux t'y fier.",
  )
  return lines.join('\n')
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
    return {
      status: 'skip',
      summary: 'Aucun fichier pertinent pour cette branche.',
      abstention: { cause: 'hors-perimetre' },
    }
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
  // Le cap vient du CONTRAT d'audit quand l'appelant le fournit ; l'environnement n'est
  // plus qu'un repli (faille L2-a — un réglage global partagé entre deux audits
  // concurrents n'est pas un réglage, c'est une fuite).
  const { text: payload, coverage } = renderFilesWithCoverage(
    ctx.files.map(f => ({ ...f, content: redactSecrets(f.content) })),
    ctx.cap ?? filePayloadCap(),
  )
  const user = `Projet : ${ctx.signal.projectName} — phase : ${ctx.signal.phase} (tentative ${ctx.signal.retryCount}).${retexBlock}${testsSignalBlock}${conventionsBlock(ctx.conventions)}${coverageBlock(coverage)}\n\nFichiers livrés à auditer :\n${payload}`

  try {
    const raw = await ask(system, user)
    const parsed = parseFirstJson<{
      status?: string
      summary?: string
      rejectionId?: string
      correctiveAction?: string
      ruleRef?: string
      conventionRefs?: unknown
    }>(raw)
    // (2026-08-05, J4-a) Le cerveau a RÉPONDU, mais hors contrat. C'est une PANNE de
    // l'auditeur, pas un jugement : le déclarer comme tel est tout l'objet du lot 2.
    // Sans `abstention`, ce `skip` était indiscernable d'un « rien à signaler » et
    // six branches dans cet état rendaient un Feu Vert, code 0, sur du code fautif.
    if (!parsed) {
      return {
        status: 'skip',
        summary: "Réponse d'audit illisible : le cerveau n'a pas tenu le contrat JSON.",
        coverage,
        abstention: { cause: 'reponse-illisible', detail: apercu(raw) },
      }
    }

    let status = (parsed.status ?? 'pass').toLowerCase() as BranchStatus
    if (!['pass', 'fail', 'skip'].includes(status)) status = 'pass'
    // Une branche de conseil ne bloque jamais.
    if (meta.adviceOnly && status === 'fail') status = 'pass'

    const finding: BranchFinding = {
      status,
      summary: (parsed.summary ?? '').trim() || (status === 'pass' ? 'Conforme.' : 'Sans détail.'),
      coverage,
    }
    // Un `skip` CHOISI par le juge dans un JSON valide reste un jugement rendu — il ne
    // masque aucune panne, et le compter comme telle rendrait l'alarme inaudible.
    if (status === 'skip') finding.abstention = { cause: 'juge-sans-avis' }

    // (2026-08-08, lot 3) Les citations de conventions sont VÉRIFIÉES contre les règles
    // réellement extraites du dépôt. Un identifiant qui ne s'y trouve pas est écarté du
    // crédit de la trouvaille — et conservé, visible, dans `rejetees`.
    const citations = verifierCitations(parsed.conventionRefs, ctx)
    if (citations) finding.conventions = citations
    if (status === 'fail') {
      finding.rejectionId = (parsed.rejectionId ?? `${meta.id}-anomalie`).trim()
      finding.correctiveAction = (parsed.correctiveAction ?? finding.summary).trim()
      finding.ruleRef = (parsed.ruleRef ?? meta.id).trim()
    }
    return finding
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      status: 'skip',
      summary: `Audit impossible : le cerveau n'a pas répondu (${message}).`,
      coverage,
      abstention: { cause: 'cerveau-injoignable', detail: message },
    }
  }
}

/** Trie les identifiants de conventions cités par le modèle en VÉRIFIÉS / REJETÉS.
 *
 *  C'est le point de tout le lot 3. Une trouvaille du genre « ne respecte pas vos
 *  conventions » n'a de valeur que si l'utilisateur peut ouvrir le fichier à la ligne
 *  citée et constater lui-même. Un identifiant qui ne correspond à aucune règle
 *  extraite signe l'un des deux : une règle inventée, ou une ligne mal recopiée. Dans
 *  les deux cas la citation ne prouve rien, donc elle ne compte pas.
 *
 *  Rendre `undefined` quand il n'y a rien à dire garde le champ absent du JSON —
 *  aucun bruit sur les millions de trouvailles qui n'invoquent aucune convention. */
export function verifierCitations(
  brut: unknown,
  ctx: Pick<AuditContext, 'conventions'>,
): CitationsConventions | undefined {
  if (!Array.isArray(brut) || brut.length === 0) return undefined
  const connues = indexer(ctx.conventions?.rules ?? [])
  const citees: string[] = []
  const rejetees: string[] = []
  for (const item of brut) {
    if (typeof item !== 'string') continue
    // Tolérance de FORME uniquement : le modèle écrit souvent `[CLAUDE.md:42]` avec ses
    // crochets, tels qu'ils apparaissent dans le prompt. Ce n'est pas une invention, il
    // recopie ce qu'on lui a montré. Le FOND, lui, n'est pas négocié.
    const id = item.trim().replace(/^\[|\]$/g, '').trim()
    if (!id) continue
    if (connues.has(id)) {
      if (!citees.includes(id)) citees.push(id)
    } else if (!rejetees.includes(id)) {
      rejetees.push(id)
    }
  }
  if (citees.length === 0 && rejetees.length === 0) return undefined
  return { citees, rejetees }
}

/** Extrait court d'une réponse hors contrat, pour le diagnostic. Borné : cette chaîne
 *  finit dans un rapport, et y déverser 100 000 caractères de réponse le rendrait
 *  illisible — le but est de reconnaître le problème, pas de rejouer la réponse. */
function apercu(raw: string): string {
  const plat = raw.replace(/\s+/g, ' ').trim()
  return plat.length > 160 ? `${plat.slice(0, 160)}…` : plat || '(réponse vide)'
}
