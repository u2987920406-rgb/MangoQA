// Tests du runner I/O de l'Observateur-Conseil (#D2a).
// Déterministe, zéro réseau, zéro LLM — workspace temp (mkdtemp), deps injectées.
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  mapRetexToObserverEvents,
  runObserver,
  observerEnabled,
  OBSERVER_TAIL_LINES,
  OBSERVER_REPORT_FILE,
  type ObserverReportFile,
} from '../../src/observer-runner.js'
import type { RetexEntry } from '../../src/retex.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mangoqa-observer-'))
const ws = (name: string): string => path.join(tmp, name)
const reportPath = (workspace: string): string => path.join(workspace, '.mangoqa', OBSERVER_REPORT_FILE)

const retexEntry = (overrides: Partial<RetexEntry> = {}): RetexEntry => ({
  ts: '2026-07-03T00:00:00.000Z',
  projectName: 'proj-x',
  phase: 'build',
  branch: 'architecture',
  rejection_id: 'r-1',
  corrective_action: 'découper le fichier',
  rule_ref: 'no-god-file',
  ...overrides,
})

describe('observer-runner', () => {
  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('mapRetexToObserverEvents : mapping complet', () => {
    const entries: RetexEntry[] = [retexEntry()]
    const events = mapRetexToObserverEvents(entries)
    expect(events.length).toBe(1)
    expect(events[0].rejectionId).toBe('r-1')
    expect(events[0].ruleRef).toBe('no-god-file')
    expect(
      events[0].ts === retexEntry().ts &&
      events[0].projectName === 'proj-x' &&
      events[0].phase === 'build' &&
      events[0].branch === 'architecture',
    ).toBe(true)
  })

  it('mapRetexToObserverEvents : champs manquants / ligne pourrie → ignorée', () => {
    const entries = [
      retexEntry(),
      { ...retexEntry(), rejection_id: undefined as unknown as string },
      { ...retexEntry(), branch: 123 as unknown as string },
      {} as RetexEntry,
      null as unknown as RetexEntry,
    ]
    const events = mapRetexToObserverEvents(entries)
    expect(events.length).toBe(1)
  })

  it('observerEnabled : gate insensible casse, défaut off', () => {
    expect(observerEnabled({})).toBe(false)
    expect(observerEnabled({ QA_OBSERVER: undefined })).toBe(false)
    expect(observerEnabled({ QA_OBSERVER: 'off' })).toBe(false)
    expect(observerEnabled({ QA_OBSERVER: 'on' })).toBe(true)
    expect(observerEnabled({ QA_OBSERVER: 'ON' })).toBe(true)
    expect(observerEnabled({ QA_OBSERVER: '1' })).toBe(true)
    expect(observerEnabled({ QA_OBSERVER: 'true' })).toBe(true)
    expect(observerEnabled({ QA_OBSERVER: 'yes' })).toBe(true)
    expect(observerEnabled({ QA_OBSERVER: 'nope' })).toBe(false)
  })

  it('gate off : pattern de câblage (index.ts) → rien n\'est écrit', () => {
    const workspace = ws('gate-off')
    fs.mkdirSync(workspace, { recursive: true })
    fs.writeFileSync(path.join(workspace, '.mangoqa-retex.jsonl'), JSON.stringify(retexEntry()) + '\n', 'utf8')
    const env = { QA_OBSERVER: 'off' }
    // Reproduit exactement le pattern de câblage d'index.ts : `if (observerEnabled()) runObserver(...)`.
    if (observerEnabled(env)) runObserver(workspace)
    expect(fs.existsSync(reportPath(workspace))).toBe(false)
    expect(fs.existsSync(path.join(workspace, '.mangoqa', OBSERVER_REPORT_FILE))).toBe(false)
  })

  it('gate on : rapport écrit, bonne forme (le CONTRAT lu côté MangoOS)', () => {
    const workspace = ws('gate-on')
    fs.mkdirSync(workspace, { recursive: true })
    const entries = [
      retexEntry({ rejection_id: 'r-1' }),
      retexEntry({ rejection_id: 'r-2' }),
      retexEntry({ rejection_id: 'r-3' }),
    ]
    fs.writeFileSync(path.join(workspace, '.mangoqa-retex.jsonl'), entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8')
    const fixedNow = new Date('2026-07-03T12:00:00.000Z')

    const env = { QA_OBSERVER: 'on' }
    if (observerEnabled(env)) runObserver(workspace, { now: () => fixedNow })

    expect(fs.existsSync(reportPath(workspace))).toBe(true)
    const raw = JSON.parse(fs.readFileSync(reportPath(workspace), 'utf8')) as ObserverReportFile
    expect(typeof raw.generatedAt).toBe('string')
    expect(raw.generatedAt).toBe(fixedNow.toISOString())
    expect(raw.windowEvents).toBe(3)
    expect(typeof raw.report === 'object' && raw.report !== null).toBe(true)
    expect(raw.report.totalEvents).toBe(3)
    expect(typeof raw.rendered === 'string' && raw.rendered.length > 0).toBe(true)
    expect(raw.rendered.includes(raw.report.summary)).toBe(true)
  })

  it('retex absent : pas de crash, rapport VIDE (toujours écrit sous gate on)', () => {
    const workspace = ws('no-retex')
    fs.mkdirSync(workspace, { recursive: true })
    expect(() => runObserver(workspace)).not.toThrow()
    expect(fs.existsSync(reportPath(workspace))).toBe(true)
    const raw = JSON.parse(fs.readFileSync(reportPath(workspace), 'utf8')) as ObserverReportFile
    expect(raw.windowEvents).toBe(0)
    expect(raw.report.totalEvents).toBe(0)
    expect(raw.report.patterns.length).toBe(0)
  })

  it('borne du tail respectée (anti-OOM, même famille que #L70)', () => {
    const workspace = ws('tail-bound')
    fs.mkdirSync(workspace, { recursive: true })
    const many: string[] = []
    const total = OBSERVER_TAIL_LINES + 200
    for (let i = 0; i < total; i++) {
      many.push(JSON.stringify(retexEntry({ rejection_id: `r-${i}` })))
    }
    fs.writeFileSync(path.join(workspace, '.mangoqa-retex.jsonl'), many.join('\n') + '\n', 'utf8')

    runObserver(workspace)
    const raw = JSON.parse(fs.readFileSync(reportPath(workspace), 'utf8')) as ObserverReportFile
    expect(raw.windowEvents <= OBSERVER_TAIL_LINES).toBe(true)
    expect(raw.windowEvents > 0).toBe(true)
  })

  // deps injectées : readEntries / writeReport personnalisés (writeReport n'écrit
  // donc RIEN sur disque — seul `mkdirSync` du dossier .mangoqa reste réel, comme
  // analyzeSuite dans suite-eye/runner.ts : mêmes garanties, même pattern du repo).
  it('deps injectées : readEntries / writeReport personnalisés', () => {
    const workspace = ws('deps-injected')
    fs.mkdirSync(workspace, { recursive: true })
    const written: Record<string, string> = {}
    const injected: RetexEntry[] = [
      retexEntry({ rejection_id: 'a' }),
      retexEntry({ rejection_id: 'b', branch: 'security' }),
    ]
    runObserver(workspace, {
      readEntries: () => injected,
      writeReport: (file, data) => { written[file] = data },
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    })
    const key = Object.keys(written)[0]
    expect(Object.keys(written).length).toBe(1)
    expect(!!key && key.includes('.mangoqa') && key.includes(OBSERVER_REPORT_FILE)).toBe(true)
    expect(fs.existsSync(reportPath(workspace))).toBe(false)
    const payload = JSON.parse(written[key]) as ObserverReportFile
    expect(payload.windowEvents).toBe(2)
    expect(payload.generatedAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('fenêtre glissante par défaut (30j) : événement ancien exclu de l\'analyse', () => {
    const workspace = ws('window-default')
    fs.mkdirSync(workspace, { recursive: true })
    const old = retexEntry({ ts: '2026-05-01T00:00:00.000Z', rejection_id: 'r-old' }) // >30j avant fixedNow
    fs.writeFileSync(path.join(workspace, '.mangoqa-retex.jsonl'), JSON.stringify(old) + '\n', 'utf8')
    const fixedNow = new Date('2026-07-19T00:00:00.000Z')

    runObserver(workspace, { now: () => fixedNow })

    const raw = JSON.parse(fs.readFileSync(reportPath(workspace), 'utf8')) as ObserverReportFile
    expect(raw.windowEvents).toBe(1) // lu depuis le Retex, avant filtrage fenêtre
    expect(raw.report.totalEvents).toBe(0) // exclu par la fenêtre glissante de 30j
    expect(raw.report.summary.includes('fenêtre')).toBe(true)
  })

  it('QA_OBSERVER_WINDOW_DAYS élargit la fenêtre : l\'événement ancien redevient visible', () => {
    const workspace = ws('window-override')
    fs.mkdirSync(workspace, { recursive: true })
    const old = retexEntry({ ts: '2026-05-01T00:00:00.000Z', rejection_id: 'r-old' })
    fs.writeFileSync(path.join(workspace, '.mangoqa-retex.jsonl'), JSON.stringify(old) + '\n', 'utf8')
    const fixedNow = new Date('2026-07-19T00:00:00.000Z')

    runObserver(workspace, { now: () => fixedNow }, { QA_OBSERVER_WINDOW_DAYS: '365' })

    const raw = JSON.parse(fs.readFileSync(reportPath(workspace), 'utf8')) as ObserverReportFile
    expect(raw.report.totalEvents).toBe(1)
  })

  it('writeReport qui lève : n\'écroule jamais runObserver (fail-open)', () => {
    const workspace = ws('write-fails')
    fs.mkdirSync(workspace, { recursive: true })
    expect(() => runObserver(workspace, {
      readEntries: () => [retexEntry()],
      writeReport: () => { throw new Error('disque plein (simulé)') },
      now: () => new Date(),
    })).not.toThrow()
  })
})
