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
import { buildGraph, type NavGraph } from './graph.js'
import { inspectFlux, type FluxObservation } from './eye.js'
import { walkTree, realWalkFs, atomicWriteFileSync } from '../fs-shared.js'

export const OBSERVATIONS_FILE = 'flux-observations.json'

const MAX_FILES = 200
const MAX_FILE_CHARS = 24_000
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.mangoqa', '.snapshots', '.diffs', 'coverage'])
const SRC_EXT = /\.(tsx|jsx|ts|js|vue|svelte|html)$/

/** Lecture bornée de tout le source d'un projet (full src — indépendant du delta).
 *  Implémentée via le `walkTree` partagé (#R3) : un fichier illisible est ignoré SANS
 *  consommer de place dans le cap `MAX_FILES` (comportement historique). */
export function readAllSource(projDir: string): ProjectFile[] {
  const out: ProjectFile[] = []
  const roots = [path.join(projDir, 'src'), projDir]
  const start = fs.existsSync(roots[0]) ? roots[0] : roots[1]
  walkTree<ProjectFile>(start, projDir, out, {
    skipDirs: SKIP_DIRS,
    extRe: SRC_EXT,
    maxFiles: MAX_FILES,
    fsx: realWalkFs,
    visit: (full, rel) => {
      try {
        let content = fs.readFileSync(full, 'utf8')
        if (content.length > MAX_FILE_CHARS) content = content.slice(0, MAX_FILE_CHARS)
        return { path: rel.replace(/\\/g, '/'), content }
      } catch (err) {
        /* fichier illisible ignoré */
        console.warn('[mango-qa] flux:', (err as Error)?.message ?? err)
        return undefined
      }
    },
    onError: err => console.warn('[mango-qa] flux:', (err as Error)?.message ?? err),
  })
  return out
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

/** Le graphe + le rapport + les fichiers lus, pour que le Tier 1 reutilise le
 * graphe sans re-scanner le source. */
export interface FluxAnalysis {
  obs: FluxObservation
  graph: NavGraph
  files: ProjectFile[]
}

/** Un passage de l'Auditeur sur un projet : lit le source UNE fois, mesure, écrit
 * les observations, et renvoie graphe + rapport + fichiers (pour le Tier 1). */
export function analyzeFlux(projDir: string, deps: FluxEyeDeps = {}): FluxAnalysis {
  const writeFile = deps.writeFile ?? atomicWriteFileSync
  const now = deps.now ?? (() => Date.now())
  const readSource = deps.readSource ?? readAllSource

  const files = readSource(projDir)
  const graph = buildGraph(files)
  const obs = inspectFlux(graph)
  try {
    const dir = path.join(projDir, '.mangoqa')
    fs.mkdirSync(dir, { recursive: true })
    writeFile(path.join(dir, OBSERVATIONS_FILE), JSON.stringify({ ...obs, observedAt: now() }, null, 2))
  } catch (err) {
    // fail-open : l'Auditeur n'arrête jamais la production pour un échec d'écriture.
    console.warn('[mango-qa] flux:', (err as Error)?.message ?? err)
  }
  return { obs, graph, files }
}

/** Passage Tier 0 simple : mesure et écrit les observations. Renvoie le rapport. */
export function runFluxEye(projDir: string, deps: FluxEyeDeps = {}): FluxObservation {
  return analyzeFlux(projDir, deps).obs
}
