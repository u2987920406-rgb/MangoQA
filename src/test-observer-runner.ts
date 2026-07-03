// Tests du runner I/O de l'Observateur-Conseil (#D2a). Exécution : npx tsx src/test-observer-runner.ts
// Déterministe, zéro réseau, zéro LLM — workspace temp (mkdtemp), deps injectées.
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
} from './observer-runner.js'
import type { RetexEntry } from './retex.js'

let passed = 0
let failed = 0
function check(name: string, cond: boolean): void {
  if (cond) passed++
  else {
    failed++
    console.error(`  ❌ ${name}`)
  }
}

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
});

// ── mapRetexToObserverEvents : mapping complet ───────────────────────────────
{
  const entries: RetexEntry[] = [retexEntry()]
  const events = mapRetexToObserverEvents(entries)
  check('mapping complet : 1 événement', events.length === 1)
  check('mapping complet : rejectionId ← rejection_id', events[0].rejectionId === 'r-1')
  check('mapping complet : ruleRef ← rule_ref', events[0].ruleRef === 'no-god-file')
  check('mapping complet : ts/projectName/phase/branch préservés',
    events[0].ts === retexEntry().ts &&
    events[0].projectName === 'proj-x' &&
    events[0].phase === 'build' &&
    events[0].branch === 'architecture')
}

// ── mapRetexToObserverEvents : champs manquants / ligne pourrie → ignorée ────
{
  const entries = [
    retexEntry(),
    { ...retexEntry(), rejection_id: undefined as unknown as string },
    { ...retexEntry(), branch: 123 as unknown as string },
    {} as RetexEntry,
    null as unknown as RetexEntry,
  ]
  const events = mapRetexToObserverEvents(entries)
  check('champs manquants/pourris : seule la ligne valide passe', events.length === 1)
}

// ── observerEnabled : gate insensible casse, défaut off ──────────────────────
{
  check('gate : {} → off', observerEnabled({}) === false)
  check('gate : QA_OBSERVER absent → off', observerEnabled({ QA_OBSERVER: undefined }) === false)
  check('gate : "off" → off', observerEnabled({ QA_OBSERVER: 'off' }) === false)
  check('gate : "on" → on', observerEnabled({ QA_OBSERVER: 'on' }) === true)
  check('gate : "ON" (casse) → on', observerEnabled({ QA_OBSERVER: 'ON' }) === true)
  check('gate : "1" → on', observerEnabled({ QA_OBSERVER: '1' }) === true)
  check('gate : "true" → on', observerEnabled({ QA_OBSERVER: 'true' }) === true)
  check('gate : "yes" → on', observerEnabled({ QA_OBSERVER: 'yes' }) === true)
  check('gate : "nope" → off', observerEnabled({ QA_OBSERVER: 'nope' }) === false)
}

// ── Gate off : pattern de câblage (index.ts) → rien n'est écrit ──────────────
{
  const workspace = ws('gate-off')
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, '.mangoqa-retex.jsonl'), JSON.stringify(retexEntry()) + '\n', 'utf8')
  const env = { QA_OBSERVER: 'off' }
  // Reproduit exactement le pattern de câblage d'index.ts : `if (observerEnabled()) runObserver(...)`.
  if (observerEnabled(env)) runObserver(workspace)
  check('gate off : aucun rapport écrit', !fs.existsSync(reportPath(workspace)))
  check('gate off : dossier .mangoqa non créé par l’Observateur', !fs.existsSync(path.join(workspace, '.mangoqa', OBSERVER_REPORT_FILE)))
}

// ── Gate on : rapport écrit, bonne forme (le CONTRAT lu côté MangoOS) ────────
{
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

  check('gate on : rapport écrit', fs.existsSync(reportPath(workspace)))
  const raw = JSON.parse(fs.readFileSync(reportPath(workspace), 'utf8')) as ObserverReportFile
  check('forme : generatedAt présent', typeof raw.generatedAt === 'string')
  check('forme : generatedAt ← now injecté', raw.generatedAt === fixedNow.toISOString())
  check('forme : windowEvents = nb événements mappés', raw.windowEvents === 3)
  check('forme : report présent (ObserverReport)', typeof raw.report === 'object' && raw.report !== null)
  check('forme : report.totalEvents cohérent', raw.report.totalEvents === 3)
  check('forme : rendered est une chaîne', typeof raw.rendered === 'string' && raw.rendered.length > 0)
  check('forme : rendered contient le résumé', raw.rendered.includes(raw.report.summary))
}

// ── Retex absent : pas de crash, rapport VIDE (toujours écrit sous gate on) ──
{
  const workspace = ws('no-retex')
  fs.mkdirSync(workspace, { recursive: true })
  let threw = false
  try {
    runObserver(workspace)
  } catch {
    threw = true
  }
  check('retex absent : ne lève jamais', !threw)
  check('retex absent : rapport quand même écrit (vide)', fs.existsSync(reportPath(workspace)))
  const raw = JSON.parse(fs.readFileSync(reportPath(workspace), 'utf8')) as ObserverReportFile
  check('retex absent : windowEvents = 0', raw.windowEvents === 0)
  check('retex absent : report.totalEvents = 0', raw.report.totalEvents === 0)
  check('retex absent : aucun pattern', raw.report.patterns.length === 0)
}

// ── Borne du tail respectée (anti-OOM, même famille que #L70) ────────────────
{
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
  check(`tail borné : windowEvents <= ${OBSERVER_TAIL_LINES}`, raw.windowEvents <= OBSERVER_TAIL_LINES)
  check('tail borné : windowEvents > 0 (le fichier a bien été lu)', raw.windowEvents > 0)
}

// ── deps injectées : readEntries / writeReport personnalisés (writeReport n'écrit
//    donc RIEN sur disque — seul `mkdirSync` du dossier .mangoqa reste réel, comme
//    analyzeSuite dans suite-eye/runner.ts : mêmes garanties, même pattern du repo) ─
{
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
  check('deps injectées : writeReport appelé une fois', Object.keys(written).length === 1)
  check('deps injectées : chemin cohérent (.mangoqa/observer-report.json)', !!key && key.includes('.mangoqa') && key.includes(OBSERVER_REPORT_FILE))
  check('deps injectées : rien écrit sur disque via writeReport', !fs.existsSync(reportPath(workspace)))
  const payload = JSON.parse(written[key]) as ObserverReportFile
  check('deps injectées : windowEvents = 2', payload.windowEvents === 2)
  check('deps injectées : generatedAt ← now injecté', payload.generatedAt === '2026-01-01T00:00:00.000Z')
}

// ── writeReport qui lève : n'écroule jamais runObserver (fail-open) ──────────
{
  const workspace = ws('write-fails')
  fs.mkdirSync(workspace, { recursive: true })
  let threw = false
  try {
    runObserver(workspace, {
      readEntries: () => [retexEntry()],
      writeReport: () => { throw new Error('disque plein (simulé)') },
      now: () => new Date(),
    })
  } catch {
    threw = true
  }
  check('writeReport en échec : runObserver ne lève jamais', !threw)
}

fs.rmSync(tmp, { recursive: true, force: true })

// ── Bilan ────────────────────────────────────────────────────────────────────
console.log(`\n[observer-runner] ${passed} ✅  ${failed ? failed + ' ❌' : '0 ❌'}  (${passed + failed} assertions)`)
if (failed > 0) process.exit(1)
