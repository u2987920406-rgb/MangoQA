// Lot 4 (ADR-001) — l'axe *Spec* : le code fait-il ce qui était demandé ?
//
// Deux critères d'achèvement, fixés par l'ADR, gelés ici :
//   1. l'axe cite la ligne de spec ENTRE GUILLEMETS ;
//   2. l'absence de spec est DÉCLARÉE (« aucune spec fournie »), jamais inventée.
//
// Et une distinction qui n'est pas dans les critères mais qui fait la différence entre
// un auditeur et un censeur : **ce qui manque bloque, ce qui déborde se signale**. Faire
// plus que demandé peut être parfaitement légitime.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { extraireExigences, scanSpec, specSpecialty, SpecInutilisableError } from '../../src/spec.js'
import { spec as brancheSpec, degraderSiNonCitee } from '../../src/branches/spec.js'
import { auditWithLLM } from '../../src/llm.js'
import { auditProject, ALL_BRANCHES } from '../../src/audit.js'
import { rendreRapport } from '../../src/cli.js'
import { rendreTexteMcp, rendreStructureMcp } from '../../src/mcp.js'
import type { SpecScan } from '../../src/spec.js'
import type { AuditContext, Branch, ProjectFile } from '../../src/types.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// ── L'extraction : une exigence pointe une ligne qui existe ──────────────────

describe('extraireExigences', () => {
  const texte = [
    '# Ticket 42 — panier', // 1
    '', // 2
    'Contexte : les clients se plaignent.', // 3  ← prose sans demande
    '', // 4
    '- [ ] Afficher le total TTC dans le panier', // 5  ← case non cochée
    '- [x] Ajouter un bouton « vider le panier »', // 6  ← case COCHÉE
    '- Le panier doit survivre à un rechargement', // 7  ← puce
    '', // 8
    "L'utilisateur pourra appliquer un code promo.", // 9  ← phrase de demande
    '', // 10
    '```js', // 11
    '- exemple: cart.total()', // 12 ← dans un bloc de code
    '```', // 13
  ].join('\n')

  const ex = extraireExigences(texte)

  it('retient cases à cocher, puces et phrases de demande, à la bonne ligne', () => {
    expect(ex.map(e => e.line)).toEqual([5, 6, 7, 9])
    expect(ex[0].id).toBe('spec:5')
    expect(ex[0].text).toBe('Afficher le total TTC dans le panier')
  })

  it('garde les cases DÉJÀ COCHÉES — c\'est justement celles-là qu\'il faut vérifier', () => {
    // L'auteur affirme les avoir livrées. C'est cette affirmation que l'audit met à
    // l'épreuve. Les retirer reviendrait à croire sur parole exactement là où le produit
    // existe pour ne pas croire sur parole.
    expect(ex.find(e => e.line === 6)?.text).toBe('Ajouter un bouton « vider le panier »')
  })

  it('ignore la prose de contexte, les titres et les blocs de code', () => {
    expect(ex.some(e => e.text.includes('se plaignent'))).toBe(false)
    expect(ex.some(e => e.text.includes('cart.total'))).toBe(false)
    expect(ex.some(e => e.line === 1)).toBe(false)
  })
})

// ── Le lecteur : une spec inutilisable n'est PAS « pas de spec » ─────────────

describe('scanSpec', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mangoqa-spec-'))
    writeFileSync(path.join(dir, 'ticket.md'), '- Afficher le total TTC\n- Vider le panier\n', 'utf8')
    writeFileSync(path.join(dir, 'prose.md'), 'Un long texte de contexte, sans rien qui ressemble à une liste.\n', 'utf8')
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('lit les exigences d\'un vrai fichier', () => {
    const s = scanSpec(path.join(dir, 'ticket.md'))
    expect(s.exigences).toHaveLength(2)
    expect(s.exigences[0].id).toBe('spec:1')
  })

  it('spec introuvable → LÈVE, jamais un audit silencieusement sans spec', () => {
    // L'utilisateur a explicitement demandé qu'on juge contre un document. Lui rendre un
    // audit sans spec répondrait à une autre question que la sienne — et son feu vert
    // aurait l'air de valider la conformité alors qu'elle n'a pas été regardée.
    expect(() => scanSpec(path.join(dir, 'absent.md'))).toThrow(SpecInutilisableError)
    expect(() => scanSpec(path.join(dir, 'absent.md'))).toThrow(/retirez --spec/)
  })

  it('spec de pure prose → LÈVE avec une explication, pas un scan vide', () => {
    expect(() => scanSpec(path.join(dir, 'prose.md'))).toThrow(/aucune exigence lisible/i)
  })
})

describe('specSpecialty — le prompt porte la distinction du lot', () => {
  const scan: SpecScan = {
    file: 'ticket.md',
    exigences: [{ id: 'spec:1', line: 1, text: 'Afficher le total TTC' }],
    dropped: 0,
    vide: false,
  }
  const p = specSpecialty(scan)

  it('liste les exigences avec leur identifiant', () => {
    expect(p).toContain('[spec:1] Afficher le total TTC')
  })

  it('ce qui MANQUE est le seul motif de fail ; ce qui DÉBORDE ne bloque jamais', () => {
    expect(p).toContain('seul motif de "fail"')
    expect(p).toMatch(/ne mets JAMAIS "fail" pour ça/)
  })

  it('exige la citation ENTRE GUILLEMETS, et interdit d\'inventer une exigence', () => {
    expect(p).toContain('ENTRE GUILLEMETS')
    expect(p).toContain("N'invente aucune exigence")
  })

  it('désamorce le faux positif de couverture partielle', () => {
    // Le pire faux positif possible pour cette branche : accuser d'un manquement dont
    // l'implémentation vit dans un fichier qu'on n'a pas reçu.
    expect(p).toContain("ne compte PAS comme non satisfaite")
  })
})

// ── La branche ───────────────────────────────────────────────────────────────

const ctx = (over: Partial<AuditContext> = {}): AuditContext => ({
  signal: { projectName: 'p', phase: 'audit', timestamp: '', projectDir: '/p', changedFiles: [], retryCount: 0 },
  files: [{ path: 'src/panier.ts', content: 'export const total = () => 0' }] as ProjectFile[],
  retex: '',
  ...over,
})

const scanDeux: SpecScan = {
  file: 'ticket.md',
  exigences: [
    { id: 'spec:1', line: 1, text: 'Afficher le total TTC' },
    { id: 'spec:2', line: 2, text: 'Vider le panier' },
  ],
  dropped: 0,
  vide: false,
}

describe('branche Spec', () => {
  it('elle fait partie du registre, en PREMIER, et elle est bloquante', () => {
    // L'ordre décide quel rejet porte le Feu Rouge. Quand du code ne fait pas ce qui
    // était demandé, c'est le seul reproche qui compte : rendre « contraste
    // insuffisant » sur une fonctionnalité absente ferait travailler l'utilisateur
    // sur le mauvais problème.
    expect(ALL_BRANCHES[0].id).toBe('spec')
    expect(ALL_BRANCHES).toHaveLength(7)
    expect(brancheSpec.blocking).toBe(true)
  })

  it('sans spec → skip hors-perimetre, AUCUN appel de modèle', async () => {
    const f = await brancheSpec.audit(ctx())
    expect(f.status).toBe('skip')
    expect(f.abstention?.cause).toBe('hors-perimetre')
    expect(f.summary).toContain('Aucune spec fournie')
  })

  it('elle regarde TOUS les fichiers du périmètre', () => {
    // Filtrer par extension ferait déclarer « non satisfaite » une exigence implémentée
    // dans un fichier qu'on aurait soi-même écarté.
    const files = [{ path: 'a.ts', content: '' }, { path: 'b.css', content: '' }] as ProjectFile[]
    expect(brancheSpec.relevant(files)).toHaveLength(2)
  })
})

// ── De bout en bout ─────────────────────────────────────────────────────────

/** La branche Spec réelle avec un cerveau injecté : même prompt, même lecteur de
 *  réponse, même garde-fou — tout le chemin exercé est celui de la production, seule la
 *  réponse du modèle est fournie. */
function specAvecCerveau(reponse: string): Branch {
  return {
    ...brancheSpec,
    audit: async c => {
      if (!c.spec) return brancheSpec.audit(c)
      const f = await auditWithLLM({ id: 'spec', specialty: specSpecialty(c.spec) }, c, async () => reponse)
      return degraderSiNonCitee(f)
    },
  }
}

describe('LES CRITÈRES D\'ACHÈVEMENT — de bout en bout', () => {
  let projet: string
  let specFile: string
  beforeAll(() => {
    projet = mkdtempSync(path.join(tmpdir(), 'mangoqa-spec-e2e-'))
    mkdirSync(path.join(projet, 'src'), { recursive: true })
    writeFileSync(path.join(projet, 'src', 'panier.ts'), 'export const total = () => 0\n', 'utf8')
    specFile = path.join(projet, 'ticket.md')
    writeFileSync(specFile, '- Afficher le total TTC\n- Vider le panier\n', 'utf8')
  })
  afterAll(() => rmSync(projet, { recursive: true, force: true }))

  const base = { preflightFn: async () => ({ ok: true, cerveau: 'ollama' as const, probleme: '', dureeMs: 1 }) }

  it('1 · l\'exigence non satisfaite est citée ENTRE GUILLEMETS, avec son identifiant', async () => {
    const r = await auditProject(projet, {
      ...base,
      spec: specFile,
      branches: [
        specAvecCerveau(
          '{"status":"fail","summary":"Rien ne vide le panier.","rejectionId":"exigence-manquante","specRefs":["spec:2"]}',
        ),
      ],
    })
    expect(r.verdict.verdict).toBe('red')
    expect(r.spec.cited).toEqual(['spec:2'])
    expect(r.spec.citedTexts).toEqual([{ id: 'spec:2', text: 'Vider le panier' }])
    const texte = rendreRapport(r)
    expect(texte).toContain('« Vider le panier »')
    expect(rendreTexteMcp(r)).toContain('« Vider le panier »')
  })

  it('2 · sans spec, l\'absence est DÉCLARÉE sur les trois surfaces', async () => {
    const r = await auditProject(projet, {
      ...base,
      branches: [ALL_BRANCHES[0]], // la vraie branche Spec, sans spec fournie
    })
    expect(r.spec.file).toBeNull()
    expect(r.spec.exigencesProvided).toBe(0)
    expect(rendreRapport(r)).toContain('SPEC : aucune fournie')
    expect(rendreTexteMcp(r)).toContain('aucune fournie')
    expect(rendreStructureMcp(r).spec).toMatchObject({ fournie: false, exigencesFournies: 0 })
  })

  it('un « fail » qui ne cite AUCUNE exigence ne peut pas bloquer', async () => {
    // Un feu rouge adossé à rien de réfutable n'est pas un audit, c'est une opinion.
    const r = await auditProject(projet, {
      ...base,
      spec: specFile,
      branches: [specAvecCerveau('{"status":"fail","summary":"ça ne me plaît pas"}')],
    })
    expect(r.verdict.verdict).toBe('green')
    expect(r.branches[0].finding.summary).toContain('Observation non bloquante')
  })

  it('une exigence INVENTÉE est rejetée et reste visible', async () => {
    const r = await auditProject(projet, {
      ...base,
      spec: specFile,
      branches: [specAvecCerveau('{"status":"fail","summary":"manque","specRefs":["spec:99"]}')],
    })
    expect(r.spec.cited).toEqual([])
    expect(r.spec.rejected).toEqual(['spec:99'])
    // Rejetée donc non citée donc non bloquante : les deux garde-fous se composent.
    expect(r.verdict.verdict).toBe('green')
    expect(rendreRapport(r)).toContain('REJETÉE')
  })

  it('spec introuvable → l\'audit ne démarre pas', async () => {
    await expect(
      auditProject(projet, { ...base, spec: path.join(projet, 'nexiste-pas.md') }),
    ).rejects.toBeInstanceOf(SpecInutilisableError)
  })
})
