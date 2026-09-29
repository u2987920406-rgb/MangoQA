// D3 (audit 2026-09-28, B1) — la SONDE DE CERVEAU d'audit.
//
// Defaut vise : la seule sonde de vivacite testait le PROCESS (heartbeat de fichier).
// MangoQA pouvait etre "actif" et incapable d'auditer indefiniment — constate le
// 2026-09-24, toutes les branches en `skip` sur « subscription access disabled »,
// et rien ne l'avait signale.
//
// Ce test prouve les trois etats, les garde-fous, et surtout qu'AUCUNE exception ne
// remonte (une sonde qui casse le demarrage serait pire que pas de sonde).
//
// Execution : npx tsx tests/manual/test-sonde-cerveau.ts
// Deterministe, ZERO reseau (ask injecte).
import { sonderCerveauAudit, formaterSonde } from '../../src/sonde-cerveau.js'

let passed = 0
let failed = 0
function check(name: string, cond: boolean): void {
  if (cond) passed++
  else {
    failed++
    console.error(`  X ${name}`)
  }
}

// ── 1. Un cerveau qui repond correctement → ok ────────────────────────────────
{
  const r = await sonderCerveauAudit(async () => 'OK')
  check('cerveau vivant : etat ok', r.etat === 'ok')
  check('cerveau vivant : joignable', r.joignable === true)
  check('cerveau vivant : duree mesuree', r.dureeMs >= 0)
}

// ── 2. LE CAS DE B1 : le cerveau ne repond pas → panne, PAS un silence ───────
{
  const r = await sonderCerveauAudit(async () => {
    throw new Error("Your organization has disabled Claude subscription access")
  })
  check('B1 : cerveau injoignable → panne', r.etat === 'panne')
  check('B1 : injoignable → joignable=false', r.joignable === false)
  check('B1 : la cause remonte dans le detail', r.detail.includes('subscription access'))
  check('B1 : le message dit qu aucun verdict ne sera rendu', /aucun verdict/i.test(r.detail))
  check('B1 : formatage d alerte non ambigu', formaterSonde(r).includes('🚨'))
}

// ── 3. Un cerveau qui repond VIDE → invalide (pas "ok" par complaisance) ─────
{
  const r = await sonderCerveauAudit(async () => '   ')
  check('reponse vide → reponse_invalide', r.etat === 'reponse_invalide')
  check('reponse vide → pas joignable', r.joignable === false)
}

// ── 4. Un cerveau bavard (ne suit pas la consigne) → signale, non bloquant ───
{
  const r = await sonderCerveauAudit(async () => 'Bien sur ! Voici ma reponse longue...')
  check('reponse hors consigne → signalee', r.etat === 'reponse_invalide')
  check('reponse hors consigne → reste joignable (nuance honnete)', r.joignable === true)
}

// ── 5. La sonde EXPIRE au lieu de pendre (sinon elle ne sert a rien) ─────────
{
  const debut = Date.now()
  const r = await sonderCerveauAudit(() => new Promise<string>(() => {}), 300)
  const ecoule = Date.now() - debut
  check('cerveau qui pend → panne (jamais un blocage infini)', r.etat === 'panne')
  check('expiration respectee (~300ms, pas plus de 3s)', ecoule < 3000)
}

// ── 6. La sonde ne LEVE JAMAIS, quelle que soit l'erreur injectee ────────────
{
  let leve = false
  try {
    await sonderCerveauAudit(() => {
      throw new TypeError('erreur bizarre non-Error')
    })
    await sonderCerveauAudit(async () => '')
  } catch {
    leve = true
  }
  check('aucune exception ne remonte jamais', !leve)
}

// ── 7. Le formatage distingue les trois etats (lisible dans un log) ─────────
{
  const ok = formaterSonde({ etat: 'ok', detail: 'x', joignable: true, dureeMs: 5 })
  const ko = formaterSonde({ etat: 'panne', detail: 'x', joignable: false, dureeMs: 5 })
  const vl = formaterSonde({ etat: 'reponse_invalide', detail: 'x', joignable: true, dureeMs: 5 })
  check('les trois etats ont des marqueurs distincts', ok !== ko && ko !== vl && ok !== vl)
}

console.log(`\n${failed === 0 ? 'OK' : 'ECHEC'} sonde cerveau (D3/B1) : ${passed}/${passed + failed} passed`)
if (failed > 0) process.exit(1)
