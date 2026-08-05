// Tests Vitest — buildVerdict (la fonction la plus critique de MangoQA).
// Décide green/red à partir des résultats de branches. Première branche
// bloquante en échec → rejet déterministe. Branches non-bloquantes = conseil.
import { describe, it, expect } from 'vitest'
import { buildVerdict, type BranchResult } from '../../src/verdict.js'
import type { AuditCoverage, Branch, BranchFinding } from '../../src/types.js'

/** Branche bloquante factice. */
function blocking(id: string, finding: BranchFinding): BranchResult {
  const branch: Branch = {
    id,
    label: id,
    emoji: '🚨',
    blocking: true,
    relevant: () => [],
    audit: async () => finding,
  }
  return { branch, finding }
}

/** Branche non-bloquante (conseil) factice. */
function advisory(id: string, finding: BranchFinding): BranchResult {
  const branch: Branch = {
    id,
    label: id,
    emoji: '💡',
    blocking: false,
    relevant: () => [],
    audit: async () => finding,
  }
  return { branch, finding }
}

const pass = (summary = 'ok'): BranchFinding => ({ status: 'pass', summary })
const fail = (summary = 'ko'): BranchFinding => ({ status: 'fail', summary })

describe('buildVerdict', () => {
  it('all pass → green', () => {
    const results: BranchResult[] = [
      blocking('architecture', pass('arch ok')),
      blocking('security', pass('sec ok')),
    ]
    const v = buildVerdict(results, 0)
    expect(v.verdict).toBe('green')
    expect(v.rejection).toBeNull()
    expect(Object.keys(v.branches)).toHaveLength(2)
  })

  it('première branche bloquante en échec → red + rejection.branch = celle qui a échoué', () => {
    const results: BranchResult[] = [
      blocking('architecture', fail('arch cassée')),
      blocking('security', pass('sec ok')),
    ]
    const v = buildVerdict(results, 0)
    expect(v.verdict).toBe('red')
    expect(v.rejection).not.toBeNull()
    expect(v.rejection!.branch).toBe('architecture')
    expect(v.rejection!.retry_count).toBe(0)
  })

  it('branche non-bloquante en échec → green (ignorée pour la décision)', () => {
    const results: BranchResult[] = [
      advisory('design-system', fail('design cassé')),
      blocking('architecture', pass('arch ok')),
    ]
    const v = buildVerdict(results, 0)
    expect(v.verdict).toBe('green')
    expect(v.rejection).toBeNull()
    // La branche non-bloquante est tout de même rapportée dans branches.
    expect(v.branches['design-system'].status).toBe('fail')
  })

  it('résultats mixtes → red + bonne branche (la première bloquante en échec)', () => {
    const results: BranchResult[] = [
      advisory('design-system', fail('design cassé')),
      blocking('architecture', pass('arch ok')),
      blocking('security', fail('sec cassée')),
      blocking('performance', fail('perf cassée')),
    ]
    const v = buildVerdict(results, 2)
    expect(v.verdict).toBe('red')
    expect(v.rejection).not.toBeNull()
    // La première bloquante en échec est security (architecture a passé).
    expect(v.rejection!.branch).toBe('security')
    expect(v.rejection!.retry_count).toBe(2)
    // Toutes les branches sont rapportées.
    expect(Object.keys(v.branches)).toHaveLength(4)
  })

  it('rejection utilise les champs personnalisés du finding quand présents', () => {
    const finding: BranchFinding = {
      status: 'fail',
      summary: 'fail summary',
      rejectionId: 'SEC-001',
      correctiveAction: 'Fix the thing',
      ruleRef: 'rule-sec-1',
    }
    const results: BranchResult[] = [blocking('security', finding)]
    const v = buildVerdict(results, 1)
    expect(v.verdict).toBe('red')
    expect(v.rejection!.rejection_id).toBe('SEC-001')
    expect(v.rejection!.corrective_action).toBe('Fix the thing')
    expect(v.rejection!.rule_ref).toBe('rule-sec-1')
  })

  it('rejection utilise les valeurs de fallback quand champs personnalisés absents', () => {
    const results: BranchResult[] = [blocking('security', fail('fail summary'))]
    const v = buildVerdict(results, 1)
    expect(v.rejection!.rejection_id).toBe('security-anomalie')
    expect(v.rejection!.corrective_action).toBe('fail summary')
    expect(v.rejection!.rule_ref).toBe('security')
  })

  // ── Couverture (J1 défaut n°2 — l'audit partiel silencieux) ────────────────
  // « Un auditeur a le droit de ne pas tout lire ; il n'a pas le droit de le taire. »
  describe('couverture déclarée', () => {
    const cov = (filesRendered: number, filesTotal: number): AuditCoverage => ({
      filesTotal,
      filesRendered,
      omitted: Array.from({ length: filesTotal - filesRendered }, (_, i) => `omis${i}.ts`),
      truncated: [],
      sourceTruncated: [],
      charsTotal: filesTotal * 1000,
      charsRendered: filesRendered * 1000,
      complete: filesRendered === filesTotal,
    })

    it('lecture partielle → verdict.coverage.partial nomme la branche et son ratio', () => {
      const results: BranchResult[] = [
        blocking('architecture', { ...pass('arch ok'), coverage: cov(5, 19) }),
        blocking('security', { ...pass('sec ok'), coverage: cov(4, 4) }),
      ]
      const v = buildVerdict(results, 0)
      expect(v.coverage!.complete).toBe(false)
      expect(v.coverage!.partial).toEqual([{ branch: 'architecture', filesRendered: 5, filesTotal: 19 }])
    })

    it('le Feu Vert partiel le DIT aussi en clair dans le résumé de branche', () => {
      const results: BranchResult[] = [blocking('architecture', { ...pass('arch ok'), coverage: cov(5, 19) })]
      const v = buildVerdict(results, 0)
      expect(v.verdict).toBe('green')
      expect(v.branches['architecture'].summary).toBe('arch ok [lecture partielle : 5/19 fichiers audités]')
    })

    it('couverture complète → aucune mention parasite, summary intact', () => {
      const results: BranchResult[] = [blocking('architecture', { ...pass('arch ok'), coverage: cov(19, 19) })]
      const v = buildVerdict(results, 0)
      expect(v.coverage).toEqual({ complete: true, partial: [] })
      expect(v.branches['architecture'].summary).toBe('arch ok')
    })

    it('AUCUNE branche mesurée → coverage ABSENT, jamais complete:true (non mesuré ≠ tout lu)', () => {
      const v = buildVerdict([blocking('architecture', pass('arch ok'))], 0)
      expect(v.coverage).toBeUndefined()
    })

    it('un Feu Rouge partiel porte aussi sa couverture (le rejet reste inchangé)', () => {
      const results: BranchResult[] = [blocking('security', { ...fail('faille XSS'), coverage: cov(2, 9) })]
      const v = buildVerdict(results, 0)
      expect(v.verdict).toBe('red')
      expect(v.rejection!.branch).toBe('security')
      expect(v.coverage!.partial).toEqual([{ branch: 'security', filesRendered: 2, filesTotal: 9 }])
    })
  })
})