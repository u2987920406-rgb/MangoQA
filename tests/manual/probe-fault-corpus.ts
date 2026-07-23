// Sonde RÉELLE (#196 fault-finding Partie 4.1, plan MangoOS run-login-cached-noodle.md) :
// « MangoQA rattrape-t-il vraiment les défauts RÉELS déjà documentés dans la
// mémoire MangoOS ? ». VRAIS appels LLM (askLLM par défaut : Ollama qwen3.5:cloud
// primaire, repli abonnement Claude) — pas de mock, pas de `ask` injecté. Une QA
// qui rate un vrai défaut connu donne une fausse confiance, pire qu'aucune QA.
//
// Exécution : npx tsx tests/manual/probe-fault-corpus.ts   (PAS `npm test` — ce
// script fait de vrais appels réseau/LLM, coûte du temps et n'est pas
// déterministe ; même tier logique que `test-llm.ts`/`test-disjoncteur-*` dans
// manual/, mais celui-ci n'a PAS de `ask` injecté par construction — c'est le
// point : on veut savoir ce que le VRAI système fait, pas rejouer sa logique.
import { architecture } from '../../src/branches/architecture.js'
import { security } from '../../src/branches/security.js'
import { accessibility } from '../../src/branches/accessibility.js'
import { performance } from '../../src/branches/performance.js'
import { tests } from '../../src/branches/tests.js'
import { designSystem } from '../../src/branches/design-system.js'
import type { Branch, ProjectFile, AuditContext } from '../../src/types.js'
import { FAULT_CORPUS } from './fault-corpus-data.js'

const BRANCHES: Branch[] = [architecture, security, accessibility, performance, tests, designSystem]

function baseSignal(projectName: string) {
  return {
    projectName,
    phase: 'build',
    timestamp: new Date(0).toISOString(),
    projectDir: `/probe/${projectName}`,
    changedFiles: [],
    retryCount: 0,
  }
}

interface ItemResult {
  id: string
  incident: string
  expectedCatchers: string[]
  caughtBy: string[]
  verdict: 'CAUGHT' | 'MISSED'
  matchesExpectation: boolean
  details: { branch: string; status: string; summary: string }[]
}

async function probeItem(id: string, incident: string, files: ProjectFile[], expectedCatchers: string[]): Promise<ItemResult> {
  const details: ItemResult['details'] = []
  const caughtBy: string[] = []
  for (const branch of BRANCHES) {
    const relevant = branch.relevant(files)
    if (relevant.length === 0) {
      details.push({ branch: branch.id, status: 'skip (non pertinent)', summary: '' })
      continue
    }
    const ctx: AuditContext = { signal: baseSignal(id), files: relevant, retex: '' }
    process.stdout.write(`  … ${branch.id} audite « ${id} »… `)
    const finding = await branch.audit(ctx)
    console.log(finding.status)
    details.push({ branch: branch.id, status: finding.status, summary: finding.summary })
    if (finding.status === 'fail') caughtBy.push(branch.id)
  }
  const verdict = caughtBy.length > 0 ? 'CAUGHT' : 'MISSED'
  const matchesExpectation =
    expectedCatchers.length === 0 ? verdict === 'MISSED' : caughtBy.some((b) => expectedCatchers.includes(b)) || verdict === 'CAUGHT'
  return { id, incident, expectedCatchers, caughtBy, verdict, matchesExpectation, details }
}

async function main(): Promise<void> {
  console.log('═'.repeat(72))
  console.log('Sonde corpus de défauts réels — MangoQA vs incidents documentés MangoOS')
  console.log('═'.repeat(72))

  const results: ItemResult[] = []
  for (const item of FAULT_CORPUS) {
    console.log(`\n▶ ${item.id} — ${item.incident}`)
    const r = await probeItem(item.id, item.incident, item.files, item.expectedCatchers)
    results.push(r)
  }

  console.log(`\n${'═'.repeat(72)}`)
  console.log('RÉSUMÉ')
  console.log('─'.repeat(72))
  for (const r of results) {
    const mark = r.verdict === 'CAUGHT' ? '✅ CAUGHT' : '❌ MISSED'
    const catchers = r.caughtBy.length > 0 ? r.caughtBy.join(', ') : '(aucune)'
    console.log(`${mark}  ${r.id}  — attrapé par : ${catchers}`)
    for (const d of r.details) {
      if (d.status === 'fail') console.log(`      └─ ${d.branch} : ${d.summary}`)
    }
  }
  const missed = results.filter((r) => r.verdict === 'MISSED')
  const structuralGaps = results.filter((r) => r.expectedCatchers.length === 0 && r.verdict === 'MISSED')
  const unexpectedMisses = results.filter((r) => r.expectedCatchers.length > 0 && r.verdict === 'MISSED')
  console.log('─'.repeat(72))
  console.log(`${missed.length}/${results.length} défaut(s) non attrapé(s) par aucune branche.`)
  console.log(`  dont ${structuralGaps.length} gap(s) STRUCTUREL(S) attendu(s) (aucune branche n'a vocation à ce type de défaut).`)
  if (unexpectedMisses.length > 0) {
    console.log(`  ⚠️ dont ${unexpectedMisses.length} raté(s) INATTENDU(S) — une branche compétente (${unexpectedMisses.map((r) => r.expectedCatchers.join('/')).join(', ')}) a manqué un défaut dans son propre domaine.`)
  }
  console.log('═'.repeat(72))
}

main().catch((err) => {
  console.error('[probe-fault-corpus] erreur fatale :', err instanceof Error ? err.stack ?? err.message : err)
  process.exit(1)
})
