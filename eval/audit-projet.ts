// Audite un VRAI projet et imprime le rapport — couverture comprise.
//
// Pourquoi ce fichier existe : le run J1 sur `abyss` avait été fait au fil de l'eau,
// dans un script jeté après usage. Résultat, la mesure qui a révélé les deux défauts
// du produit n'était pas rejouable. Elle l'est maintenant.
//
//   tsx eval/audit-projet.ts <dossier> [--cap 24000] [--only performance,tests]
//
// (2026-08-08, lot 3) Ce fichier a longtemps porté sa PROPRE copie du rendu — il était
// le brouillon de la CLI avant qu'elle existe. La copie a fini par diverger : la CLI a
// gagné la section CONVENTIONS, pas elle. Défaut trouvé par Mango QA sur son propre
// diff, deux lots de suite, sur deux fichiers différents — c'est la démonstration que
// la règle du dépôt (« une source unique ») n'est pas une préférence de style.
//
// Le rendu vient donc désormais de `rendreRapport` (src/cli.ts). Ce script ne garde
// que ce qui lui est propre : l'en-tête de mesure et le journal rejouable.
import 'dotenv/config'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { auditProject } from '../src/audit.js'
import { rendreRapport } from '../src/cli.js'

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

const FEUX: Record<string, string> = { pass: '🟢', fail: '🔴', skip: '⚪' }

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

// En-tête PROPRE au harnais de mesure — ce que la CLI n'a pas à porter : les
// conditions du run, sans lesquelles un chiffre archivé n'est pas comparable.
const lignes = [
  '',
  `Projet : ${rapport.projectName}  (${rapport.projectDir})`,
  `Cerveau : ${process.env.QA_OLLAMA_MODEL ?? '(défaut)'}   cap prompt : ${process.env.QA_FILE_PAYLOAD_CAP ?? '100000 (défaut)'} car.`,
  rendreRapport(rapport),
]
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
