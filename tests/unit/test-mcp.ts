// Serveur MCP (J3) — rendu du résultat et invariant stdout.
// Déterministe, zéro réseau, zéro LLM : on teste les fonctions de rendu pures.
// Le dialogue JSON-RPC de bout en bout est vérifié par `tests/manual/test-mcp-stdio.ts`,
// qui lance un vrai process (il ne peut pas être unitaire : il EST le protocole).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rendreTexteMcp, rendreStructureMcp } from '../../src/mcp.js'
import type { AuditReport, BranchResultLite } from '../../src/audit.js'
import type { AuditCoverage } from '../../src/types.js'

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

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

function branche(over: Partial<BranchResultLite> = {}): BranchResultLite {
  return {
    id: 'performance',
    label: 'Performance',
    emoji: '⚡',
    blocking: true,
    finding: { status: 'pass', summary: 'RAS' },
    filesAudited: 19,
    durationMs: 5000,
    ...over,
  }
}

function rapport(over: Partial<AuditReport> = {}): AuditReport {
  return {
    projectName: 'projet',
    projectDir: '/p',
    verdict: { verdict: 'green', rejection: null, branches: {} },
    branches: [branche()],
    filesScanned: 19,
    coverage: { filesDiscovered: 19, filesRead: 19, filesDropped: [], filesTruncated: [], complete: true },
    jugement: { complet: true, nonJugees: [] },
    durationMs: 1234,
    empty: false,
    ...over,
  }
}

const PARTIEL = rapport({
  branches: [branche({ coverage: couverture(5, 19) })],
  coverage: { filesDiscovered: 20, filesRead: 19, filesDropped: ['x.ts'], filesTruncated: [], complete: false },
})

describe('serveur MCP — rendu texte', () => {
  it('la couverture précède le verdict — un client LLM lit dans l\'ordre', () => {
    const txt = rendreTexteMcp(PARTIEL)
    expect(txt.indexOf('COUVERTURE')).toBeLessThan(txt.indexOf('VERDICT'))
  })

  it('lecture partielle : avertissement explicite + interdiction de conclure par absence', () => {
    const txt = rendreTexteMcp(PARTIEL)
    expect(txt).toContain('⚠️ COUVERTURE INCOMPLÈTE')
    expect(txt).toContain('SUR LECTURE PARTIELLE')
    // Sans cette phrase, un assistant rapporte « aucun problème trouvé » à l'utilisateur.
    expect(txt).toContain("Ne conclus pas à l'absence d'un défaut")
    expect(txt).toContain('5/19 fichiers envoyés au modèle')
    expect(txt).toContain('Jamais lus : x.ts')
  })

  it('couverture complète : pas d\'alarme, pas de réserve sur le verdict', () => {
    const txt = rendreTexteMcp(rapport())
    expect(txt).toContain('COUVERTURE : complète')
    expect(txt).not.toContain('⚠️')
    expect(txt).not.toContain('PARTIELLE')
  })

  it('feu rouge : correctif et règle présents (c\'est ce que l\'assistant va appliquer)', () => {
    const txt = rendreTexteMcp(
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
    expect(txt).toContain('VERDICT : FEU ROUGE')
    expect(txt).toContain('Correctif : Ajouter une clé stable')
    expect(txt).toContain('Règle : react-keys')
  })

  it('dossier vide : le dit, sans inventer un verdict rassurant', () => {
    expect(rendreTexteMcp(rapport({ empty: true }))).toContain('Aucun fichier auditable')
  })
})

describe('serveur MCP — contenu structuré', () => {
  it('`couvertureComplete` est au PREMIER niveau — impossible à manquer en désérialisant', () => {
    expect(rendreStructureMcp(PARTIEL).couvertureComplete).toBe(false)
    expect(rendreStructureMcp(rapport()).couvertureComplete).toBe(true)
  })

  it('les branches partielles sont nommées avec leur ratio et leurs fichiers non vus', () => {
    const s = rendreStructureMcp(PARTIEL) as { couverture: { branchesPartielles: unknown[] } }
    expect(s.couverture.branchesPartielles).toEqual([
      { branche: 'performance', fichiersVus: 5, fichiersPertinents: 19, fichiersNonVus: expect.any(Array) },
    ])
  })

  it('couverture complète → aucune branche partielle listée', () => {
    const s = rendreStructureMcp(rapport()) as { couverture: { branchesPartielles: unknown[] } }
    expect(s.couverture.branchesPartielles).toEqual([])
  })

  it('le rejet est null sur un feu vert, structuré sur un feu rouge', () => {
    expect(rendreStructureMcp(rapport()).rejet).toBeNull()
    const rouge = rendreStructureMcp(
      rapport({
        verdict: {
          verdict: 'red',
          rejection: { rejection_id: 'x', corrective_action: 'y', rule_ref: 'z', branch: 'security', retry_count: 0 },
          branches: {},
        },
      }),
    )
    expect(rouge.rejet).toEqual({ branche: 'security', identifiant: 'x', correctif: 'y', regle: 'z' })
  })
})

describe('serveur MCP — invariant stdout (protocole JSON-RPC)', () => {
  // Sur un transport stdio, stdout EST le canal du protocole. Un seul console.log
  // dans la chaîne d'audit produit chez le client une erreur de parsing JSON-RPC
  // opaque, sans rapport visible avec sa cause. Ce test gèle l'invariant.
  const CHAINE = [
    'src/mcp.ts',
    'src/audit.ts',
    'src/project-files.ts',
    'src/llm.ts',
    'src/verdict.ts',
    'src/fs-shared.ts',
    'src/priority.ts',
    'src/ollama-client.ts',
    'src/branches/architecture.ts',
    'src/branches/security.ts',
    'src/branches/accessibility.ts',
    'src/branches/performance.ts',
    'src/branches/tests.ts',
    'src/branches/design-system.ts',
  ]

  it.each(CHAINE)('%s n\'écrit jamais sur stdout', fichier => {
    const source = readFileSync(path.join(racine, fichier), 'utf8')
    // console.warn/error vont sur stderr : autorisés. console.log/info : interdits.
    expect(source).not.toMatch(/console\.(log|info)\(/)
    expect(source).not.toMatch(/process\.stdout\.write\(/)
  })
})
