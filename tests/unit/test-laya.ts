// Tests du visage Laya (SHADOW) — déterministes : fetch + fs + horloge injectés.
// Ce qui est vérifié ici : le verdict LLM n'est JAMAIS touché, le journal est
// bien formé, et chaque mode d'échec du pont reste fail-open (#Q3).
import { describe, it, expect } from 'vitest'
import {
  buildQuestions,
  buildState,
  layaEnabled,
  layaUrl,
  shadowWithLaya,
  SHADOW_FILE,
  type ShadowFs,
} from '../../src/laya.js'
import type { Branch, BranchFinding, PhaseSignal, ProjectFile } from '../../src/types.js'
import type { BranchResult } from '../../src/verdict.js'

function makeFs() {
  const files = new Map<string, string>()
  const appended: string[] = []
  const fsx: ShadowFs = {
    existsSync: p => files.has(p) || p === '/p/.mangoqa',
    writeFileSync: (p, d) => void files.set(p, d),
    mkdirSync: () => undefined,
    appendFileSync: (p, d) => {
      files.set(p, (files.get(p) ?? '') + d)
      appended.push(d)
    },
  }
  return { fsx, files, appended }
}

const signal: PhaseSignal = {
  projectName: 'proj',
  phase: 'build',
  timestamp: 't1',
  projectDir: '/p',
  changedFiles: ['src/api.ts'],
  retryCount: 0,
}

function branch(id: string, blocking = true): Branch {
  return {
    id,
    label: id,
    emoji: '🧪',
    blocking,
    relevant: files => files,
    audit: async () => ({ status: 'pass', summary: 'ok' }),
  }
}

function result(id: string, status: BranchFinding['status'], blocking = true): BranchResult {
  return {
    branch: branch(id, blocking),
    finding: { status, summary: `${id} constat` },
  }
}

const files: ProjectFile[] = [{ path: 'src/api.ts', content: 'export const x = 1' }]
const relevantOf = () => files

/** Réponse Laya canonique (format `system_one` : answers[qid].noul/confidence/choice). */
function layaReply(over: { noul?: number; choice?: string } = {}) {
  return {
    answers: {
      violation: { type: 'noul', noul: over.noul ?? 0.82, confidence: 0.82 },
      verdict: { type: 'choice', choice: over.choice ?? 'confirme', confidence: 0.77 },
    },
    ms: 143,
    model: 'convaiinnovations/laya/multilingual',
  }
}

function okFetch(reply: unknown): typeof fetch {
  return (async () => ({ ok: true, json: async () => reply })) as unknown as typeof fetch
}

const base = () => ({
  signal,
  results: [result('security', 'fail')],
  relevantOf,
  fs: makeFs().fsx,
  projDir: '/p',
  log: () => {},
  env: { QA_LAYA: 'on' } as NodeJS.ProcessEnv,
  now: () => new Date('2026-09-22T20:00:00Z'),
})

describe('gating', () => {
  it('QA_LAYA absent ou différent de "on" → aucun appel, aucun effet', async () => {
    const { fsx, appended } = makeFs()
    let called = 0
    const recs = await shadowWithLaya({
      ...base(),
      env: {},
      fs: fsx,
      fetchImpl: (async () => {
        called++
        return { ok: true, json: async () => layaReply() }
      }) as unknown as typeof fetch,
    })
    expect(recs).toEqual([])
    expect(called).toBe(0)
    expect(appended).toEqual([])
    expect(layaEnabled({})).toBe(false)
    expect(layaEnabled({ QA_LAYA: 'on' } as NodeJS.ProcessEnv)).toBe(true)
  })

  it('URL par défaut = pont local, trailing slash nettoyé', () => {
    expect(layaUrl({} as NodeJS.ProcessEnv)).toBe('http://127.0.0.1:8791')
    expect(layaUrl({ QA_LAYA_URL: 'http://h:9/' } as NodeJS.ProcessEnv)).toBe('http://h:9')
  })
})

describe('shadow', () => {
  it('journalise une ligne JSONL par branche bloquante soumise', async () => {
    const { fsx, appended } = makeFs()
    const recs = await shadowWithLaya({ ...base(), fs: fsx, fetchImpl: okFetch(layaReply()) })
    expect(recs.length).toBe(1)
    const rec = recs[0]
    expect(rec.branch).toBe('security')
    expect(rec.llm).toBe('fail')
    expect(rec.violation).toBe(0.82)
    expect(rec.verdict).toBe('confirme')
    expect(rec.ms).toBe(143)
    expect(rec.ts).toBe('2026-09-22T20:00:00.000Z')
    expect(appended.length).toBe(1)
    expect(JSON.parse(appended[0].trim())).toMatchObject({ branch: 'security', llm: 'fail' })
    expect(appended[0].endsWith('\n')).toBe(true)
  })

  it('n\'aborde que les branches bloquantes en fail/pass (skip, conseil = hors dataset)', async () => {
    const { fsx, appended } = makeFs()
    const results = [
      result('security', 'fail'),
      result('tests', 'skip'),
      result('archi', 'pass'),
      result('design-system', 'fail', false), // branche de conseil
    ]
    const recs = await shadowWithLaya({ ...base(), results, fs: fsx, fetchImpl: okFetch(layaReply()) })
    expect(recs.map(r => r.branch)).toEqual(['security', 'archi'])
    expect(appended.length).toBe(2)
  })

  it('pont en échec (HTTP 500) → warn, aucune ligne, AUCUN throw', async () => {
    const warn = (m: string) => msgs.push(m)
    const msgs: string[] = []
    const { fsx, appended } = makeFs()
    const recs = await shadowWithLaya({
      ...base(),
      fs: fsx,
      log: warn,
      fetchImpl: (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch,
    })
    expect(recs).toEqual([])
    expect(appended).toEqual([])
    expect(msgs.length).toBe(0) // warn route via console.warn — pas via log
  })

  it('réseau qui throw → absorbé, verdict LLM intact (vérifié sur audit-verdict.json)', async () => {
    const { fsx, files } = makeFs()
    const verdictBefore = files.get('/p/.mangoqa/audit-verdict.json')
    const recs = await shadowWithLaya({
      ...base(),
      fs: fsx,
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch,
    })
    expect(recs).toEqual([])
    expect(files.get('/p/.mangoqa/audit-verdict.json')).toBe(verdictBefore)
    expect(files.has(`/p/.mangoqa/${SHADOW_FILE}`)).toBe(false)
  })

  it('appendFileSync absent (fake minimal) → pas de crash, warn', async () => {
    const bare: ShadowFs = {
      existsSync: () => true,
      writeFileSync: () => {},
      mkdirSync: () => undefined,
    }
    const recs = await shadowWithLaya({
      ...base(),
      fs: bare,
      fetchImpl: okFetch(layaReply()),
    })
    expect(recs.length).toBe(1) // la mesure est retournée, seul le journal saute
  })

  it('réponse sans answers exploitables → champs null, ligne quand même écrite', async () => {
    const { fsx, appended } = makeFs()
    const recs = await shadowWithLaya({
      ...base(),
      fs: fsx,
      fetchImpl: okFetch({ answers: {}, ms: 10 }),
    })
    expect(recs[0].violation).toBeNull()
    expect(recs[0].verdict).toBeNull()
    expect(appended.length).toBe(1)
  })
})

describe('payload envoyé au pont', () => {
  it('une seule requête contenant les 2 questions (1 forward pass)', async () => {
    const bodies: string[] = []
    const { fsx } = makeFs()
    await shadowWithLaya({
      ...base(),
      fs: fsx,
      fetchImpl: (async (_url: unknown, init: RequestInit) => {
        bodies.push(String(init.body))
        return { ok: true, json: async () => layaReply() }
      }) as unknown as typeof fetch,
    })
    expect(bodies.length).toBe(1)
    const body = JSON.parse(bodies[0]) as { state: string; questions: Record<string, unknown> }
    expect(Object.keys(body.questions).sort()).toEqual(['verdict', 'violation'])
    expect(body.state).toContain('Branch: security')
    expect(body.state).toContain('audit finding: fail')
    expect(body.state).toContain('src/api.ts')
  })

  it('état borné : l\'extrait de code ne dépasse pas le budget (~1400 car.)', () => {
    const big: ProjectFile[] = [{ path: 'a.ts', content: 'x'.repeat(50_000) }]
    const state = buildState({
      signal,
      branchId: 'security',
      label: 'Sécurité',
      finding: { status: 'fail', summary: 'secret en dur' },
      files: big,
    })
    expect(state.length).toBeLessThan(2_000)
    expect(state).toContain('secret en dur')
  })

  it('questions typées conformes au schéma Laya (noul / choice+criteria)', () => {
    const q = buildQuestions() as Record<string, { type: string; criteria?: Record<string, string> }>
    expect(q.violation.type).toBe('noul')
    expect(q.verdict.type).toBe('choice')
    // Critères en anglais : le checkpoint racine est anglais-only (README).
    expect(Object.keys(q.verdict.criteria ?? {})).toEqual(['keep', 'override'])
  })
})
