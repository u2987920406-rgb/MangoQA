// Audite un VRAI projet et imprime le rapport — couverture comprise.
//
// Pourquoi ce fichier existe : le run J1 sur `abyss` avait été fait au fil de l'eau,
// dans un script jeté après usage. Résultat, la mesure qui a révélé les deux défauts
// du produit n'était pas rejouable. Elle l'est maintenant.
//
//   tsx eval/audit-projet.ts <dossier> [--cap 24000] [--only performance,tests]
//
// C'est aussi le brouillon de la CLI de J3 : mêmes informations, même ordre de
// lecture. La règle d'affichage tient en une ligne — la COUVERTURE est imprimée
// AVEC le verdict, jamais après, jamais en note de bas de page.
import 'dotenv/config'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { auditProject, type AuditReport } from '../src/audit.js'

const argv = process.argv.slice(2)
const flag = (nom: string): string | undefined => {
  const i = argv.indexOf(`--${nom}`)
  return i >= 0 ? argv[i + 1] : undefined
}
// La cible est le 1er argument positionnel : les options viennent APRÈS.
const DOSSIER = argv[0]?.startsWith('--') || !argv[0] ? 'D:/IA/MangoOS/workspace/abyss' : argv[0]
const CAP = flag('cap')
const ONLY = flag('only')?.split(',').map(s => s.trim()).filter(Boolean)
const JOURNAL = flag('journal')

// Le cap est une variable d'environnement lue par llm.ts — on la pose ici pour
// pouvoir comparer deux régimes de lecture dans la même journée de mesure.
if (CAP) process.env.QA_FILE_PAYLOAD_CAP = CAP

const pct = (n: number, d: number): string => (d > 0 ? `${Math.round((n / d) * 100)} %` : '—')
const FEUX: Record<string, string> = { pass: '🟢', fail: '🔴', skip: '⚪' }

/** Le rapport lisible. `couverture` n'est PAS une section optionnelle en bas de page :
 *  elle encadre le verdict, parce qu'un verdict sans son périmètre ne veut rien dire. */
function rendre(r: AuditReport): string[] {
  const l: string[] = []
  l.push('')
  l.push(`Projet : ${r.projectName}  (${r.projectDir})`)
  l.push(`Cerveau : ${process.env.QA_OLLAMA_MODEL ?? '(défaut)'}   cap prompt : ${process.env.QA_FILE_PAYLOAD_CAP ?? '100000 (défaut)'} car.`)
  l.push('')

  for (const b of r.branches) {
    const c = b.coverage
    const vu = c ? `${c.filesRendered}/${c.filesTotal} vus` : `${b.filesAudited} fichiers`
    const alerte = c && !c.complete ? ' ⚠️ PARTIEL' : ''
    l.push(
      `  ${FEUX[b.finding.status] ?? '?'} ${b.emoji} ${b.label.padEnd(16)}` +
        `${(b.durationMs / 1000).toFixed(1)}s  ${vu.padEnd(12)}${alerte}  ${b.finding.summary}`,
    )
  }

  l.push('')
  const cov = r.coverage
  l.push('  COUVERTURE')
  l.push(`    Fichiers découverts  : ${cov.filesDiscovered}`)
  l.push(`    Fichiers lus         : ${cov.filesRead}  (${pct(cov.filesRead, cov.filesDiscovered)})`)
  if (cov.filesDropped.length) l.push(`    ⚠️ Jamais lus        : ${cov.filesDropped.join(', ')}`)
  if (cov.filesTruncated.length) l.push(`    ⚠️ Coupés à la lecture : ${cov.filesTruncated.join(', ')}`)
  for (const b of r.branches) {
    const c = b.coverage
    if (!c || c.complete) continue
    l.push(
      `    ⚠️ ${b.id} : ${c.filesRendered}/${c.filesTotal} fichiers envoyés au modèle ` +
        `(${pct(c.charsRendered, c.charsTotal)} du code)` +
        (c.omitted.length ? ` — non vus : ${c.omitted.join(', ')}` : ''),
    )
  }
  l.push(`    → ${cov.complete ? 'COMPLÈTE : tout le code a été lu et vu.' : 'PARTIELLE : le verdict ci-dessous ne porte PAS sur tout le code.'}`)

  l.push('')
  const v = r.verdict
  l.push(`  VERDICT : ${v.verdict === 'green' ? '🟢 FEU VERT' : '🔴 FEU ROUGE'}${v.rejection ? ` — branche ${v.rejection.branch} (${v.rejection.rejection_id})` : ''}${cov.complete ? '' : '  ⚠️ SUR LECTURE PARTIELLE'}`)
  if (v.rejection) l.push(`  Correctif : « ${v.rejection.corrective_action} »`)
  if (v.coverage && !v.coverage.complete) {
    l.push(`  Couverture au verdict : ${v.coverage.partial.map(p => `${p.branch} ${p.filesRendered}/${p.filesTotal}`).join(', ')}`)
  }
  l.push(`  Durée totale : ${(r.durationMs / 1000).toFixed(1)}s`)
  l.push('')
  return l
}

const t0 = Date.now()
console.log(`\n[audit] ${DOSSIER} — branches : ${ONLY?.join(', ') ?? 'les 6'}`)
const rapport = await auditProject(DOSSIER, {
  concurrency: 1, // verdicts au fil de l'eau (cerveau local mono-GPU : le total est le même)
  ...(ONLY ? { only: ONLY } : {}),
  onBranch: b => {
    const c = b.coverage
    console.log(
      `  ${FEUX[b.finding.status] ?? '?'} ${b.emoji} ${b.label.padEnd(16)}${(b.durationMs / 1000).toFixed(1)}s  ` +
        `${c ? `${c.filesRendered}/${c.filesTotal} vus${c.complete ? '' : ' ⚠️'}` : `${b.filesAudited} fichiers`}  ${b.finding.summary}`,
    )
  },
})

const lignes = rendre(rapport)
console.log(lignes.join('\n'))
console.log(`[audit] terminé en ${((Date.now() - t0) / 1000).toFixed(1)}s`)

if (JOURNAL) {
  mkdirSync('eval/rapports', { recursive: true })
  // Un journal sans titre n'est pas un rapport — on le pose à la création, une fois.
  if (!existsSync(JOURNAL)) {
    writeFileSync(
      JOURNAL,
      `# Audits de projets réels — couverture déclarée\n\n` +
        `> Écrit par \`eval/audit-projet.ts\`. Chaque section = un run rejouable.\n` +
        `> La couverture n'est pas une annexe : elle dit sur QUOI porte le verdict.\n`,
      'utf8',
    )
  }
  // Heure LOCALE, pas UTC : `toISOString()` datait les rapports de 2 h dans le passé,
  // ce qui les rendait impossibles à recouper avec les journaux système (cf. _ceiling.ts).
  appendFileSync(
    JOURNAL,
    `\n## Audit ${rapport.projectName} — ${new Date().toLocaleString('sv-SE').slice(0, 16)}\n` +
      `\ncerveau : ${process.env.QA_OLLAMA_MODEL ?? '(défaut)'} · cap prompt : ${process.env.QA_FILE_PAYLOAD_CAP ?? '100000 (défaut)'} caractères\n` +
      '\n```\n' + lignes.join('\n').trim() + '\n```\n',
  )
  console.log(`[audit] journal : ${JOURNAL}`)
}
