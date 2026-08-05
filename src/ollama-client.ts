// Cerveau d'audit SOUVERAIN de Mango QA (#165) — routage Ollama, chemin PRIMAIRE.
// Adapté de server/src/ollama.ts (MangoOS) : même endpoint /api/chat, même contrat.
// Trimé au strict nécessaire pour MangoQA (chat texte simple) — pas de function-
// calling ni de vision, qu'aucune branche d'audit n'utilise.
//
// Authentification : AUCUNE dans ce module — les modèles ":cloud" (ex. qwen3.5:cloud)
// passent par le daemon Ollama LOCAL (localhost:11434), qui gère lui-même la bascule
// vers le cloud une fois authentifié (`ollama signin`, une fois, hors du code). Même
// mécanisme que MangoOS pour ses rôles "vision"/"auditeur"/"juge" (brain-registry.json).
// (2026-08-04) Lecture PARESSEUSE de la config, pas au chargement du module — même
// convention que `flags.ts` côté MangoOS, et pour la même raison : un appelant (test,
// harnais d'évaluation, script) doit pouvoir fixer `QA_OLLAMA_MODEL` avant le premier
// usage réel. En ESM, les imports sont évalués AVANT le corps du module appelant : une
// constante capturée ici ignorerait silencieusement toute configuration ultérieure.
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

const ollamaUrl = (): string => process.env.OLLAMA_URL ?? 'http://localhost:11434'
const defaultModel = (): string => process.env.QA_OLLAMA_MODEL ?? 'qwen3.5:cloud'

/** Un appel chat non-streamé à Ollama. Lève si Ollama est injoignable, renvoie une
 *  erreur HTTP, ou dépasse le délai — c'est ce throw que `askLLM` (llm.ts) utilise
 *  comme signal de bascule vers le repli Claude. */
// (#165, preuve live 2026-07-08) 180s (défaut cold-start côté MangoOS interne, non
// contraint) est TROP LONG ici : MangoQA doit rendre un verdict avant QA_VERDICT_TIMEOUT
// (60s par défaut côté MangoOS) — un essai Ollama qui va au bout de 180s avant de
// basculer sur le repli Claude dépasse ce budget à lui seul (mesuré : 206s au total
// sur un vrai audit, échec du timeout global). 25s laisse une vraie marge pour un
// appel qwen3.5:cloud CHAUD (mesuré : 9,3s) tout en laissant du temps au repli Claude.
const defaultTimeoutMs = (): number => Number(process.env.QA_OLLAMA_TIMEOUT_MS ?? 25_000)

// (2026-08-05) `fetch` ABANDONNÉ ici au profit de `node:http`.
//
// Undici (le fetch de Node) coupe la connexion au bout de 300 s si les EN-TÊTES ne sont
// pas arrivés — `UND_ERR_HEADERS_TIMEOUT` — et avec `stream: false` Ollama n'envoie ses
// en-têtes qu'une fois la réponse complète calculée. Ce plafond de 300 s est INVISIBLE
// dans le code et non désactivable par le `signal`. Il a déjà coûté une soirée de
// diagnostic sur la sonde plafond (cf. eval/rapports/PLAFOND-CONTEXTE.md), où il
// imitait à s'y méprendre une coupure machine.
//
// Il était dormant tant que le cap de prompt valait 24 000 caractères. En le portant à
// 100 000, on entre pile dans la zone où l'évaluation du prompt dure plus longtemps :
// ~140 s mesurées pour 28 900 tokens sur qwen2.5-coder:14b, génération en plus. Le
// laisser en place, c'est accepter que les gros audits échouent en `skip` fail-open —
// c'est-à-dire disparaissent sans bruit, exactement le défaut qu'on est en train de
// corriger, déplacé d'un cran.
//
// Avec `node:http`, le SEUL délai est le nôtre (`QA_OLLAMA_TIMEOUT_MS`), explicite et
// déclaré. Le contrat de sortie est inchangé : on lève, et `askLLM` bascule au repli.
function ollamaChat(body: unknown, timeoutMs: number): Promise<{ message?: { content?: string } }> {
  const url = new URL(ollamaUrl())
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest
    const req = transport(
      {
        host: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: '/api/chat',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      res => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', c => {
          raw += c
        })
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Ollama HTTP ${res.statusCode}`))
            return
          }
          try {
            resolve(JSON.parse(raw) as { message?: { content?: string } })
          } catch {
            reject(new Error(`Réponse Ollama illisible (HTTP ${res.statusCode})`))
          }
        })
      },
    )
    // Notre délai, à nous — pas celui, caché, d'undici. `timeoutMs <= 0` = aucune limite
    // (utile pour un harnais de mesure, où une lecture longue est légitime).
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Ollama timeout après ${timeoutMs} ms`))
      })
    } else {
      req.setTimeout(0)
    }
    req.on('error', reject)
    req.end(payload)
  })
}

export async function askOllama(system: string, user: string, timeoutMs = defaultTimeoutMs()): Promise<string> {
  const data = await ollamaChat(
    {
      model: defaultModel(),
      stream: false,
      options: { temperature: 0 },
      keep_alive: '10m',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    },
    timeoutMs,
  )
  return (data.message?.content ?? '').trim()
}
