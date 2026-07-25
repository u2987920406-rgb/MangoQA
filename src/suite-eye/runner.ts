// Mango QA — Auditeur de Suite : runner (couche I/O).
//
// Scanne un dossier WORKSPACE (un sous-dossier = un projet généré), charge chaque
// manifest `.mangoapp.json` de façon défensive, audite la cohérence cross-app de
// façon déterministe, et écrit ses observations dans
//   <workspace>/.mangoqa/suite-observations.json
// Fail-open : un échec n'arrête jamais la production. Ne bloque rien (`blocking:false`).
import fs from 'node:fs'
import path from 'node:path'
import { auditSuite, type SuiteApp, type SuiteObservation, type CollectionAccess } from './audit.js'
import { atomicWriteFileSync } from '../fs-shared.js'

export const SUITE_OBSERVATIONS_FILE = 'suite-observations.json'
const MANIFEST = '.mangoapp.json'
const SKIP = new Set(['node_modules', 'dist', 'build', '.git', '.mangoqa'])
const ACCESS: readonly CollectionAccess[] = ['read', 'write', 'readwrite']

function filterStringMap(o: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(o)) if (typeof v === 'string') out[k] = v
  return out
}

/** Lit défensivement un manifest en `SuiteApp` (null si absent / corrompu / invalide). */
export function loadSuiteApp(dir: string): SuiteApp | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')) as {
      id?: unknown; name?: unknown; collections?: unknown
    }
    if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string') return null
    const collections = Array.isArray(raw.collections)
      ? raw.collections
          .filter((c): c is { name: string; access?: unknown; schema?: unknown } => !!c && typeof c.name === 'string')
          .map((c) => {
            const schema =
              c.schema && typeof c.schema === 'object' && !Array.isArray(c.schema)
                ? filterStringMap(c.schema as Record<string, unknown>)
                : undefined
            return {
              name: c.name,
              access: ACCESS.includes(c.access as CollectionAccess) ? (c.access as CollectionAccess) : 'readwrite',
              ...(schema && Object.keys(schema).length ? { schema } : {}),
            }
          })
      : []
    return { id: raw.id, name: raw.name, collections }
  } catch (err) {
    /* manifest absent (ENOENT = dossier non-app, normal) ou corrompu → ignoré, mais tracé */
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn('[mango-qa] suite:', (err as Error)?.message ?? err)
    }
    return null
  }
}

/** Scanne un workspace : un sous-dossier = un projet ; charge ses manifests conformes. */
export function readSuiteApps(workspaceDir: string): SuiteApp[] {
  const out: SuiteApp[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(workspaceDir, { withFileTypes: true })
  } catch (err) {
    /* workspace illisible → aucun manifest (fail-open) */
    console.warn('[mango-qa] suite:', (err as Error)?.message ?? err)
    return out
  }
  for (const e of entries) {
    if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith('.')) continue
    const app = loadSuiteApp(path.join(workspaceDir, e.name))
    if (app) out.push(app)
  }
  return out
}

export interface SuiteEyeDeps {
  writeFile?: (file: string, data: string) => void
  now?: () => number
  readApps?: (workspaceDir: string) => SuiteApp[]
}

/** Un passage de l'Auditeur de Suite : charge les apps, mesure, écrit, renvoie le rapport. */
export function analyzeSuite(workspaceDir: string, deps: SuiteEyeDeps = {}): { obs: SuiteObservation; apps: SuiteApp[] } {
  const writeFile = deps.writeFile ?? atomicWriteFileSync
  const now = deps.now ?? (() => Date.now())
  const readApps = deps.readApps ?? readSuiteApps

  const apps = readApps(workspaceDir)
  const obs = auditSuite(apps)
  try {
    const dir = path.join(workspaceDir, '.mangoqa')
    fs.mkdirSync(dir, { recursive: true })
    writeFile(path.join(dir, SUITE_OBSERVATIONS_FILE), JSON.stringify({ ...obs, observedAt: now() }, null, 2))
  } catch (err) {
    // fail-open : un échec d'écriture n'arrête jamais la production.
    console.warn('[mango-qa] suite:', (err as Error)?.message ?? err)
  }
  return { obs, apps }
}

export function runSuiteEye(workspaceDir: string, deps: SuiteEyeDeps = {}): SuiteObservation {
  return analyzeSuite(workspaceDir, deps).obs
}
