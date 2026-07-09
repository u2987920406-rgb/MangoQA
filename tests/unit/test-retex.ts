// Tests Vitest — Retex (Boîte Noire).
// Journalisation des rejets validés + réinjection préemptive des erreurs
// passées dans les audits suivants. Boucle d'apprentissage 100% locale.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { recordRejection, loadRetexConstraints } from '../../src/retex.js'
import type { PhaseSignal, Rejection } from '../../src/types.js'

const RETEX_FILE = '.mangoqa-retex.jsonl'

let tmpDir: string

function makeSignal(projectName = 'mango-os', phase = 'phase-1'): PhaseSignal {
  return {
    projectName,
    phase,
    timestamp: new Date().toISOString(),
    projectDir: tmpDir,
    changedFiles: [],
    retryCount: 0,
  }
}

function makeRejection(branch = 'security', id = 'SEC-001'): Rejection {
  return {
    rejection_id: id,
    corrective_action: `Fix ${id}`,
    rule_ref: `${branch}-rule`,
    branch,
    retry_count: 0,
  }
}

/** Lit les lignes non-vides du fichier retex. */
function readRetexLines(dir: string): string[] {
  const raw = fs.readFileSync(path.join(dir, RETEX_FILE), 'utf8')
  return raw.split('\n').filter(l => l.trim().length > 0)
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mangoqa-retex-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('recordRejection', () => {
  it('écrit une entrée JSONL dans le fichier retex', () => {
    const signal = makeSignal()
    const rejection = makeRejection()
    recordRejection(tmpDir, signal, rejection)

    const lines = readRetexLines(tmpDir)
    expect(lines).toHaveLength(1)
    const entry = JSON.parse(lines[0])
    expect(entry.projectName).toBe('mango-os')
    expect(entry.branch).toBe('security')
    expect(entry.rejection_id).toBe('SEC-001')
    expect(entry.corrective_action).toBe('Fix SEC-001')
    expect(entry.rule_ref).toBe('security-rule')
    expect(entry.ts).toBeDefined()
  })

  it('append-only : plusieurs appels accumulent les lignes', () => {
    recordRejection(tmpDir, makeSignal(), makeRejection('security', 'SEC-001'))
    recordRejection(tmpDir, makeSignal(), makeRejection('architecture', 'ARCH-001'))

    const lines = readRetexLines(tmpDir)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).rejection_id).toBe('SEC-001')
    expect(JSON.parse(lines[1]).rejection_id).toBe('ARCH-001')
  })
})

describe('loadRetexConstraints', () => {
  it('retourne chaîne vide quand aucun rejet enregistré', () => {
    const result = loadRetexConstraints(tmpDir, makeSignal())
    expect(result).toBe('')
  })

  it('injecte les rejets enregistrés dans le prompt', () => {
    recordRejection(tmpDir, makeSignal('mango-os'), makeRejection('security', 'SEC-001'))
    recordRejection(tmpDir, makeSignal('mango-os'), makeRejection('architecture', 'ARCH-001'))

    const result = loadRetexConstraints(tmpDir, makeSignal('mango-os'))
    expect(result).toContain('SEC-001')
    expect(result).toContain('ARCH-001')
    expect(result).toContain('security')
    expect(result).toContain('architecture')
    // Format : une ligne par entrée.
    expect(result.split('\n')).toHaveLength(2)
  })

  it('cap RETEX_INJECT_CAP (=6) : plus de 6 rejets → seulement 6 lignes', () => {
    // On enregistre 10 rejets distincts.
    for (let i = 0; i < 10; i++) {
      recordRejection(tmpDir, makeSignal('mango-os'), makeRejection('security', `SEC-${i.toString().padStart(3, '0')}`))
    }

    const result = loadRetexConstraints(tmpDir, makeSignal('mango-os'))
    const lines = result.split('\n')
    expect(lines).toHaveLength(6)
  })

  it('priorise les rejets du même projectName', () => {
    // 3 rejets d'un autre projet + 2 du projet courant = 5 total (< cap).
    for (let i = 0; i < 3; i++) {
      recordRejection(tmpDir, makeSignal('other-project'), makeRejection('security', `OTHER-${i}`))
    }
    recordRejection(tmpDir, makeSignal('mango-os'), makeRejection('security', 'MANGO-1'))
    recordRejection(tmpDir, makeSignal('mango-os'), makeRejection('security', 'MANGO-2'))

    const result = loadRetexConstraints(tmpDir, makeSignal('mango-os'))
    const lines = result.split('\n')
    // Les 2 rejets mango-os doivent apparaître (priorité), + au plus 4 other.
    expect(lines.some(l => l.includes('MANGO-1'))).toBe(true)
    expect(lines.some(l => l.includes('MANGO-2'))).toBe(true)
    // Les rejets du projet courant apparaissent AVANT les autres.
    const mangoIdx = lines.findIndex(l => l.includes('MANGO-1'))
    const otherIdx = lines.findIndex(l => l.includes('OTHER-0'))
    if (otherIdx !== -1) {
      expect(mangoIdx).toBeLessThan(otherIdx)
    }
  })

  it('dédup par rejection_id : un même id n\'apparaît qu\'une fois', () => {
    // Même rejection_id enregistré 3 fois.
    recordRejection(tmpDir, makeSignal(), makeRejection('security', 'DUP-001'))
    recordRejection(tmpDir, makeSignal(), makeRejection('security', 'DUP-001'))
    recordRejection(tmpDir, makeSignal(), makeRejection('security', 'DUP-001'))

    const result = loadRetexConstraints(tmpDir, makeSignal())
    const lines = result.split('\n')
    expect(lines.filter(l => l.includes('DUP-001'))).toHaveLength(1)
  })

  it('fichier corrompu (ligne non-JSON) → ignoré silencieusement', () => {
    recordRejection(tmpDir, makeSignal(), makeRejection('security', 'SEC-001'))
    // Append d'une ligne corrompue.
    fs.appendFileSync(path.join(tmpDir, RETEX_FILE), '{not valid json\n', 'utf8')
    recordRejection(tmpDir, makeSignal(), makeRejection('architecture', 'ARCH-001'))

    const result = loadRetexConstraints(tmpDir, makeSignal())
    expect(result).toContain('SEC-001')
    expect(result).toContain('ARCH-001')
    // La ligne corrompue ne fait pas planter le chargement.
    expect(result.split('\n')).toHaveLength(2)
  })
})