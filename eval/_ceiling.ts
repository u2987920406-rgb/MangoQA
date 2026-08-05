// Jusqu'ou peut-on pousser le prompt AVANT qu'Ollama coupe en silence ?
// Enjeu : si on veut auditer 100% du code en UN appel (au lieu de 27%), il faut savoir
// si le defaut d'Ollama tient la charge, ou s'il faut passer num_ctx explicitement.
//
// Montee douce : 24k -> 40k -> 60k caracteres, et ARRET au premier palier qui perd des
// tokens. Chaque palier est ecrit sur disque des qu'il est mesure : la machine a coupe
// une fois pendant cet essai, une mesure obtenue ne doit plus jamais etre reperdue.
import 'dotenv/config'
import { appendFileSync, mkdirSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { readProjectFiles } from '../src/orchestrator.js'
import { renderFiles } from '../src/fs-shared.js'

// Paliers passables en argv : `tsx eval/_ceiling.ts 95000`. Defaut = montee douce.
const PALIERS = process.argv.slice(2).map(Number).filter(n => n > 0)
const DEFAUT_PALIERS = [24_000, 40_000, 60_000]
const SEUIL_PERTE = 50 // tokens : en-deca, c'est du bruit de tokenizer, pas une troncature
const NUM_CTX = 32_768
const JOURNAL = 'eval/rapports/PLAFOND-CONTEXTE.md'

mkdirSync('eval/rapports', { recursive: true })
const note = (l: string) => { console.log(l); appendFileSync(JOURNAL, l + '\n') }

const files = readProjectFiles('D:/IA/MangoOS/workspace/abyss', [])
const total = files.reduce((s, f) => s + f.content.length, 0)

// Heure locale, pas UTC : `toISOString()` datait les rapports de 2 h dans le passe, ce qui
// les rendait impossibles a recouper avec les journaux systeme. 'sv-SE' donne le format ISO.
note(`\n## Sonde plafond — ${new Date().toLocaleString('sv-SE').slice(0, 16)}`)
note('')
note(`Projet abyss : ${files.length} fichiers, ${total.toLocaleString('fr-FR')} caracteres (~${Math.round(total / 3.5).toLocaleString('fr-FR')} tokens)`)
note('')
note('| cap | car. rendus | couverture | tokens attendus | defaut | num_ctx 32768 | ecart |')
note('|---|---|---|---|---|---|---|')

// `fetch` est inutilisable ici : undici coupe au bout de 300 s si les en-tetes ne sont pas
// arrives (UND_ERR_HEADERS_TIMEOUT), et l'eval d'un prompt de 27 000 tokens depasse ce
// delai — la sonde 95 000 mourait sans rien mesurer. Passer en stream:true ne suffirait pas :
// Ollama ne vide ses en-tetes qu'au premier chunk, donc apres l'eval. node:http n'impose
// aucun delai cote client, c'est la seule voie sure.
function ollamaChat(body: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = httpRequest({
      host: 'localhost', port: 11434, path: '/api/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', c => { raw += c })
      res.on('end', () => {
        try { resolve(JSON.parse(raw)) }
        catch { reject(new Error(`reponse illisible (HTTP ${res.statusCode}) : ${raw.slice(0, 200)}`)) }
      })
    })
    req.setTimeout(0) // aucune coupure : un palier peut legitimement durer 20 min
    req.on('error', reject)
    req.end(payload)
  })
}

async function evald(payload: string, numCtx: number | null): Promise<number> {
  const body = {
    model: 'qwen2.5-coder:14b', stream: false, keep_alive: '10m',
    options: { temperature: 0, num_predict: 4, ...(numCtx ? { num_ctx: numCtx } : {}) },
    messages: [{ role: 'user', content: payload + '\nReponds OK.' }],
  }
  const t0 = Date.now()
  const d = await ollamaChat(body)
  // Trace de vie : sans elle, un palier long est indiscernable d'un blocage.
  console.log(`   … eval ${numCtx ? `num_ctx=${numCtx}` : 'defaut'} : ${d.prompt_eval_count ?? -1} tokens en ${Math.round((Date.now() - t0) / 1000)} s`)
  return d.prompt_eval_count ?? -1
}

let coupure: number | null = null
let dernierVus = 0 // couverture du cap le plus haut effectivement mesure

const UTILISES = PALIERS.length ? PALIERS : DEFAUT_PALIERS

for (const cap of UTILISES) {
  const p = renderFiles(files, cap)
  const attendu = Math.round(p.length / 3.5)
  // Couverture reelle : renderFiles pose un en-tete par fichier retenu, et s'arrete
  // au premier debordement. C'est exactement le 5/19 silencieux du rapport J1.
  const vus = (p.match(/\n----- .+ -----\n/g) ?? []).length
  const tronque = p.includes('(tronqué)')
  const couv = `${vus}/${files.length}${tronque ? ' (dernier tronque)' : ''}`
  dernierVus = tronque ? vus - 1 : vus // un fichier tronque n'est pas un fichier couvert
  const d = await evald(p, null)
  const c = await evald(p, NUM_CTX)
  const perte = c - d
  const verdict = perte > SEUIL_PERTE ? `**PERTE de ${perte} tokens au defaut**` : 'identique'
  note(`| ${cap.toLocaleString('fr-FR')} | ${p.length.toLocaleString('fr-FR')} | ${couv} | ~${attendu.toLocaleString('fr-FR')} | ${d} | ${c} | ${verdict} |`)

  if (perte > SEUIL_PERTE) { coupure = cap; break }
}

note('')
if (coupure === null) {
  // UTILISES et non PALIERS : sans argv, PALIERS est vide et `.at(-1)` plantait ici.
  note(`**Aucune troncature silencieuse jusqu'a ${UTILISES.at(-1)!.toLocaleString('fr-FR')} caracteres.**`)
  // Conclusion deduite, pas ecrite en dur : la version precedente affirmait toujours que le
  // palier 100 000 restait non mesure, y compris dans le rapport qui venait de le mesurer.
  note(dernierVus >= files.length
    ? `Couverture complete : les ${files.length} fichiers (${total.toLocaleString('fr-FR')} car.) tiennent en un seul appel.`
    : `Couverture partielle : ${dernierVus}/${files.length} fichiers au cap le plus haut — monter le cap pour viser le projet entier.`)
} else {
  note(`**Ollama tronque en silence des ${coupure.toLocaleString('fr-FR')} caracteres au defaut.**`)
  note(`Passer num_ctx: ${NUM_CTX} explicitement recupere le contexte perdu — les paliers superieurs n'ont pas ete mesures.`)
}
