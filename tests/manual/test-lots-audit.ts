// D4 (audit 2026-09-28, B3) — la couverture de l'audit.
//
// Defaut vise : `renderFiles` s'arretait au premier fichier qui depasse le cap de
// 24 000 caracteres. Mesure de l'audit : 93 % de `src/` visible sur shining-tactics,
// mais 12 % sur etang-des-roseaux et 2 % sur toeic-quest — et l'audit ne le signalait
// pas. Deux corrections : le TRI par risque (deja ecrit, jamais branche) puis des LOTS
// successifs avec agregation des constats.
//
// Execution : npx tsx tests/manual/test-lots-audit.ts
// Deterministe, ZERO reseau.
import { decouperEnLots, agregerConstats } from '../../src/lots-audit.js'
import { renderFiles } from '../../src/fs-shared.js'
import type { ProjectFile } from '../../src/types.js'
import { readProjectFiles } from '../../src/orchestrator.js'
import fs from 'node:fs'

let passed = 0
let failed = 0
function check(name: string, cond: boolean): void {
  if (cond) passed++
  else {
    failed++
    console.error(`  X ${name}`)
  }
}

const CAP = 24_000
const gros = (p: string, n = 24_000): ProjectFile => ({ path: p, content: 'x'.repeat(n) })

/** Compte les fichiers REELLEMENT rendus dans un payload : on ne compte que les lignes
 *  d'en-tete strictes `----- chemin -----`. Compter les occurrences de `-----` est faux :
 *  le code lui-meme en contient (commentaires, separateurs markdown) — piege rencontre
 *  en mesurant galerie-albatre (15 « vus » pour 3 fichiers). */
function fichiersRendus(payload: string): number {
  return (payload.match(/^----- .+ -----$/gm) ?? []).length
}

// ── 1. La couverture : ce que l'ANCIEN comportement voyait vs le nouveau ─────
{
  const fichiers: ProjectFile[] = [
    gros('src/index.ts', 5000),
    gros('src/server.ts', 5000),
    gros('src/routes/auth.ts', 5000),
    gros('src/routes/users.ts', 5000),
    gros('src/components/Card.tsx', 5000),
    gros('src/components/List.tsx', 5000),
  ]
  // Ancien : un seul payload, coupé au cap.
  const avant = renderFiles(fichiers, CAP)
  const vusAvant = fichiersRendus(avant)
  // Nouveau : lots successifs.
  const apres = decouperEnLots(fichiers, CAP, 8)
  check(`l'ancien prefixe ne voyait pas tout (${vusAvant}/${fichiers.length})`, vusAvant < fichiers.length)
  check(`le compteur d'en-tetes est fiable (${vusAvant} vus, pas de faux positifs)`, vusAvant <= fichiers.length)
  check(`les lots couvrent TOUT (${apres.fichiersInclus}/${fichiers.length})`, apres.fichiersInclus === fichiers.length)
  check('les lots ne mentent pas sur les omis', apres.fichiersOmis === 0)
  check('chaque lot respecte le cap', apres.lots.every((l) => l.length <= CAP))
}

// ── 2. Le TRI par risque passe AVANT la decoupe (B3 : deja ecrit, jamais branche) ──
{
  const fichiers: ProjectFile[] = [
    { path: 'src/components/Card.tsx', content: 'y'.repeat(100) },
    { path: 'src/routes/auth.ts', content: 'y'.repeat(100) },
    { path: 'src/styles/main.css', content: 'y'.repeat(100) },
  ]
  const r = decouperEnLots(fichiers, CAP, 8)
  const premier = r.lots[0] ?? ''
  check("l'auth (surface la plus sensible) est dans le 1er lot", premier.includes('auth.ts'))
  check('un simple composant ne passe pas avant les routes', premier.indexOf('auth.ts') < premier.indexOf('Card.tsx') || !premier.includes('Card.tsx'))
}

// ── 3. Un fichier plus gros que le cap : tronque et SIGNALE, jamais cache ────
{
  const r = decouperEnLots([{ path: 'src/enorme.ts', content: 'z'.repeat(50_000) }], CAP, 8)
  check('fichier enorme : signalé comme tronqué', r.tronque === true)
  check('fichier enorme : un lot produit', r.lots.length === 1)
}

// ── 4. Le garde-fou de cout : au-dela de maxLots, on COMPTE ce qui manque ────
{
  const bcp: ProjectFile[] = Array.from({ length: 20 }, (_, i) => gros(`src/f${i}.ts`, 20_000))
  const r = decouperEnLots(bcp, CAP, 3)
  check('garde-fou : jamais plus de maxLots lots', r.lots.length <= 3)
  check('garde-fou : les fichiers non vus sont COMPTES (pas oublies)', r.fichiersOmis > 0)
}

// ── 5. L'agregation ne dilue jamais un echec (regle de surete) ───────────────
{
  const unSeulEchec = agregerConstats(
    [
      { status: 'pass', summary: 'lot 1 conforme' },
      { status: 'fail', summary: 'faille XSS', rejectionId: 'SEC-1' },
      { status: 'pass', summary: 'lot 3 conforme' },
    ],
    false,
  )
  check('un seul fail suffit a faire echouer la branche', unSeulEchec.status === 'fail')
  check('le rejet du lot fautif est conserve', unSeulEchec.rejectionId === 'SEC-1')

  const tousPass = agregerConstats(
    [
      { status: 'pass', summary: 'a' },
      { status: 'pass', summary: 'b' },
    ],
    false,
  )
  check('tous conformes + couverture totale → pass', tousPass.status === 'pass')

  // Le cas cle : tout est conforme MAIS on n'a pas tout vu.
  const partiel = agregerConstats(
    [
      { status: 'pass', summary: 'a' },
      { status: 'pass', summary: 'b' },
    ],
    true,
  )
  check('tous conformes MAIS couverture partielle → PAS un pass (skip)', partiel.status === 'skip')
  check('et le constat dit pourquoi', /PARTIELLEMENT/i.test(partiel.summary))

  check('aucun constat → skip (jamais un pass par defaut)', agregerConstats([], false).status === 'skip')
}

// ── 6. PREUVE SUR UN PROJET REEL : la couverture reellement gagnee ───────────
{
  const racine = '/home/raf/projets/mangoai/workspace'
  const cibles = ['etang-des-roseaux', 'galerie-albatre', 'toeic-quest', 'nova-wing']
  let mesures = 0
  let ameliores = 0
  for (const proj of cibles) {
    const dir = `${racine}/${proj}`
    if (!fs.existsSync(dir)) continue
    const files = readProjectFiles(dir, [])
    if (files.length === 0) continue
    const avant = renderFiles(files, CAP)
    const vusAvant = fichiersRendus(avant)
    const apres = decouperEnLots(files, CAP, 8)
    mesures++
    const pctAvant = Math.round((vusAvant / files.length) * 100)
    const pctApres = Math.round((apres.fichiersInclus / files.length) * 100)
    console.log(
      `  ${proj} : ${files.length} fichiers — ${vusAvant} vus avant (${pctAvant} %) → ${apres.fichiersInclus} vus (${pctApres} %)`,
    )
    // JAMAIS de regression : un projet deja integralement visible le reste. Et la
    // couverture ne peut qu'augmenter — c'est la seule exigence honnete, car un petit
    // projet (galerie-albatre, 3 fichiers) tenait deja entierement dans le cap.
    check(`${proj} : jamais moins de couverture qu'avant`, apres.fichiersInclus >= vusAvant)
    if (vusAvant < files.length) {
      check(`${proj} : couverture partielle resolue (${pctAvant} % → ${pctApres} %)`, apres.fichiersInclus > vusAvant)
      ameliores++
    }
  }
  check('la preuve a porte sur au moins un projet reel', mesures > 0)
  check('au moins un projet a REELLEMENT gagne en couverture', ameliores > 0)
}

console.log(`\n${failed === 0 ? 'OK' : 'ECHEC'} lots d'audit (D4/B3) : ${passed}/${passed + failed} passed`)
if (failed > 0) process.exit(1)
