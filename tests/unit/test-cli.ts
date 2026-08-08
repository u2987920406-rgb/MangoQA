// Tests de la CLI (J3). Déterministe, zéro réseau, zéro LLM : on teste les parties
// PURES — analyse des arguments, code de sortie, rendu du rapport. `main()` n'est pas
// testée ici : elle n'ajoute que du câblage (console, process.env, fichier).
//
// Ce qui compte le plus dans ce fichier : les CODES DE SORTIE. C'est le seul contrat
// qu'une CI consomme, et le seul qu'on ne peut pas changer sans casser des pipelines.
import { describe, it, expect } from 'vitest'
import { parseArgs, codeSortie, rendreRapport, EXIT, type CliOptions } from '../../src/cli.js'
import { dateLocaleIso, type AuditReport } from '../../src/audit.js'
import type { AuditCoverage } from '../../src/types.js'

const opts = (argv: string[]): CliOptions => {
  const r = parseArgs(argv)
  if ('aide' in r) throw new Error('aide inattendue')
  if ('commande' in r) throw new Error('commande inattendue')
  return r
}

function couverture(rendus: number, total: number): AuditCoverage {
  return {
    filesTotal: total,
    filesRendered: rendus,
    omitted: Array.from({ length: total - rendus }, (_, i) => `omis${i}.ts`),
    truncated: [],
    sourceTruncated: [],
    charsTotal: total * 1000,
    charsRendered: rendus * 1000,
    complete: rendus === total,
  }
}

function rapport(over: Partial<AuditReport> = {}): AuditReport {
  return {
    projectName: 'projet',
    projectDir: '/p',
    conditions: { date: '2026-08-08T05:00:00.000Z', cerveau: 'claude', modele: 'claude-opus-5', version: '2.1.0' },
    verdict: { verdict: 'green', rejection: null, branches: {} },
    branches: [],
    filesScanned: 3,
    coverage: { filesDiscovered: 3, filesRead: 3, filesDropped: [], filesTruncated: [], complete: true },
    jugement: { complet: true, nonJugees: [] },
    spec: { file: null, exigencesProvided: 0, exigencesDropped: 0, cited: [], rejected: [], citedTexts: [] },
    durationMs: 1234,
    empty: false,
    ...over,
  }
}

/** Un rapport où `n` branche(s) bloquante(s) n'ont pas PU juger (J4-a). */
function nonJuge(n = 1): Pick<AuditReport, 'jugement'> {
  return {
    jugement: {
      complet: false,
      nonJugees: Array.from({ length: n }, (_, i) => ({
        id: `b${i}`,
        label: `Branche ${i}`,
        cause: 'reponse-illisible' as const,
        blocking: true,
      })),
    },
  }
}

describe('CLI — analyse des arguments', () => {
  it('dossier seul : valeurs par défaut (concurrency 1, pas de JSON, pas de strict)', () => {
    const o = opts(['./mon-projet'])
    expect(o.dossier).toBe('./mon-projet')
    expect(o.concurrency).toBe(1)
    expect(o.json).toBe(false)
    expect(o.exigerCouverture).toBe(false)
  })

  it('sans argument → aide (jamais une erreur : un utilisateur perdu n\'est pas en faute)', () => {
    expect(parseArgs([])).toHaveProperty('aide')
    expect(parseArgs(['--help'])).toHaveProperty('aide')
  })

  it('--only accepte des branches connues, REFUSE les inconnues en les nommant', () => {
    expect(opts(['.', '--only', 'security,tests']).only).toEqual(['security', 'tests'])
    expect(() => opts(['.', '--only', 'securite'])).toThrow(/securite/)
  })

  it('--json seul = stdout ; --json <fichier> = fichier', () => {
    const sansFichier = opts(['.', '--json'])
    expect(sansFichier.json).toBe(true)
    expect(sansFichier.jsonFichier).toBeUndefined()
    expect(opts(['.', '--json', 'r.json']).jsonFichier).toBe('r.json')
  })

  it('--json suivi d\'une AUTRE option ne l\'avale pas comme nom de fichier', () => {
    const o = opts(['.', '--json', '--exiger-couverture'])
    expect(o.jsonFichier).toBeUndefined()
    expect(o.exigerCouverture).toBe(true)
  })

  it('valeurs numériques invalides refusées, pas silencieusement corrigées', () => {
    expect(() => opts(['.', '--concurrency', '0'])).toThrow()
    expect(() => opts(['.', '--concurrency', 'six'])).toThrow()
    expect(() => opts(['.', '--cap', '-5'])).toThrow()
  })

  it('option inconnue et double dossier : erreurs explicites', () => {
    expect(() => opts(['.', '--verbeux'])).toThrow(/--verbeux/)
    expect(() => opts(['a', 'b'])).toThrow(/un seul dossier/i)
  })

  it('une option en fin de ligne sans sa valeur lève, au lieu de partir sur un défaut', () => {
    expect(() => opts(['.', '--cap'])).toThrow(/--cap/)
  })
})

describe('CLI — codes de sortie (contrat CI)', () => {
  it('feu vert, couverture complète → 0', () => {
    expect(codeSortie(rapport(), false)).toBe(EXIT.VERT)
  })

  it('feu rouge → 1, quelle que soit la couverture', () => {
    const rouge = rapport({
      verdict: {
        verdict: 'red',
        rejection: { rejection_id: 'x', corrective_action: 'y', rule_ref: 'z', branch: 'security', retry_count: 0 },
        branches: {},
      },
    })
    expect(codeSortie(rouge, false)).toBe(EXIT.ROUGE)
    expect(codeSortie(rouge, true)).toBe(EXIT.ROUGE)
  })

  it('feu vert sur lecture PARTIELLE → 0 par défaut (déclaré, pas bloquant)', () => {
    const partiel = rapport({
      coverage: { filesDiscovered: 19, filesRead: 19, filesDropped: [], filesTruncated: [], complete: false },
    })
    expect(codeSortie(partiel, false)).toBe(EXIT.VERT)
  })

  it('… mais → 3 avec --exiger-couverture : « rien vu » n\'est pas « rien à signaler »', () => {
    const partiel = rapport({
      coverage: { filesDiscovered: 19, filesRead: 19, filesDropped: [], filesTruncated: [], complete: false },
    })
    expect(codeSortie(partiel, true)).toBe(EXIT.PARTIEL)
    // Le code PARTIEL doit rester DISTINCT du rouge : aucun défaut n'a été trouvé.
    expect(EXIT.PARTIEL).not.toBe(EXIT.ROUGE)
  })

  it('(J4-a) branche bloquante non JUGÉE → 4, TOUJOURS — aucun drapeau ne le désarme', () => {
    const r = rapport(nonJuge())
    // Contrairement à `PARTIEL` : une lecture partielle est un mode dégradé qu'on peut
    // assumer, une absence de jugement n'est pas un audit. Sortir 0 ici, c'est
    // certifier ce qu'on n'a pas vérifié — et en CI, personne ne le voit.
    expect(codeSortie(r, false)).toBe(EXIT.NON_VERIFIE)
    expect(codeSortie(r, true)).toBe(EXIT.NON_VERIFIE)
    expect(EXIT.NON_VERIFIE).not.toBe(EXIT.VERT)
  })

  it('(J4-a) le ROUGE prime sur le non-jugé : un défaut trouvé est un fait', () => {
    const r = rapport({
      ...nonJuge(),
      verdict: {
        verdict: 'red',
        rejection: { rejection_id: 'x', corrective_action: 'y', rule_ref: 'z', branch: 'security', retry_count: 0 },
        branches: {},
      },
    })
    expect(codeSortie(r, false)).toBe(EXIT.ROUGE)
  })

  it('(P5) un dossier SANS fichier auditable sort en 4, jamais en 0', () => {
    // Trouvé par le persona P5 : un projet Django contenant une injection SQL flagrante
    // rendait « aucun fichier auditable » et code 0 — donc passait en CI pour toujours,
    // sans qu'un seul fichier ait été lu. Un audit vide n'est pas un audit réussi.
    const vide = rapport({ empty: true, branches: [], filesScanned: 0 })
    expect(codeSortie(vide, false)).toBe(EXIT.NON_VERIFIE)
    expect(codeSortie(vide, true)).toBe(EXIT.NON_VERIFIE)
  })

  it('(P5) le rendu vide NOMME les extensions lues, et refuse le mot « vert »', () => {
    // Une limite qu'on ne nomme pas se lit comme une absence de problème.
    const texte = rendreRapport(rapport({ empty: true, branches: [] }))
    expect(texte).toContain('AUCUN FICHIER AUDITABLE')
    expect(texte).toContain('.tsx')
    expect(texte).toContain('Python')
    expect(texte).not.toContain('FEU VERT')
  })

  it('(P6) la date du rapport est LOCALE, pas UTC', () => {
    // Troisième passage de ce piège dans le dépôt. Le premier jet affichait « rendu le
    // 03:21 » pour un audit lancé à 05:21 — un rapport daté de deux heures avant l'audit
    // est pire qu'un rapport sans date : il a l'air précis.
    const t = new Date(2026, 7, 8, 5, 21, 44).getTime()
    const iso = dateLocaleIso(t)
    expect(iso.slice(0, 19)).toBe('2026-08-08T05:21:44')
    expect(iso).toMatch(/[+-]\d{2}:\d{2}$/)
    // Et il doit rester lisible par un lecteur de dates standard.
    expect(new Date(iso).getTime()).toBe(t)
  })

  it('(P4) le rapport porte QUAND et PAR QUOI il a été rendu', () => {
    // Une freelance veut joindre le rapport machine à une livraison client. Sans date ni
    // cerveau, ce n'est pas une preuve, c'est une capture d'écran — et c'était une
    // contradiction interne : la sortie TEXTE annonce le cerveau depuis le lot 0,
    // précisément parce que deux cerveaux différents ne sont pas comparables.
    const texte = rendreRapport(rapport())
    expect(texte).toContain('claude-opus-5')
    expect(texte).toContain('2026-08-08')
    expect(texte).toContain('mangoqa 2.1.0')
  })

  it('(P1) une branche qui n\'a rien regardé n\'affiche pas un nombre de fichiers', () => {
    // La branche Spec sans spec affichait « 2 fichiers », ce qui se lit comme
    // « j'ai regardé 2 fichiers ». Elle n'en avait regardé aucun.
    const texte = rendreRapport(
      rapport({
        branches: [
          {
            id: 'spec',
            label: 'Spec',
            emoji: '📋',
            blocking: true,
            finding: { status: 'skip', summary: 'Aucune spec fournie.', abstention: { cause: 'hors-perimetre' } },
            filesAudited: 2,
            durationMs: 0,
          },
        ],
      }),
    )
    expect(texte).not.toContain('2 fichiers')
  })

  it('(J4-a) le rendu ne dit PAS « FEU VERT » quand rien n\'a été jugé', () => {
    const texte = rendreRapport(rapport(nonJuge()))
    expect(texte).toContain('NON VÉRIFIÉ')
    expect(texte).not.toContain('FEU VERT')
    expect(texte).toContain('JUGEMENT')
  })
})

describe('CLI — rendu du rapport', () => {
  const brancheOver = (cov: AuditCoverage | undefined) => ({
    id: 'performance',
    label: 'Performance',
    emoji: '⚡',
    blocking: true,
    finding: { status: 'pass' as const, summary: 'RAS' },
    filesAudited: cov?.filesTotal ?? 0,
    ...(cov ? { coverage: cov } : {}),
    durationMs: 5000,
  })

  it('couverture complète : une seule ligne, sans alarme inutile', () => {
    const txt = rendreRapport(rapport({ branches: [brancheOver(couverture(19, 19))] }))
    expect(txt).toContain('COUVERTURE : complète')
    expect(txt).not.toContain('⚠️')
    expect(txt).toContain('🟢 FEU VERT')
  })

  it('couverture partielle : la réserve est SUR la ligne de verdict, pas en bas de page', () => {
    const txt = rendreRapport(
      rapport({
        branches: [brancheOver(couverture(5, 19))],
        coverage: { filesDiscovered: 20, filesRead: 19, filesDropped: ['x.ts'], filesTruncated: [], complete: false },
      }),
    )
    const ligneVerdict = txt.split('\n').find(l => l.includes('FEU VERT'))!
    expect(ligneVerdict).toContain('SUR LECTURE PARTIELLE')
    // Les fichiers non vus sont NOMMÉS, pas seulement comptés.
    expect(txt).toContain('5/19 fichiers envoyés au modèle')
    expect(txt).toContain('non vus :')
    expect(txt).toContain('Jamais lus : x.ts')
  })

  it('dossier vide : le dit, sans inventer un verdict rassurant', () => {
    // (2026-08-08) Formulation durcie après le persona P5 : « aucun fichier auditable »
    // ne suffisait pas — il faut dire que ce n'est PAS un feu vert. Voir les deux tests
    // (P5) ci-dessous, qui couvrent le message et le code de sortie.
    const txt = rendreRapport(rapport({ empty: true, branches: [], filesScanned: 0 }))
    expect(txt.toUpperCase()).toContain('AUCUN FICHIER AUDITABLE')
    expect(txt).not.toContain('FEU VERT')
  })

  it('feu rouge : correctif et règle affichés (c\'est ce que l\'utilisateur va appliquer)', () => {
    const txt = rendreRapport(
      rapport({
        verdict: {
          verdict: 'red',
          rejection: {
            rejection_id: 'missing-key',
            corrective_action: 'Ajouter une clé stable',
            rule_ref: 'react-keys',
            branch: 'performance',
            retry_count: 0,
          },
          branches: {},
        },
      }),
    )
    expect(txt).toContain('🔴 FEU ROUGE — branche performance (missing-key)')
    expect(txt).toContain('Ajouter une clé stable')
    expect(txt).toContain('react-keys')
  })
})
