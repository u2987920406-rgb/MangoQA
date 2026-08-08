// Lot 3 (ADR-001) — l'axe *Standards* : juger un dépôt contre les règles QU'IL a écrites.
//
// Deux critères d'achèvement, fixés par l'ADR, et ce fichier existe pour les geler :
//   1. une trouvaille référence un FICHIER et une LIGNE du dépôt ;
//   2. un projet sans conventions documentées le DÉCLARE, au lieu d'inventer.
//
// Le second est le plus important et le moins spectaculaire : sans lui, un modèle à qui
// on ne parle jamais de conventions en invente — il juge contre les habitudes moyennes
// d'internet et les présente comme les règles de la maison. Un reproche fondé sur une
// règle que personne n'a écrite est un faux positif que l'utilisateur ne peut même pas
// contester.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  scanConventions,
  conventionsBlock,
  extraireReglesMarkdown,
  extraireReglesEditorconfig,
  indexer,
  type ConventionsScan,
} from '../../src/conventions.js'
import { verifierCitations, auditWithLLM } from '../../src/llm.js'
import { auditProject } from '../../src/audit.js'
import { rendreRapport } from '../../src/cli.js'
import { rendreTexteMcp, rendreStructureMcp } from '../../src/mcp.js'
import type { AuditContext, Branch, ProjectFile } from '../../src/types.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// ── L'extraction : une règle pointe TOUJOURS une ligne qui existe ────────────

describe('extraction markdown — la ligne citée doit être vraie', () => {
  const md = [
    '# Conventions', // 1
    '', // 2
    'Ce projet suit quelques règles.', // 3  ← prose sans marqueur : PAS une règle
    '', // 4
    '- Jamais de `default export`.', // 5  ← puce
    '- Les composants vivent dans `src/components/`.', // 6  ← puce
    '', // 7
    'Toute nouvelle route doit passer par le middleware auth.', // 8 ← prose normative
    '', // 9
    '```md', // 10
    '- Ceci est un exemple, pas une règle du projet.', // 11 ← DANS un bloc de code
    '```', // 12
    '', // 13
    '## Titre qui doit toujours être ignoré', // 14 ← titre, même normatif
  ].join('\n')

  const rules = extraireReglesMarkdown(md, 'CLAUDE.md')

  it('retient les puces et les phrases normatives, à la bonne ligne', () => {
    expect(rules.map(r => r.line)).toEqual([5, 6, 8])
    expect(rules[0].id).toBe('CLAUDE.md:5')
    expect(rules[0].text).toBe('Jamais de default export.')
  })

  it('ignore la prose non normative, les titres et le contenu des blocs de code', () => {
    // Une puce dans un exemple ``` ILLUSTRE une règle, elle n'en est pas une : la citer
    // enverrait le lecteur vérifier sur un extrait de documentation.
    expect(rules.some(r => r.text.includes('exemple'))).toBe(false)
    expect(rules.some(r => r.line === 3 || r.line === 14)).toBe(false)
  })

  it('les identifiants sont stables entre deux scans du même contenu', () => {
    // Deux audits du même dépôt doivent produire les mêmes identifiants, sinon comparer
    // deux rapports dans le temps n'a plus de sens.
    expect(extraireReglesMarkdown(md, 'CLAUDE.md').map(r => r.id)).toEqual(rules.map(r => r.id))
  })
})

describe('extraction .editorconfig — la forme la plus objective', () => {
  it('chaque affectation devient une règle, avec sa section', () => {
    const rules = extraireReglesEditorconfig(
      ['root = true', '', '[*.ts]', 'indent_style = space', 'indent_size = 2'].join('\n'),
      '.editorconfig',
    )
    expect(rules).toHaveLength(3)
    expect(rules[1].text).toBe('pour *.ts : indent_style = space')
    expect(rules[1].line).toBe(4)
  })
})

// ── Le bloc de prompt : le cas « aucune convention » compte autant ───────────

describe('conventionsBlock', () => {
  const scanAvec = (rules: ConventionsScan['rules']): ConventionsScan => ({
    files: ['CLAUDE.md'],
    rules,
    dropped: 0,
    filesDropped: [],
    absent: false,
  })

  it('des conventions existent → listées avec leur identifiant, citation exigée', () => {
    const bloc = conventionsBlock(
      scanAvec([{ id: 'CLAUDE.md:5', file: 'CLAUDE.md', line: 5, text: 'Jamais de default export.' }]),
    )
    expect(bloc).toContain('[CLAUDE.md:5]')
    expect(bloc).toContain('conventionRefs')
    // Le dépôt a le droit de décider autrement que l'usage : sans cette phrase, le
    // modèle arbitre entre ses habitudes et la règle écrite, et choisit souvent mal.
    expect(bloc).toContain('font autorité sur tes habitudes')
  })

  it('AUCUNE convention → on le DIT, et on interdit d\'en invoquer une', () => {
    const bloc = conventionsBlock({ files: [], rules: [], dropped: 0, filesDropped: [], absent: true })
    expect(bloc).toContain("n'en documente aucune")
    expect(bloc).toContain('AUCUNE règle')
    // C'est le critère d'achèvement n°2 de l'ADR, littéralement.
    expect(bloc).toContain("que personne n'a écrite")
  })

  it('fichiers lus mais zéro règle : distinct de « aucun fichier »', () => {
    // Un CONTRIBUTING.md de pure prose n'est pas un dépôt non documenté. Confondre les
    // deux ferait dire à l'auditeur qu'il n'y avait rien à lire alors qu'il n'a rien su lire.
    const bloc = conventionsBlock({
      files: ['CONTRIBUTING.md'],
      rules: [],
      dropped: 0,
      filesDropped: [],
      absent: false,
    })
    expect(bloc).toContain('CONTRIBUTING.md')
    expect(bloc).toContain('aucune règle explicite')
  })

  it('scan absent (option coupée) → chaîne vide, prompt inchangé', () => {
    expect(conventionsBlock(undefined)).toBe('')
  })
})

// ── La vérification des citations : le cœur du lot ───────────────────────────

const ctxAvecRegles = (): Pick<AuditContext, 'conventions'> => ({
  conventions: {
    files: ['CLAUDE.md'],
    rules: [
      { id: 'CLAUDE.md:5', file: 'CLAUDE.md', line: 5, text: 'Jamais de default export.' },
      { id: 'CLAUDE.md:9', file: 'CLAUDE.md', line: 9, text: 'Tests obligatoires.' },
    ],
    dropped: 0,
    filesDropped: [],
    absent: false,
  },
})

describe('verifierCitations — une citation invérifiable ne prouve rien', () => {
  it('un identifiant réel est retenu', () => {
    expect(verifierCitations(['CLAUDE.md:5'], ctxAvecRegles())).toEqual({ citees: ['CLAUDE.md:5'], rejetees: [] })
  })

  it('un identifiant INVENTÉ est rejeté, et reste visible', () => {
    // On ne nettoie pas la copie du modèle en silence : citer une ligne qui n'existe pas
    // est le symptôme (J1-b) qu'il affirme un fait que la source contredit.
    const r = verifierCitations(['CLAUDE.md:5', 'CLAUDE.md:999', 'REGLES.md:1'], ctxAvecRegles())
    expect(r).toEqual({ citees: ['CLAUDE.md:5'], rejetees: ['CLAUDE.md:999', 'REGLES.md:1'] })
  })

  it('tolère les crochets — c\'est la FORME montrée dans le prompt, pas une invention', () => {
    expect(verifierCitations(['[CLAUDE.md:9]'], ctxAvecRegles())?.citees).toEqual(['CLAUDE.md:9'])
  })

  it('dédoublonne, ignore les entrées non-textuelles, et rend undefined quand il n\'y a rien', () => {
    expect(verifierCitations(['CLAUDE.md:5', 'CLAUDE.md:5'], ctxAvecRegles())?.citees).toHaveLength(1)
    expect(verifierCitations([42, null], ctxAvecRegles())).toBeUndefined()
    expect(verifierCitations([], ctxAvecRegles())).toBeUndefined()
    expect(verifierCitations('CLAUDE.md:5', ctxAvecRegles())).toBeUndefined()
  })

  it('AUCUNE convention scannée → toute citation est rejetée', () => {
    // Le cas le plus dangereux : un dépôt sans règles, un modèle qui en invoque une.
    const r = verifierCitations(['CONTRIBUTING.md:12'], { conventions: undefined })
    expect(r).toEqual({ citees: [], rejetees: ['CONTRIBUTING.md:12'] })
  })

  it('indexer résout un identifiant vers la vraie règle', () => {
    const idx = indexer(ctxAvecRegles().conventions!.rules)
    expect(idx.get('CLAUDE.md:9')?.line).toBe(9)
  })
})

describe('auditWithLLM — la citation traverse jusqu\'au finding', () => {
  const ctx = (): AuditContext => ({
    signal: { projectName: 'p', phase: 'audit', timestamp: '', projectDir: '/p', changedFiles: [], retryCount: 0 },
    files: [{ path: 'a.ts', content: 'export default function a() {}' }] as ProjectFile[],
    retex: '',
    ...ctxAvecRegles(),
  })

  it('le prompt porte les règles, le finding porte la citation vérifiée', async () => {
    let promptVu = ''
    const f = await auditWithLLM({ id: 'architecture', specialty: 's' }, ctx(), async (_sys, user) => {
      promptVu = user
      return '{"status":"fail","summary":"default export interdit","conventionRefs":["CLAUDE.md:5"]}'
    })
    expect(promptVu).toContain('[CLAUDE.md:5]')
    expect(f.status).toBe('fail')
    expect(f.conventions).toEqual({ citees: ['CLAUDE.md:5'], rejetees: [] })
  })

  it('une trouvaille sans citation ne porte pas le champ — zéro bruit', async () => {
    const f = await auditWithLLM({ id: 'x', specialty: 's' }, ctx(), async () =>
      '{"status":"pass","summary":"RAS"}',
    )
    expect(f.conventions).toBeUndefined()
  })
})

// ── De bout en bout, sur de vrais dossiers ───────────────────────────────────

describe('scanConventions — sur disque réel', () => {
  let avec: string
  let sans: string

  beforeAll(() => {
    avec = mkdtempSync(path.join(tmpdir(), 'mangoqa-conv-avec-'))
    writeFileSync(
      path.join(avec, 'CLAUDE.md'),
      ['# Règles', '', '- Jamais de `default export` dans ce dépôt.', '- Toute route passe par le middleware auth.'].join('\n'),
      'utf8',
    )
    writeFileSync(path.join(avec, '.editorconfig'), '[*.ts]\nindent_size = 2\n', 'utf8')
    mkdirSync(path.join(avec, '.github'), { recursive: true })
    writeFileSync(path.join(avec, '.github', 'copilot-instructions.md'), '- Préfère les exports nommés.\n', 'utf8')
    mkdirSync(path.join(avec, 'src'), { recursive: true })
    writeFileSync(path.join(avec, 'src', 'a.ts'), 'export default function a() { return 1 }\n', 'utf8')

    sans = mkdtempSync(path.join(tmpdir(), 'mangoqa-conv-sans-'))
    mkdirSync(path.join(sans, 'src'), { recursive: true })
    writeFileSync(path.join(sans, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
    writeFileSync(path.join(sans, 'README.md'), '# Projet\n\n- Ceci n\'est pas un fichier de conventions.\n', 'utf8')
  })
  afterAll(() => {
    rmSync(avec, { recursive: true, force: true })
    rmSync(sans, { recursive: true, force: true })
  })

  it('trouve les trois familles de fichiers : racine, niché, editorconfig', () => {
    const s = scanConventions(avec)
    expect(s.absent).toBe(false)
    expect(s.files).toContain('CLAUDE.md')
    expect(s.files).toContain('.editorconfig')
    expect(s.files).toContain('.github/copilot-instructions.md')
    expect(s.rules.length).toBeGreaterThanOrEqual(4)
    // Le critère d'achèvement n°1 : fichier ET ligne, sur chaque règle.
    for (const r of s.rules) expect(r.id).toBe(`${r.file}:${r.line}`)
  })

  it('un README n\'est PAS un fichier de conventions', () => {
    // Sinon toute prose de présentation deviendrait un règlement, et l'auditeur
    // reprocherait le non-respect d'une phrase d'accroche.
    const s = scanConventions(sans)
    expect(s.absent).toBe(true)
    expect(s.rules).toHaveLength(0)
  })

  it('dossier introuvable → absent déclaré, jamais une exception', () => {
    expect(scanConventions(path.join(sans, 'nexiste-pas')).absent).toBe(true)
  })

  it('auditer un SOUS-DOSSIER trouve quand même les règles du dépôt', () => {
    // `mangoqa ./src` ne renonce pas au CLAUDE.md de la racine. Sans cette remontée,
    // Mango QA déclarerait « aucune convention documentée » sur un dépôt qui en a
    // écrit trente — une absence affirmée sans avoir été vérifiée, exactement la
    // famille de mensonge que les lots 2 et 3 existent pour supprimer.
    const s = scanConventions(path.join(avec, 'src'))
    expect(s.absent).toBe(false)
    // Le chemin reste vérifiable depuis le dossier audité : l'utilisateur peut ouvrir
    // `../CLAUDE.md` et tomber sur la ligne citée.
    expect(s.files).toContain('../CLAUDE.md')
    expect(s.rules.some(r => r.id.startsWith('../CLAUDE.md:'))).toBe(true)
  })

  it('la remontée s\'arrête à la racine du dépôt (.git)', () => {
    // Au-delà, on lirait les règles d'un projet voisin — ou celles du dossier
    // personnel de l'utilisateur, présentées comme celles de son projet.
    const racine = mkdtempSync(path.join(tmpdir(), 'mangoqa-depot-'))
    try {
      writeFileSync(path.join(racine, 'CLAUDE.md'), '- Règle du PARENT, hors dépôt.\n', 'utf8')
      const depot = path.join(racine, 'depot')
      mkdirSync(path.join(depot, '.git'), { recursive: true })
      mkdirSync(path.join(depot, 'src'), { recursive: true })
      writeFileSync(path.join(depot, 'AGENTS.md'), '- Règle DU dépôt, la seule légitime.\n', 'utf8')

      const s = scanConventions(path.join(depot, 'src'))
      expect(s.files).toContain('../AGENTS.md')
      expect(s.rules.some(r => r.text.includes('PARENT'))).toBe(false)
    } finally {
      rmSync(racine, { recursive: true, force: true })
    }
  })
})

describe('LE CRITÈRE D\'ACHÈVEMENT — rapport et surfaces', () => {
  let avec: string
  let sans: string
  const cerveau =
    (reponse: string) =>
    (id: string, blocking: boolean): Branch => ({
      id,
      label: id,
      emoji: '🏗️',
      blocking,
      relevant: files => files,
      audit: c => auditWithLLM({ id, specialty: 'peu importe' }, c, async () => reponse),
    })

  beforeAll(() => {
    avec = mkdtempSync(path.join(tmpdir(), 'mangoqa-e2e-avec-'))
    writeFileSync(path.join(avec, 'CLAUDE.md'), '# R\n\n- Jamais de `default export`.\n', 'utf8')
    mkdirSync(path.join(avec, 'src'), { recursive: true })
    writeFileSync(path.join(avec, 'src', 'a.ts'), 'export default function a() { return 1 }\n', 'utf8')

    sans = mkdtempSync(path.join(tmpdir(), 'mangoqa-e2e-sans-'))
    mkdirSync(path.join(sans, 'src'), { recursive: true })
    writeFileSync(path.join(sans, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
  })
  afterAll(() => {
    rmSync(avec, { recursive: true, force: true })
    rmSync(sans, { recursive: true, force: true })
  })

  const sansPreflight = { preflightFn: async () => ({ ok: true, cerveau: 'ollama' as const, probleme: '', dureeMs: 1 }) }

  it('1 · une trouvaille référence un fichier ET une ligne du dépôt', async () => {
    const r = await auditProject(avec, {
      ...sansPreflight,
      branches: [
        cerveau('{"status":"fail","summary":"default export","rejectionId":"no-default","conventionRefs":["CLAUDE.md:3"]}')(
          'architecture',
          true,
        ),
      ],
    })
    expect(r.conventions?.absent).toBe(false)
    expect(r.conventions?.cited).toEqual(['CLAUDE.md:3'])
    expect(r.verdict.verdict).toBe('red')
    const texte = rendreRapport(r)
    expect(texte).toContain('CLAUDE.md:3')
    expect(rendreStructureMcp(r).conventions).toMatchObject({ documentees: true, reglesInvoquees: ['CLAUDE.md:3'] })
  })

  it('2 · un projet SANS conventions le déclare, sur les trois surfaces', async () => {
    const r = await auditProject(sans, {
      ...sansPreflight,
      branches: [cerveau('{"status":"pass","summary":"RAS"}')('architecture', true)],
    })
    expect(r.conventions?.absent).toBe(true)
    expect(rendreRapport(r)).toContain('aucune documentée')
    expect(rendreTexteMcp(r)).toContain("n'en documente aucune")
    expect(rendreStructureMcp(r).conventions).toMatchObject({ documentees: false, reglesFournies: 0 })
  })

  it('une citation inventée est rejetée et AFFICHÉE, pas nettoyée', async () => {
    const r = await auditProject(avec, {
      ...sansPreflight,
      branches: [
        cerveau('{"status":"fail","summary":"viole vos règles","conventionRefs":["CLAUDE.md:404"]}')(
          'architecture',
          true,
        ),
      ],
    })
    expect(r.conventions?.cited).toEqual([])
    expect(r.conventions?.rejected).toEqual(['CLAUDE.md:404'])
    expect(rendreRapport(r)).toContain('REJETÉE')
  })

  it('--sans-conventions → champ absent, comportement d\'avant le lot 3', async () => {
    const r = await auditProject(avec, {
      ...sansPreflight,
      conventions: false,
      branches: [cerveau('{"status":"pass","summary":"RAS"}')('architecture', true)],
    })
    expect(r.conventions).toBeUndefined()
    expect(rendreRapport(r)).not.toContain('CONVENTIONS')
  })
})
