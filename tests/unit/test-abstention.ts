// J4-a — « n'a pas JUGÉ » ne doit plus ressembler à « a jugé et n'a rien trouvé ».
//
// Le défaut, mesuré en sonde le 2026-08-05 : un cerveau qui RÉPOND mais ne tient pas
// le contrat JSON (modèle trop petit, non-instruct) faisait tomber les six branches en
// `skip` ; `buildVerdict` n'y voyait aucun `fail` bloquant et rendait **green**, la
// couverture s'affichait **complète** — vraie, mais trompeuse : les fichiers avaient
// bien été envoyés, ils n'avaient simplement jamais été jugés — et la CLI sortait en
// **code 0**. Sur du code contenant un vrai défaut. En CI, ça passait.
//
// Ce fichier gèle la correction à ses quatre étages : le finding (llm.ts), le verdict
// (verdict.ts), le rapport (audit.ts) et le code de sortie (cli.ts). Zéro réseau : le
// cerveau est injecté partout où il l'est déjà en production.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { auditWithLLM } from '../../src/llm.js'
import { buildVerdict, estPanne, CAUSES_PANNE, type BranchResult } from '../../src/verdict.js'
import { auditProject } from '../../src/audit.js'
import { codeSortie, rendreRapport, EXIT } from '../../src/cli.js'
import { preflightCerveau, messagePreflight, CerveauInutilisableError } from '../../src/preflight.js'
import type { AuditContext, Branch, BranchFinding, ProjectFile } from '../../src/types.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// ── Étage 1 — le finding sait dire POURQUOI il s'abstient ────────────────────

const ctx = (files: ProjectFile[] = [{ path: 'a.ts', content: 'export const a = 1' }]): AuditContext => ({
  signal: { projectName: 'p', phase: 'audit', timestamp: '', projectDir: '/p', changedFiles: [], retryCount: 0 },
  files,
  retex: '',
})

describe('auditWithLLM — la cause de chaque abstention', () => {
  it('cerveau hors contrat (répond, mais pas en JSON) → reponse-illisible', async () => {
    const f = await auditWithLLM({ id: 'x', specialty: 's' }, ctx(), async () => 'Bien sûr ! Voici mon analyse…')
    expect(f.status).toBe('skip')
    expect(f.abstention?.cause).toBe('reponse-illisible')
    // Le détail cite la réponse : sans lui, impossible de diagnostiquer QUEL cerveau
    // déraille — et un opérateur qui ne peut pas diagnostiquer débranche l'alarme.
    expect(f.abstention?.detail).toContain('Bien sûr')
  })

  it('cerveau injoignable (lève) → cerveau-injoignable', async () => {
    const f = await auditWithLLM({ id: 'x', specialty: 's' }, ctx(), async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:11434')
    })
    expect(f.status).toBe('skip')
    expect(f.abstention?.cause).toBe('cerveau-injoignable')
    expect(f.abstention?.detail).toContain('ECONNREFUSED')
  })

  it('le juge répond skip DANS le contrat → juge-sans-avis, pas une panne', async () => {
    const f = await auditWithLLM({ id: 'x', specialty: 's' }, ctx(), async () =>
      '{"status":"skip","summary":"Rien qui relève de ma spécialité."}',
    )
    expect(f.status).toBe('skip')
    expect(f.abstention?.cause).toBe('juge-sans-avis')
    // La distinction qui rend l'alarme audible : un juge qui décline poliment n'est
    // pas une panne. Les confondre ferait sonner l'alerte à chaque audit, donc jamais.
    expect(estPanne(f.abstention)).toBe(false)
  })

  it('aucun fichier pertinent → hors-perimetre, pas une panne', async () => {
    const f = await auditWithLLM({ id: 'x', specialty: 's' }, ctx([]), async () => {
      throw new Error('le cerveau ne doit même pas être appelé')
    })
    expect(f.abstention?.cause).toBe('hors-perimetre')
    expect(estPanne(f.abstention)).toBe(false)
  })

  it('un pass reste un pass — aucune abstention parasite', async () => {
    const f = await auditWithLLM({ id: 'x', specialty: 's' }, ctx(), async () =>
      '{"status":"pass","summary":"Conforme."}',
    )
    expect(f.status).toBe('pass')
    expect(f.abstention).toBeUndefined()
  })
})

describe('estPanne — le sens par défaut', () => {
  it('abstention SANS cause déclarée → panne (jamais l\'inverse)', () => {
    // La règle décisive du lot : comme `coverage.complete`, l'optimisme n'est jamais
    // la valeur par défaut. Un producteur de `skip` qui oublierait de se déclarer fait
    // BRUIRE l'alarme au lieu de l'éteindre — c'est le bon sens de l'erreur.
    expect(estPanne(undefined)).toBe(true)
  })

  it('les deux familles sont disjointes et exhaustives', () => {
    expect(CAUSES_PANNE).toContain('reponse-illisible')
    expect(CAUSES_PANNE).toContain('cerveau-injoignable')
    expect(CAUSES_PANNE).toContain('cause-inconnue')
    expect(CAUSES_PANNE).not.toContain('hors-perimetre')
    expect(CAUSES_PANNE).not.toContain('juge-sans-avis')
  })
})

// ── Étage 2 — le verdict porte l'abstention ──────────────────────────────────

function branche(id: string, blocking: boolean, finding: BranchFinding): BranchResult {
  return {
    branch: { id, label: id, emoji: '🚨', blocking, relevant: () => [], audit: async () => finding },
    finding,
  }
}

const panne = (): BranchFinding => ({
  status: 'skip',
  summary: 'Réponse illisible.',
  abstention: { cause: 'reponse-illisible' },
})

describe('buildVerdict — les abstentions remontent', () => {
  it('LA SONDE : six branches en panne → le champ interdit de lire ce vert comme un audit', () => {
    const v = buildVerdict(
      ['architecture', 'security', 'accessibility', 'performance', 'tests'].map(id => branche(id, true, panne())),
      0,
    )
    // Le contrat FIGÉ ne bouge pas : `verdict` reste 'green'. C'est ce qui préserve le
    // fail-open vers MangoOS — une panne de Mango QA ne bloque pas la production.
    expect(v.verdict).toBe('green')
    // Mais il ne part plus SANS le dire.
    expect(v.abstentions?.jugementComplet).toBe(false)
    expect(v.abstentions?.nonJugees).toHaveLength(5)
  })

  it('la mention est recopiée EN CLAIR dans chaque résumé de branche', () => {
    const v = buildVerdict([branche('security', true, panne())], 0)
    // Un affichage non mis à jour (console, log, MangoOS) doit être incapable de
    // présenter une panne comme un « rien à signaler ». Le champ structuré est la
    // source de vérité ; ce texte est la ceinture par-dessus les bretelles.
    expect(v.branches.security.summary).toContain('NON JUGÉ')
  })

  it('hors périmètre et « sans avis » ne comptent PAS comme des pannes', () => {
    const v = buildVerdict(
      [
        branche('a', true, { status: 'skip', summary: '', abstention: { cause: 'hors-perimetre' } }),
        branche('b', true, { status: 'skip', summary: '', abstention: { cause: 'juge-sans-avis' } }),
      ],
      0,
    )
    expect(v.abstentions).toBeUndefined()
  })

  it('une branche de CONSEIL en panne ne rend pas le jugement incomplet', () => {
    const v = buildVerdict(
      [branche('security', true, { status: 'pass', summary: 'ok' }), branche('design-system', false, panne())],
      0,
    )
    // design-system ne peut jamais déclencher un feu rouge : son silence n'empêche
    // pas de statuer sur la santé du code. Il est déclaré, il ne bloque pas.
    expect(v.abstentions?.jugementComplet).toBe(true)
    expect(v.abstentions?.nonJugees).toHaveLength(1)
  })

  it('un skip SANS abstention déclarée compte comme une panne', () => {
    const v = buildVerdict([branche('security', true, { status: 'skip', summary: 'mystère' })], 0)
    expect(v.abstentions?.jugementComplet).toBe(false)
    expect(v.abstentions?.nonJugees[0].cause).toBe('cause-inconnue')
  })

  it('un FEU ROUGE reste rouge, même si une voisine n\'a pas jugé', () => {
    const v = buildVerdict(
      [branche('architecture', true, panne()), branche('security', true, { status: 'fail', summary: 'clé exposée' })],
      0,
    )
    // Un défaut TROUVÉ est un fait. Le silence d'une autre branche ne l'annule pas.
    expect(v.verdict).toBe('red')
    expect(v.rejection?.branch).toBe('security')
    expect(v.abstentions?.jugementComplet).toBe(false)
  })
})

// ── Étage 3 — le préflight ───────────────────────────────────────────────────

describe('préflight du cerveau', () => {
  it('cerveau qui tient le contrat → ok', async () => {
    const r = await preflightCerveau({ ask: async () => '{"ok":true}' })
    expect(r.ok).toBe(true)
  })

  it('cerveau bavard hors contrat → échec, avec une piste actionnable', async () => {
    const r = await preflightCerveau({ ask: async () => 'Je suis prêt à vous aider !' })
    expect(r.ok).toBe(false)
    expect(messagePreflight(r)).toMatch(/instruct|Claude/)
    // Le message dit ce qui NE s'est pas passé : sans ça, l'utilisateur croit à un
    // projet sain plutôt qu'à un outil mal configuré.
    expect(messagePreflight(r)).toContain("Aucun audit n'a été lancé")
  })

  it('cerveau injoignable → échec, sans jamais lever', async () => {
    const r = await preflightCerveau({
      ask: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    expect(r.ok).toBe(false)
    expect(r.probleme).toContain('ECONNREFUSED')
  })

  it('tolère une réponse JSON approximative : on teste la capacité, pas l\'obéissance', async () => {
    // Exiger `ok === true` au mot près recalerait des cerveaux parfaitement capables
    // d'auditer. Ce qui est testé, c'est « sait produire un objet JSON lisible ».
    const r = await preflightCerveau({ ask: async () => 'Voici : {"ok": true, "note": "prêt"} — bonne journée' })
    expect(r.ok).toBe(true)
  })
})

// ── Étage 4 — de bout en bout : la sonde ne peut plus passer ─────────────────

/** Une branche qui appelle le VRAI `auditWithLLM` (donc le vrai lecteur de réponse)
 *  avec un cerveau injecté. C'est ce qui rend cette sonde fidèle : le chemin de
 *  parsing exercé est celui de la production, pas une imitation. */
function brancheAvecCerveau(id: string, blocking: boolean, cerveau: () => Promise<string>): Branch {
  return {
    id,
    label: id,
    emoji: '🚨',
    blocking,
    relevant: files => files,
    audit: c => auditWithLLM({ id, specialty: 'peu importe' }, c, cerveau),
  }
}

describe('LA SONDE DU 2026-08-05 — un cerveau incompatible ne peut plus produire de Feu Vert', () => {
  let dossier: string
  beforeAll(() => {
    dossier = mkdtempSync(path.join(tmpdir(), 'mangoqa-j4a-'))
    mkdirSync(path.join(dossier, 'src'), { recursive: true })
    // Un VRAI défaut, du genre que le produit promet d'attraper.
    writeFileSync(
      path.join(dossier, 'src', 'api.ts'),
      'export const KEY = import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY\n',
      'utf8',
    )
  })
  afterAll(() => rmSync(dossier, { recursive: true, force: true }))

  const cerveauIncompatible = async (): Promise<string> => 'Bien sûr ! Ce code me semble correct.'

  it('le rapport dit « non jugé », le verdict figé reste green, la CLI sort en 4', async () => {
    const r = await auditProject(dossier, {
      // Le préflight passe DÉLIBÉRÉMENT : on prouve que le second volet tient tout
      // seul. Un cerveau peut répondre au test puis dérailler sur un vrai prompt —
      // le préflight ne couvre pas ça, et c'est pour ça qu'il ne suffit pas.
      preflightFn: async () => ({ ok: true, cerveau: 'ollama', probleme: '', dureeMs: 1 }),
      branches: [
        brancheAvecCerveau('security', true, cerveauIncompatible),
        brancheAvecCerveau('tests', true, cerveauIncompatible),
      ],
    })

    // Ce qui n'a PAS changé — le fail-open et le contrat figé.
    expect(r.verdict.verdict).toBe('green')
    // Ce qui a changé — et c'est tout le lot.
    expect(r.jugement.complet).toBe(false)
    expect(r.jugement.nonJugees.map(b => b.cause)).toEqual(['reponse-illisible', 'reponse-illisible'])
    expect(codeSortie(r, false)).toBe(EXIT.NON_VERIFIE)

    const texte = rendreRapport(r)
    expect(texte).toContain('NON VÉRIFIÉ')
    // Le point le plus important du fichier : ces deux mots ne doivent PAS s'afficher.
    expect(texte).not.toContain('FEU VERT')
  })

  it('la couverture peut être COMPLÈTE alors que rien n\'a été jugé — les deux mesures sont distinctes', async () => {
    const r = await auditProject(dossier, {
      preflightFn: async () => ({ ok: true, cerveau: 'ollama', probleme: '', dureeMs: 1 }),
      branches: [brancheAvecCerveau('security', true, cerveauIncompatible)],
    })
    // C'est exactement ce qui rendait la sonde trompeuse : la couverture disait vrai
    // (les fichiers ONT été envoyés) et laissait croire que l'audit avait eu lieu.
    expect(r.coverage.complete).toBe(true)
    expect(r.jugement.complet).toBe(false)
  })

  it('cerveau sain → Feu Vert normal, code 0 : aucune alarme parasite', async () => {
    const r = await auditProject(dossier, {
      preflightFn: async () => ({ ok: true, cerveau: 'ollama', probleme: '', dureeMs: 1 }),
      branches: [brancheAvecCerveau('security', true, async () => '{"status":"pass","summary":"RAS"}')],
    })
    expect(r.jugement.complet).toBe(true)
    expect(codeSortie(r, false)).toBe(EXIT.VERT)
    expect(rendreRapport(r)).toContain('FEU VERT')
  })

  it('préflight en échec → aucun audit lancé, erreur typée (pas un rapport vert)', async () => {
    await expect(
      auditProject(dossier, {
        preflightFn: async () => ({ ok: false, cerveau: 'ollama', probleme: 'hors contrat', dureeMs: 1 }),
        branches: [brancheAvecCerveau('security', true, cerveauIncompatible)],
      }),
    ).rejects.toBeInstanceOf(CerveauInutilisableError)
  })
})
