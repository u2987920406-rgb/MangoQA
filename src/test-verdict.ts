// Tests Vitest — buildVerdict (la fonction la plus critique de MangoQA).
// Décide green/red à partir des résultats de branches. Première branche
// bloquante en échec → rejet déterministe. Branches non-bloquantes = conseil.
import { describe, it, expect } from 'vitest'
import { buildVerdict, type BranchResult } from './verdict.js'
import type { Branch, BranchFinding } from './types.js'

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
})