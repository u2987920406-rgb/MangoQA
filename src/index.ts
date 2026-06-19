// Mango QA — runner principal (Audit Fantôme).
//
// Cycle : MangoOS écrit <projet>/.mangoqa/phase-complete.json après chaque phase
// → Mango QA « entre sans frapper », lance ses 6 branches en parallèle, et
// répond <projet>/.mangoqa/audit-verdict.json (Feu Vert / Feu Rouge). Une
// sentinelle heartbeat (.mangoqa-active) permet à MangoOS de détecter qu'on
// tourne (isMangoQaActive). Fail-open partout : une défaillance de Mango QA ne
// doit jamais bloquer la production (MangoOS continue après timeout).
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import chokidar from 'chokidar'
import type { Branch, PhaseSignal, ProjectFile } from './types.js'
import { buildVerdict, type BranchResult } from './verdict.js'
import { loadRetexConstraints, recordRejection } from './retex.js'
import { architecture } from './branches/architecture.js'
import { accessibility } from './branches/accessibility.js'
import { security } from './branches/security.js'
import { performance } from './branches/performance.js'
import { tests } from './branches/tests.js'
import { designSystem } from './branches/design-system.js'

// Ordre = priorité de rejet (la 1ʳᵉ branche bloquante en échec porte le Feu Rouge).
const BRANCHES: Branch[] = [architecture, security, accessibility, performance, tests, designSystem]

const WORKSPACE = (process.env.MANGOAI_WORKSPACE ?? '').trim()
const HEARTBEAT_MS = 10_000
const MAX_FILES = 40
const MAX_FILE_CHARS = 16_000
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.mangoqa', '.snapshots', '.diffs'])

if (!WORKSPACE || !fs.existsSync(WORKSPACE)) {
  console.error(`[mango-qa] MANGOAI_WORKSPACE introuvable : "${WORKSPACE}". Vérifie .env.`)
  process.exit(1)
}

// ── Sentinelle heartbeat ─────────────────────────────────────────────────────
const sentinelPath = path.join(WORKSPACE, '.mangoqa-active')
function beat(): void {
  try {
    fs.writeFileSync(
      sentinelPath,
      JSON.stringify({ heartbeat: new Date().toISOString(), pid: process.pid, branches: BRANCHES.map(b => b.id) }),
      'utf8',
    )
  } catch (err) {
    console.warn('[mango-qa] heartbeat:', err instanceof Error ? err.message : err)
  }
}

// ── Lecture bornée des fichiers livrés ───────────────────────────────────────
function walkSrc(dir: string, base: string, acc: string[]): void {
  if (acc.length >= MAX_FILES) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (acc.length >= MAX_FILES) return
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walkSrc(full, base, acc)
    else if (/\.(ts|tsx|js|jsx|css|html|json)$/.test(e.name)) acc.push(path.relative(base, full))
  }
}

function readProjectFiles(projDir: string, changedFiles: string[]): ProjectFile[] {
  let rel: string[]
  if (changedFiles && changedFiles.length > 0) {
    rel = changedFiles.filter(f => !f.split(/[\\/]/).some(seg => SKIP_DIRS.has(seg)))
  } else {
    rel = []
    walkSrc(path.join(projDir, 'src'), projDir, rel)
    if (rel.length === 0) walkSrc(projDir, projDir, rel)
  }
  const out: ProjectFile[] = []
  for (const r of rel.slice(0, MAX_FILES)) {
    const abs = path.join(projDir, r)
    try {
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue
      let content = fs.readFileSync(abs, 'utf8')
      if (content.length > MAX_FILE_CHARS) content = content.slice(0, MAX_FILE_CHARS) + '\n…(tronqué)…'
      out.push({ path: r.replace(/\\/g, '/'), content })
    } catch {
      /* fichier illisible ignoré */
    }
  }
  return out
}

// ── Traitement d'un signal de phase ──────────────────────────────────────────
const lastHandled = new Map<string, string>() // projectDir → timestamp traité
const inFlight = new Set<string>() // verrou anti-chevauchement par projet

async function handleSignal(signalFile: string): Promise<void> {
  let signal: PhaseSignal
  try {
    signal = JSON.parse(fs.readFileSync(signalFile, 'utf8')) as PhaseSignal
  } catch {
    return // signal partiel/illisible — chokidar awaitWriteFinish limite déjà ce cas
  }
  const projDir = signal.projectDir
  if (!projDir || !fs.existsSync(projDir)) return

  // Dédup (add + change pour la même écriture) + verrou.
  if (lastHandled.get(projDir) === signal.timestamp) return
  if (inFlight.has(projDir)) return
  inFlight.add(projDir)
  lastHandled.set(projDir, signal.timestamp)

  const t0 = Date.now()
  console.log(`\n[mango-qa] 🛡️  Audit « ${signal.projectName} » — phase « ${signal.phase} » (tentative ${signal.retryCount})`)

  try {
    const files = readProjectFiles(projDir, signal.changedFiles ?? [])
    const retex = loadRetexConstraints(WORKSPACE, signal)

    const results: BranchResult[] = await Promise.all(
      BRANCHES.map(async branch => {
        const relevant = branch.relevant(files)
        const finding = await branch.audit({ signal, files: relevant, retex })
        const icon = finding.status === 'fail' ? '🔴' : finding.status === 'pass' ? '🟢' : '⚪'
        console.log(`  ${icon} ${branch.emoji} ${branch.label}: ${finding.summary}`)
        return { branch, finding }
      }),
    )

    const verdict = buildVerdict(results, signal.retryCount)
    const qaDir = path.join(projDir, '.mangoqa')
    if (!fs.existsSync(qaDir)) fs.mkdirSync(qaDir, { recursive: true })
    fs.writeFileSync(path.join(qaDir, 'audit-verdict.json'), JSON.stringify(verdict, null, 2), 'utf8')

    if (verdict.verdict === 'red' && verdict.rejection) {
      recordRejection(WORKSPACE, signal, verdict.rejection)
      console.log(`[mango-qa] 🔴 Feu Rouge (${verdict.rejection.branch}) en ${Date.now() - t0}ms → ${verdict.rejection.corrective_action}`)
    } else {
      console.log(`[mango-qa] ✅ Feu Vert en ${Date.now() - t0}ms`)
    }
  } catch (err) {
    console.error('[mango-qa] audit:', err instanceof Error ? err.message : err)
    // Fail-open : on n'écrit pas de verdict → MangoOS continue après timeout.
  } finally {
    inFlight.delete(projDir)
  }
}

// ── Démarrage ────────────────────────────────────────────────────────────────
beat()
setInterval(beat, HEARTBEAT_MS)

const pattern = path.join(WORKSPACE, '*', '.mangoqa', 'phase-complete.json').replace(/\\/g, '/')
const watcher = chokidar.watch(pattern, {
  ignoreInitial: true, // ne pas rejouer un signal périmé au boot
  awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
})
watcher.on('add', f => void handleSignal(f))
watcher.on('change', f => void handleSignal(f))

console.log(`[mango-qa] 🥭 Mango QA actif — ${BRANCHES.length} branches`)
console.log(`[mango-qa] workspace : ${WORKSPACE}`)
console.log(`[mango-qa] sentinelle : ${sentinelPath}`)
console.log('[mango-qa] en attente de phase-complete.json…')

function shutdown(): void {
  try {
    fs.unlinkSync(sentinelPath)
  } catch {
    /* déjà absente */
  }
  void watcher.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
