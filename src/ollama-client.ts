// Cerveau d'audit SOUVERAIN de Mango QA (#165) — routage Ollama, chemin PRIMAIRE.
// Adapté de server/src/ollama.ts (MangoOS) : même endpoint /api/chat, même contrat.
// Trimé au strict nécessaire pour MangoQA (chat texte simple) — pas de function-
// calling ni de vision, qu'aucune branche d'audit n'utilise.
//
// Authentification : AUCUNE dans ce module — les modèles ":cloud" (ex. qwen3.5:cloud)
// passent par le daemon Ollama LOCAL (localhost:11434), qui gère lui-même la bascule
// vers le cloud une fois authentifié (`ollama signin`, une fois, hors du code). Même
// mécanisme que MangoOS pour ses rôles "vision"/"auditeur"/"juge" (brain-registry.json).
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434'
const DEFAULT_MODEL = process.env.QA_OLLAMA_MODEL ?? 'qwen3.5:cloud'

/** Un appel chat non-streamé à Ollama. Lève si Ollama est injoignable, renvoie une
 *  erreur HTTP, ou dépasse le délai — c'est ce throw que `askLLM` (llm.ts) utilise
 *  comme signal de bascule vers le repli Claude. */
// (#165, preuve live 2026-07-08) 180s (défaut cold-start côté MangoOS interne, non
// contraint) est TROP LONG ici : MangoQA doit rendre un verdict avant QA_VERDICT_TIMEOUT
// (60s par défaut côté MangoOS) — un essai Ollama qui va au bout de 180s avant de
// basculer sur le repli Claude dépasse ce budget à lui seul (mesuré : 206s au total
// sur un vrai audit, échec du timeout global). 25s laisse une vraie marge pour un
// appel qwen3.5:cloud CHAUD (mesuré : 9,3s) tout en laissant du temps au repli Claude.
const DEFAULT_TIMEOUT_MS = Number(process.env.QA_OLLAMA_TIMEOUT_MS ?? 25_000)

export async function askOllama(system: string, user: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        stream: false,
        options: { temperature: 0 },
        keep_alive: '10m',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`)
    const data = (await res.json()) as { message?: { content?: string } }
    return (data.message?.content ?? '').trim()
  } finally {
    clearTimeout(timer)
  }
}
