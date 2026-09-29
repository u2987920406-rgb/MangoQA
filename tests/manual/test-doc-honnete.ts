// B17 (audit 2026-09-28) — la documentation ne doit pas promettre plus que le code.
//
// Defaut vise : le README annoncait « Visage 2 : OBSERVATEUR-CONSEIL » sans dire que le
// gate QA_OBSERVER n'etait PAS arme en production, tandis que FAILLES.md le declarait
// « non cable ». Les deux etaient faux d'une facon differente : le code le cable bel et
// bien (index.ts, gaté), et le gate est OFF en prod. Une couverture affichee superieure
// a la reelle est exactement le genre de mensonge qui coute cher a l'exploitant.
//
// Ce test verrouille l'honnetete de l'affichage, dans les DEUX sens :
//   - si le code cable le visage, les docs ne doivent plus dire « non cable » ;
//   - si le gate est OFF, les docs doivent le SIGNALER (pas le passer sous silence).
//
// Execution : npx tsx tests/manual/test-doc-honnete.ts
import fs from 'node:fs'

let passed = 0
let failed = 0
function check(name: string, cond: boolean): void {
  if (cond) passed++
  else { failed++; console.error(`  x ${name}`) }
}

const index = fs.readFileSync('src/index.ts', 'utf8')
const readme = fs.readFileSync('README.md', 'utf8')
const failles = fs.readFileSync('FAILLES.md', 'utf8')
const env = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : ''
const gateArme = env.split('\n').some((l) => l.startsWith('QA_OBSERVER=') && !l.startsWith('#'))

// [1] Verite du code : le visage est-il branche, et gaté ?
{
  check('le code appelle bien runObserver (le visage EST cable)', index.includes('runObserver('))
  check('cet appel est conditionne par un gate', index.includes('OBSERVER_ON'))
}

// [2] Verite de la production : le gate est-il arme ?
{
  check(`etat reel du gate QA_OBSERVER en production : ${gateArme ? 'ARME' : 'non arme'}`, true)
}

// [3] Le README doit refleter (cable) ET (gate arme ou signale).
{
  check('le README declare le visage comme CÂBLÉ', /CÂBL[EÉ]/.test(readme))
  // Le README doit dire l'etat REEL du gate, dans les deux sens : arme → annonce arme ;
  // off → signale off. C'est ce qui interdit le faux actif (B17).
  if (gateArme) {
    check('gate ARME → le README l annonce arme', /CÂBLÉ et ARM[EÉ]|CÂBLÉ.*ARM[EÉ]/.test(readme))
    check('gate ARME → le README ne dit plus NON ARMÉ', !readme.includes('NON ARMÉ'))
  } else {
    check('gate OFF → le README le SIGNALE (pas de faux actif)',
      readme.includes('NON ARMÉ') || readme.includes('non armé'))
  }
  check('le README ne dit plus que la fenetre est TODO', !readme.includes('fenêtre temporelle TODO'))
}

// [4] FAILLES.md ne doit plus nier le cablage.
{
  check('FAILLES.md ne dit plus « non câblée »', !failles.includes('amorce non câblée'))
  check('FAILLES.md documente l etat reel du gate', failles.includes('QA_OBSERVER'))
}

console.log(`\n${failed === 0 ? 'OK' : 'ECHEC'} doc honnete (B17) : ${passed} pass, ${failed} fail`)
if (failed > 0) process.exit(1)
