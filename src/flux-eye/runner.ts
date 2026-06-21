// Mango QA — Auditeur de Flux : runner (couche I/O).
//
// À chaque phase terminée (même signal que les branches et l'Œil), l'Auditeur lit
// TOUT le code source du projet (pas seulement le delta — un graphe de nav se juge
// en entier), reconstruit le plan de navigation, MESURE (fantômes, inatteignables)
// de façon déterministe, et écrit ses observations dans
//   <projet>/.mangoqa/flux-observations.json
// À CÔTÉ du verdict — il n'y touche JAMAIS. Il ne bloque rien (`blocking: false`).
// Fail-open : un échec n'arrête jamais la production.
import fs from 'node:fs'
import path from 'node:path'
import type { ProjectFile } from '../types.js'
import { buildGraph } from './graph.js'
import { inspectFlux, type FluxObservation } from './eye.js'

export const OBSERVATIONS_FILE = 'flux-observations.json'

const MAX_FILES = 200
const MAX_FILE_CHARS = 24_000
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.mangoqa', '.snapshots', '.diffs', 'coverage'])
const SRC_EXT = /\.(tsx|jsx|ts|js|vue|svelte|html)$/

/** Lecture bornée de tout le source d'un projet (full src — indépendant du delta). */
export function readAllSource(projDir: string): ProjectFile[] {
  const out: ProjectFile[] = []
  const roots = [path.join(projDir, 'src'), projDir]
  const start = fs.existsSync(roots[0]) ? roots[0] : roots[1]
  walk(start, projDir, out)
  return out
}

function walk(dir: string, base: string, acc: ProjectFile[]): void {
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
    if (e.isDirectory()) {
      walk(full, base, acc)
    } else if (SRC_EXT.test(e.name)) {
      try {
        let content = fs.readFileSync(full, 'utf8')
        if (content.length > MAX_FILE_CHARS) content = content.slice(0, MAX_FILE_CHARS)
        acc.push({ path: path.relative(base, full).replace(/\\/g, '/'), content })
      } catch {
        /* fichier illisible ignoré */
      }
    }
  }
}

/** Inspecte un ensemble de fichiers déjà lus (pur côté logique, testable). */
export function inspectProjectFlux(files: ProjectFile[]): FluxObservation {
  return inspectFlux(buildGraph(files))
}

export interface FluxEyeDeps {
  writeFile?: (file: string, data: string) => void
  now?: () => number
  readSource?: (projDir: string) => ProjectFile[]
}

/** Un passage de l'Auditeur sur un projet : mesure et écrit les observations.
 * N'écrit AUCUN verdict, ne renvoie aucun blocage. Renvoie le rapport. */
export function runFluxEye(projDir: string, deps: FluxEyeDeps = {}): FluxObservation {
  const writeFile = deps.writeFile ?? ((f, d) => fs.writeFileSync(f, d, 'utf8'))
  const now = deps.now ?? (() => Date.now())
  const readSource = deps.readSource ?? readAllSource

  const obs = inspectProjectFlux(readSource(projDir))
  try {
    const dir = path.join(projDir, '.mangoqa')
    fs.mkdirSync(dir, { recursive: true })
    writeFile(path.join(dir, OBSERVATIONS_FILE), JSON.stringify({ ...obs, observedAt: now() }, null, 2))
  } catch {
    // fail-open : l'Auditeur n'arrête jamais la production pour un échec d'écriture.
  }
  return obs
}
