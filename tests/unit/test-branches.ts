// Phase 6 — Tests vitest des 6 branches LLM du Visage 2 (Observateur).
//
// Couverture par branche :
//   - relevant() retourne true pour les bons fichiers, false pour les mauvais.
//   - audit() avec un mock LLM « fail » → BranchFinding.status = 'fail'.
//   - audit() avec un mock LLM « pass » → BranchFinding.status = 'pass'.
//   - audit() avec un mock LLM qui plante → fail-open (status = 'skip').
//   - blocking est correct (design-system = false, les 5 autres = true).
//
// Stratégie de mock : on mocke `query` du SDK @anthropic-ai/claude-agent-sdk
// (appelé en interne par askClaude → auditWithLLM). Ainsi auditWithLLM s'exécute
// RÉELLEMENT : son try/catch fail-open, son parsing JSON, et la conversion
// adviceOnly (fail→pass) sont testés pour de vrai. On contrôle la sortie LLM
// via une string JSON parsée par parseFirstJson.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock du SDK Claude : la fonction `query` est remplacée par un vi.fn().
// Le reste du module est vide (askClaude n'utilise que `query`).
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}))

// (#165) askLLM (llm.ts) tente Ollama AVANT Claude. Sans mock, l'appel réel au daemon
// Ollama ferait expirer ces tests (timeout vitest 5s << QA_OLLAMA_TIMEOUT_MS). On simule
// "Ollama injoignable" par un rejet INSTANTANÉ — le comportement RÉEL en cas
// d'indisponibilité, qui déclenche la bascule immédiate vers le mock Claude ci-dessus.
//
// (2026-08-05) Ce mock visait `fetch` ; il visait donc le TRANSPORT, pas l'intention.
// Quand askOllama est passé de `fetch` à `node:http` (pour échapper au plafond caché de
// 300 s d'undici, cf. ollama-client.ts), le piège est devenu inopérant sans rien casser
// de visible : les 18 tests partaient pour de bon sur le réseau. On mocke désormais la
// FRONTIÈRE — le module cerveau — qui, elle, ne change pas quand le transport change.
vi.mock('../../src/ollama-client.js', () => ({
  askOllama: vi.fn(() => Promise.reject(new Error('mock (test) : Ollama indisponible'))),
}))

import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Query } from '@anthropic-ai/claude-agent-sdk'
import { accessibility } from '../../src/branches/accessibility.js'
import { architecture } from '../../src/branches/architecture.js'
import { designSystem } from '../../src/branches/design-system.js'
import { performance } from '../../src/branches/performance.js'
import { security } from '../../src/branches/security.js'
import { tests } from '../../src/branches/tests.js'
import type { AuditContext, ProjectFile } from '../../src/types.js'

const mockQuery = vi.mocked(query)

/** Construit un AuditContext minimal avec les fichiers donnés. */
function ctx(files: ProjectFile[]): AuditContext {
  return {
    signal: {
      projectName: 'test-project',
      phase: 'phase-1',
      timestamp: '2026-07-07T00:00:00.000Z',
      projectDir: '/tmp/test',
      changedFiles: files.map(f => f.path),
      retryCount: 0,
    },
    files,
    retex: '',
  }
}

const file = (path: string, content = '// code'): ProjectFile => ({ path, content })

/** Configure le mock LLM pour répondre avec un objet JSON (texte dans un message assistant). */
function llmResponds(jsonText: string) {
  const gen = (async function* () {
    yield {
      type: 'assistant' as const,
      message: { content: [{ type: 'text' as const, text: jsonText }] },
    }
  })()
  mockQuery.mockReturnValue(gen as unknown as Query)
}

/** Configure le mock LLM pour planter (simule une erreur réseau/SDK). */
function llmThrows(err: Error) {
  mockQuery.mockImplementation(() => {
    throw err
  })
}

beforeEach(() => {
  mockQuery.mockReset()
})

// ── Accessibilité ────────────────────────────────────────────────────────────
describe('Branche ♿ Accessibilité', () => {
  it('relevant() retourne les fichiers UI (.jsx/.tsx/.html)', () => {
    const files = [
      file('src/Button.jsx'),
      file('src/app.html'),
      file('src/style.css'),
      file('README.md'),
    ]
    const kept = accessibility.relevant(files)
    expect(kept.map(f => f.path).sort()).toEqual(['src/Button.jsx', 'src/app.html'])
  })

  it('relevant() retourne [] pour des fichiers non-UI', () => {
    expect(accessibility.relevant([file('a.ts'), file('b.css'), file('c.json')])).toEqual([])
  })

  it('audit() LLM fail → BranchFinding.status = fail', async () => {
    llmResponds(
      JSON.stringify({
        status: 'fail',
        summary: 'input sans label',
        rejectionId: 'missing-label',
        correctiveAction: 'ajouter un label',
        ruleRef: 'WCAG 1.3.1',
      }),
    )
    const finding = await accessibility.audit(ctx([file('Form.jsx')]))
    expect(finding.status).toBe('fail')
    expect(finding.summary).toBe('input sans label')
    expect(finding.rejectionId).toBe('missing-label')
    expect(finding.ruleRef).toBe('WCAG 1.3.1')
  })

  it('audit() LLM pass → BranchFinding.status = pass', async () => {
    llmResponds(JSON.stringify({ status: 'pass', summary: 'RAS' }))
    const finding = await accessibility.audit(ctx([file('Button.jsx')]))
    expect(finding.status).toBe('pass')
  })

  it('audit() LLM plante → fail-open (skip)', async () => {
    llmThrows(new Error('réseau KO'))
    const finding = await accessibility.audit(ctx([file('Button.jsx')]))
    expect(finding.status).toBe('skip')
    expect(finding.summary).toContain('réseau KO')
  })

  it('blocking = true', () => {
    expect(accessibility.blocking).toBe(true)
  })
})

// ── Architecture ─────────────────────────────────────────────────────────────
describe('Branche 🏗️ Architecture', () => {
  it('relevant() retourne les fichiers de code (.ts/.tsx/.js/.jsx)', () => {
    const files = [file('src/index.ts'), file('src/App.tsx'), file('README.md'), file('data.json')]
    const kept = architecture.relevant(files)
    expect(kept.map(f => f.path).sort()).toEqual(['src/App.tsx', 'src/index.ts'])
  })

  it('relevant() retourne [] pour des fichiers non-code', () => {
    expect(architecture.relevant([file('a.md'), file('b.css'), file('c.json')])).toEqual([])
  })

  it('audit() LLM fail → BranchFinding.status = fail', async () => {
    llmResponds(
      JSON.stringify({
        status: 'fail',
        summary: 'monolithe 800 lignes',
        rejectionId: 'god-file',
        correctiveAction: 'découper',
        ruleRef: 'arch-modularity',
      }),
    )
    const finding = await architecture.audit(ctx([file('big.ts')]))
    expect(finding.status).toBe('fail')
    expect(finding.rejectionId).toBe('god-file')
  })

  it('audit() LLM pass → BranchFinding.status = pass', async () => {
    llmResponds(JSON.stringify({ status: 'pass', summary: 'Bien découpé' }))
    const finding = await architecture.audit(ctx([file('ok.ts')]))
    expect(finding.status).toBe('pass')
  })

  it('audit() LLM plante → fail-open (skip)', async () => {
    llmThrows(new Error('timeout'))
    const finding = await architecture.audit(ctx([file('ok.ts')]))
    expect(finding.status).toBe('skip')
  })

  it('blocking = true', () => {
    expect(architecture.blocking).toBe(true)
  })
})

// ── Design System ────────────────────────────────────────────────────────────
describe('Branche 🎨 Design System (conseil only)', () => {
  it('relevant() retourne les fichiers style (.css/.jsx/.tsx/.html)', () => {
    const files = [file('src/theme.css'), file('src/Button.jsx'), file('README.md'), file('data.json')]
    const kept = designSystem.relevant(files)
    expect(kept.map(f => f.path).sort()).toEqual(['src/Button.jsx', 'src/theme.css'])
  })

  it('relevant() retourne [] pour des fichiers non-style', () => {
    expect(designSystem.relevant([file('a.ts'), file('b.json'), file('c.md')])).toEqual([])
  })

  it('audit() LLM fail → FORCÉ en pass (adviceOnly ne bloque jamais)', async () => {
    llmResponds(
      JSON.stringify({
        status: 'fail',
        summary: 'palette incohérente',
        rejectionId: 'palette',
        correctiveAction: 'uniformiser',
        ruleRef: 'design',
      }),
    )
    const finding = await designSystem.audit(ctx([file('theme.css')]))
    // adviceOnly : un fail du LLM est converti en pass par auditWithLLM.
    expect(finding.status).toBe('pass')
    expect(finding.summary).toBe('palette incohérente')
    // Pas de rejectionId car ce n'est pas un fail.
    expect(finding.rejectionId).toBeUndefined()
  })

  it('audit() LLM pass → BranchFinding.status = pass', async () => {
    llmResponds(JSON.stringify({ status: 'pass', summary: 'tokens cohérents' }))
    const finding = await designSystem.audit(ctx([file('theme.css')]))
    expect(finding.status).toBe('pass')
    expect(finding.summary).toBe('tokens cohérents')
  })

  it('audit() LLM plante → fail-open (skip)', async () => {
    llmThrows(new Error('coupure'))
    const finding = await designSystem.audit(ctx([file('theme.css')]))
    expect(finding.status).toBe('skip')
  })

  it('blocking = false (conseil uniquement)', () => {
    expect(designSystem.blocking).toBe(false)
  })
})

// ── Performance ──────────────────────────────────────────────────────────────
describe('Branche ⚡ Performance', () => {
  it('relevant() retourne les fichiers React (.jsx/.tsx/.js)', () => {
    const files = [file('src/List.jsx'), file('src/hook.tsx'), file('src/util.js'), file('README.md'), file('a.css')]
    const kept = performance.relevant(files)
    expect(kept.map(f => f.path).sort()).toEqual(['src/List.jsx', 'src/hook.tsx', 'src/util.js'])
  })

  // (2026-08-05) Test remis d'aplomb : il attendait encore l'exclusion de `.ts`, alors que
  // la mesure J0 (cas PERF-03, eval/rapports/J0-2026-08-04-17-47-21.md) a DÉLIBÉRÉMENT
  // ajouté `.ts` au filtre — sans quoi utils, hooks, stores et clients d'API n'étaient
  // jamais audités. C'est le test qui était périmé, pas la branche.
  it('relevant() retourne [] pour des fichiers sans code (styles, données, docs)', () => {
    expect(performance.relevant([file('b.css'), file('c.json'), file('README.md')])).toEqual([])
  })

  it('relevant() retient les .ts non-composants (utils, logique) — cas PERF-03', () => {
    const kept = performance.relevant([file('src/utils/format.ts'), file('a.css')])
    expect(kept.map(f => f.path)).toEqual(['src/utils/format.ts'])
  })

  it('audit() LLM fail → BranchFinding.status = fail', async () => {
    llmResponds(
      JSON.stringify({
        status: 'fail',
        summary: 'key=index sur liste mutable',
        rejectionId: 'unstable-key',
        correctiveAction: 'utiliser un id stable',
        ruleRef: 'react-keys',
      }),
    )
    const finding = await performance.audit(ctx([file('List.jsx')]))
    expect(finding.status).toBe('fail')
    expect(finding.rejectionId).toBe('unstable-key')
  })

  it('audit() LLM pass → BranchFinding.status = pass', async () => {
    llmResponds(JSON.stringify({ status: 'pass', summary: 'ok' }))
    const finding = await performance.audit(ctx([file('List.jsx')]))
    expect(finding.status).toBe('pass')
  })

  it('audit() LLM plante → fail-open (skip)', async () => {
    llmThrows(new Error('500'))
    const finding = await performance.audit(ctx([file('List.jsx')]))
    expect(finding.status).toBe('skip')
  })

  it('blocking = true', () => {
    expect(performance.blocking).toBe(true)
  })
})

// ── Sécurité ─────────────────────────────────────────────────────────────────
describe('Branche 🔒 Sécurité', () => {
  it('relevant() retourne les fichiers sensibles par chemin', () => {
    const files = [file('server/auth.ts'), file('api/route.ts'), file('README.md')]
    const kept = security.relevant(files)
    expect(kept.map(f => f.path).sort()).toEqual(['api/route.ts', 'server/auth.ts'])
  })

  it('relevant() retourne les fichiers par contenu sensible', () => {
    const kept = security.relevant([file('src/utils.ts', 'const apiKey = "sk-12345"')])
    expect(kept).toHaveLength(1)
  })

  it('relevant() retourne [] pour des fichiers neutres', () => {
    expect(
      security.relevant([
        file('src/Button.jsx', 'export const B = () => <div/>'),
        file('README.md', '# Doc'),
      ]),
    ).toEqual([])
  })

  it('audit() LLM fail → BranchFinding.status = fail', async () => {
    llmResponds(
      JSON.stringify({
        status: 'fail',
        summary: 'secret en dur',
        rejectionId: 'hardcoded-secret',
        correctiveAction: 'utiliser env',
        ruleRef: 'OWASP A05',
      }),
    )
    const finding = await security.audit(ctx([file('server/auth.ts', 'const token = "x"')]))
    expect(finding.status).toBe('fail')
    expect(finding.ruleRef).toBe('OWASP A05')
  })

  it('audit() LLM pass → BranchFinding.status = pass', async () => {
    llmResponds(JSON.stringify({ status: 'pass', summary: 'RAS' }))
    const finding = await security.audit(ctx([file('server/auth.ts')]))
    expect(finding.status).toBe('pass')
  })

  it('audit() LLM plante → fail-open (skip)', async () => {
    llmThrows(new Error('network'))
    const finding = await security.audit(ctx([file('server/auth.ts')]))
    expect(finding.status).toBe('skip')
  })

  it('blocking = true', () => {
    expect(security.blocking).toBe(true)
  })
})

// ── Tests ───────────────────────────────────────────────────────────────────
describe('Branche 🧪 Tests', () => {
  it('relevant() retourne les fichiers de code + package.json', () => {
    const files = [file('src/index.ts'), file('package.json'), file('README.md')]
    const kept = tests.relevant(files)
    expect(kept.map(f => f.path).sort()).toEqual(['package.json', 'src/index.ts'])
  })

  it('relevant() retourne [] pour des fichiers non-code', () => {
    expect(tests.relevant([file('a.md'), file('b.css')])).toEqual([])
  })

  it('audit() LLM fail → BranchFinding.status = fail', async () => {
    llmResponds(
      JSON.stringify({
        status: 'fail',
        summary: 'logique métier non testée',
        rejectionId: 'missing-tests',
        correctiveAction: 'ajouter vitest',
        ruleRef: 'test-coverage',
      }),
    )
    const finding = await tests.audit(ctx([file('calc.ts')]))
    expect(finding.status).toBe('fail')
    expect(finding.rejectionId).toBe('missing-tests')
  })

  it('audit() LLM pass → BranchFinding.status = pass', async () => {
    llmResponds(JSON.stringify({ status: 'pass', summary: 'couvert' }))
    const finding = await tests.audit(ctx([file('calc.ts')]))
    expect(finding.status).toBe('pass')
  })

  it('audit() LLM plante → fail-open (skip)', async () => {
    llmThrows(new Error('boom'))
    const finding = await tests.audit(ctx([file('calc.ts')]))
    expect(finding.status).toBe('skip')
  })

  it('blocking = true', () => {
    expect(tests.blocking).toBe(true)
  })
})