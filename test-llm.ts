// Tests du cerveau d'audit (#165 — souveraineté). Exécution : npx tsx test-llm.ts
// Déterministe, ZÉRO vrai réseau (ask injecté dans auditWithLLM ; askOllama/askClaude
// non appelés directement ici — seul le dispatcher askLLM est exercé via mocks).
import { auditWithLLM, parseFirstJson, type BranchMeta } from './src/llm.js'
import type { AuditContext } from './src/types.js'

let passed = 0
let failed = 0
function check(name: string, cond: boolean): void {
  if (cond) passed++
  else { failed++; console.error(`  ❌ ${name}`) }
}

const meta: BranchMeta = { id: 'x', specialty: 'test' }
const ctx: AuditContext = {
  signal: { projectName: 'p', phase: 'build', timestamp: 't', projectDir: '/p', changedFiles: [], retryCount: 0 },
  files: [{ path: 'App.jsx', content: 'x' }],
  retex: '',
}

// ── auditWithLLM avec `ask` injecté : chemin nominal ─────────────────────────
{
  const goodJson = `{"status":"pass","summary":"Conforme."}`
  const f = await auditWithLLM(meta, ctx, async () => goodJson)
  check('chemin nominal : status pass', f.status === 'pass')
  check('chemin nominal : summary', f.summary === 'Conforme.')
}

// ── Réponse illisible → skip, PAS un throw, PAS de re-tentative ─────────────
{
  const f = await auditWithLLM(meta, ctx, async () => 'desole je ne peux pas repondre')
  check('reponse illisible → skip', f.status === 'skip')
  check('reponse illisible → summary explicite', f.summary.includes('illisible'))
}

// ── `ask` qui throw → fail-open (skip), jamais d'exception qui remonte ──────
{
  let threw = false
  let f
  try {
    f = await auditWithLLM(meta, ctx, async () => { throw new Error('reseau') })
  } catch { threw = true }
  check('ask qui throw → fail-open (pas d\'exception)', !threw && f?.status === 'skip')
  check('ask qui throw → summary mentionne l\'erreur', f?.summary.includes('reseau') ?? false)
}

// ── adviceOnly : jamais "fail" même si le LLM répond fail ───────────────────
{
  const adviceMeta: BranchMeta = { id: 'x', specialty: 'test', adviceOnly: true }
  const f = await auditWithLLM(adviceMeta, ctx, async () => `{"status":"fail","summary":"grave"}`)
  check('adviceOnly : fail forcé en pass', f.status === 'pass')
}

// ── Limite honnête de cette suite ────────────────────────────────────────────
// La bascule RÉELLE askOllama→askClaude vit DANS askLLM (llm.ts) : askOllama()
// utilise fetch (réseau réel vers Ollama), askClaude() invoque le SDK Claude Code
// (query(), non injectable sans reconcevoir l'architecture pour ce seul test).
// Aucun mock ne peut donc exercer ce chemin sans réseau — comme askOllama.ts côté
// MangoOS, qui n'a pas non plus de test HTTP unitaire. Cette bascule est vérifiée
// par une PREUVE LIVE (voir le plan #165), pas par un test ici — un mock qui
// prétendrait le faire sans toucher au vrai fetch/SDK serait un test de façade
// (axiome 16 : ne pas fabriquer un contrôle qui a l'air de vérifier sans vérifier).

// ── parseFirstJson : robustesse (déjà couvert ailleurs, sanity check ici) ───
{
  check('parseFirstJson : JSON entouré de texte', parseFirstJson<{ a: number }>('bla {"a":1} bla')?.a === 1)
  check('parseFirstJson : texte sans JSON → null', parseFirstJson('rien ici') === null)
}

console.log(`\n${failed === 0 ? '✅' : '❌'} llm.ts (#165) : ${passed}/${passed + failed} passed`)
if (failed > 0) process.exit(1)
