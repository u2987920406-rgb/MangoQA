// Jusqu'ou peut-on pousser le prompt AVANT qu'Ollama coupe en silence ?
// Enjeu : si on veut auditer 100% du code en UN appel (au lieu de 27%), il faut savoir
// si le defaut d'Ollama tient la charge, ou s'il faut passer num_ctx explicitement.
import 'dotenv/config'
import { readProjectFiles } from '../src/orchestrator.js'
import { renderFiles } from '../src/fs-shared.js'
const files = readProjectFiles('D:/IA/MangoOS/workspace/abyss', [])
const total = files.reduce((s, f) => s + f.content.length, 0)
console.log(`Projet abyss : ${files.length} fichiers, ${total.toLocaleString('fr-FR')} caracteres (~${Math.round(total / 3.5).toLocaleString('fr-FR')} tokens)\n`)
async function evald(payload: string, numCtx: number | null) {
  const body: any = { model: 'qwen2.5-coder:14b', stream: false, keep_alive: '10m',
    options: { temperature: 0, num_predict: 4, ...(numCtx ? { num_ctx: numCtx } : {}) },
    messages: [{ role: 'user', content: payload + '\nReponds OK.' }] }
  const r = await fetch('http://localhost:11434/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const d: any = await r.json(); return d.prompt_eval_count ?? -1
}
for (const cap of [24_000, 60_000, 100_000]) {
  const p = renderFiles(files, cap)
  const attendu = Math.round(p.length / 3.5)
  const d = await evald(p, null)
  const c = await evald(p, 32768)
  const perte = c - d
  console.log(`cap ${String(cap).padStart(6)} car. -> ~${String(attendu).padStart(5)} tokens attendus | defaut: ${String(d).padStart(5)} | num_ctx 32768: ${String(c).padStart(5)} | ${perte > 50 ? 'PERTE de ' + perte + ' tokens au defaut ⚠' : 'identique'}`)
}
