// B16 (audit 2026-09-28) — le lien entre le registre partage et l'auditeur.
//
// Defaut vise : MangoOS choisit ses cerveaux dans brain-registry.json ; MangoQA
// choisissait le sien dans QA_OLLAMA_MODEL, sans aucun lien. Changer de cerveau dans
// l'Atelier ne changeait rien a l'audit, et RIEN ne le signalait.
//
// Ce test verrouille les trois proprietes qui comptent :
//   1. le registre est bien lu (le lien existe) ;
//   2. un choix EXPLICITE de l'exploitant n'est jamais ecrase ;
//   3. une divergence est TOUJOURS signalee (c'est le coeur du correctif).
//
// Execution : npx tsx tests/manual/test-cerveau-partage.ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { lireCerveauAuditeur, resoudreCerveauAudit, alignerCerveauAudit, cheminRegistre } from '../../src/cerveau-partage.js'

let passed = 0
let failed = 0
function check(name: string, cond: boolean): void {
  if (cond) passed++
  else { failed++; console.error(`  x ${name}`) }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cerveau-'))
const reg = path.join(tmp, 'brain-registry.json')
fs.writeFileSync(reg, JSON.stringify({ auditeur: { provider: 'openai', model: 'glm-5.3' } }))
const env = (o: Record<string, string>): NodeJS.ProcessEnv => ({ MANGOAI_BRAIN_REGISTRY: reg, ...o }) as NodeJS.ProcessEnv

// [1] Le lien existe : on lit bien le role auditeur du registre partage.
{
  const c = lireCerveauAuditeur(env({}))
  check('le role auditeur est lu dans le registre partage', c?.model === 'glm-5.3')
  check('la source est tracee (on sait d ou vient la verite)', (c?.source ?? '').endsWith('brain-registry.json'))
  check('le chemin se surcharge par env', cheminRegistre(env({})) === reg)
}

// [2] Sans choix explicite : l'auditeur SUIT le registre (c'est le sens attendu).
//     Le registre de ce fixture dit provider=openai → voie Ollama.
{
  const r = resoudreCerveauAudit(env({}))
  check('provider openai → la voie visee est QA_OLLAMA_MODEL', r.variable === 'QA_OLLAMA_MODEL')
  check('sans choix explicite → suit le registre', r.modele === 'glm-5.3')
  check('...et ce n est pas un choix explicite', r.choixExplicite === false)
  check('...et il n y a rien a signaler', r.divergence === null)
}

// [2b] Le PROVIDER choisit la variable : un role claude vise QA_MODEL, pas QA_OLLAMA_MODEL.
//      (Bug corrige le 2026-09-29 : comparer un role claude a QA_OLLAMA_MODEL signalait
//       une fausse divergence, et masquait une vraie.)
{
  const regClaude = path.join(tmp, 'claude-registry.json')
  fs.writeFileSync(regClaude, JSON.stringify({ auditeur: { provider: 'claude', model: 'sonnet' } }))
  const e = { MANGOAI_BRAIN_REGISTRY: regClaude } as NodeJS.ProcessEnv
  const r = resoudreCerveauAudit(e)
  check('provider claude → la voie visee est QA_MODEL', r.variable === 'QA_MODEL')
  check('...et le modele attendu est bien lu', r.modele === 'sonnet')
  check('...sans divergence si QA_MODEL concorde', resoudreCerveauAudit({ ...e, QA_MODEL: 'sonnet' } as NodeJS.ProcessEnv).divergence === null)
  const d = resoudreCerveauAudit({ ...e, QA_MODEL: 'opus' } as NodeJS.ProcessEnv).divergence
  check('...et une VRAIE divergence sur QA_MODEL est signalee', d !== null && d.includes('QA_MODEL'))
}

// [3] Un choix EXPLICITE n'est jamais ecrase — mais une divergence est SIGNALEE.
{
  const r = resoudreCerveauAudit(env({ QA_OLLAMA_MODEL: 'deepseek-v4.1-flash' }))
  check('un choix explicite est respecte (non ecrase)', r.modele === 'deepseek-v4.1-flash')
  check('...et il est marque comme explicite', r.choixExplicite === true)
  check('...et la DIVERGENCE est signalee', r.divergence !== null)
  check('le message nomme les deux cerveaux',
    (r.divergence ?? '').includes('deepseek-v4.1-flash') && (r.divergence ?? '').includes('glm-5.3'))
  check('le message dit l enjeu (l Atelier ne change pas l audit)',
    (r.divergence ?? '').includes('ne change PAS'))
}

// [4] Valeurs concordantes : aucun bruit.
{
  const r = resoudreCerveauAudit(env({ QA_OLLAMA_MODEL: 'glm-5.3' }))
  check('valeurs identiques → aucune divergence signalee', r.divergence === null)
}

// [5] Registre absent : jamais une panne (on retombe sur l'env, sans lever).
{
  const sans = { MANGOAI_BRAIN_REGISTRY: path.join(tmp, 'absent.json'), QA_OLLAMA_MODEL: 'x' } as NodeJS.ProcessEnv
  check('registre absent → pas de cerveau partage, pas d exception', lireCerveauAuditeur(sans) === null)
  const r = resoudreCerveauAudit(sans)
  // Registre absent : on ne sait pas quelle voie viser, donc on ne touche a RIEN
  // (modele null, aucune divergence). L'env garde sa valeur — c'est le sens de [5].
  check('registre absent → on ne remplace rien (env garde sa valeur)',
    r.modele === null && r.divergence === null && sans.QA_OLLAMA_MODEL === 'x')
}

// [6] alignerCerveauAudit applique le choix et rend le message a journaliser.
{
  const e = env({})
  const msg = alignerCerveauAudit(e)
  check('sans choix explicite : l environnement est aligne sur le registre', e.QA_OLLAMA_MODEL === 'glm-5.3')
  check('...et le message le dit', (msg ?? '').includes('aligne'))
  const e2 = env({ QA_OLLAMA_MODEL: 'autre-modele' })
  const msg2 = alignerCerveauAudit(e2)
  check('avec divergence : l environnement n est PAS ecrase', e2.QA_OLLAMA_MODEL === 'autre-modele')
  check('...et le message alerte', (msg2 ?? '').includes('DESALIGNE'))
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${failed === 0 ? 'OK' : 'ECHEC'} cerveau partage (B16) : ${passed} pass, ${failed} fail`)
if (failed > 0) process.exit(1)
