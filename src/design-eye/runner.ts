// Mango QA — Visage 3 : runner de l'Œil Design (couche I/O).
//
// L'Œil regarde le RENDU produit. À chaque phase terminée (même signal que les
// branches d'audit), il lit les fichiers de style du projet, MESURE (contraste,
// tokens, conformité) de façon déterministe, et écrit ses observations dans
//   <projet>/.mangoqa/design-observations.json
// À CÔTÉ du verdict d'audit — il n'y touche JAMAIS. L'Œil ne bloque rien
// (`blocking: false`) : il converge avec Raf. Fail-open : un échec n'arrête rien.
import fs from 'node:fs'
import path from 'node:path'
import {
  inspectDesign,
  extractContrastPairs,
  extractCssColors,
  type DesignContext,
  type DesignObservation,
} from './eye.js'
import { normalizeHex } from './tokens.js'
import { readJsonlTail } from '../jsonl.js'
import { atomicWriteFileSync } from '../fs-shared.js'
import type { ProjectFile } from '../types.js'

export const OBSERVATIONS_FILE = 'design-observations.json'

/** Flux du Bus exporté par le pont MangoOS (cf. kernel-mangoqa-bridge.ts). */
const BUS_EVENTS_FILE = 'bus-events.jsonl'
/** Événement « cible design » publié par MangoOS (kernel-design-events.ts). */
const DESIGN_REFERENCE_EVENT = 'design.reference'

/** Lit la DERNIÈRE référence design (palette Sharingan/Perfect Plan) du flux du
 * Bus, pour ce projet → l'Œil la passe en `brief` et mesure enfin la conformité
 * (briefDrift). Tolérant : flux absent/corrompu → undefined (pas de brief).
 * #Q1 — lecture BORNÉE par la queue (jsonl.ts) : le flux append-only grossit sans
 * limite, le relire ENTIER à chaque phase menait à la même famille d'OOM que #L70 ;
 * la dernière référence vit dans les événements récents = la queue suffit. */
export function readLatestBrief(workspace: string, project?: string): DesignContext['brief'] | undefined {
  type BriefEvent = { type?: string; sender?: string; payload?: { project?: string; palette?: unknown } }
  const rows = readJsonlTail<BriefEvent>(path.join(workspace, '.mangoqa', BUS_EVENTS_FILE))
  let palette: string[] | undefined
  for (const e of rows) {
    if (e.type !== DESIGN_REFERENCE_EVENT) continue
    if (project && e.payload?.project !== project && e.sender !== project) continue
    if (Array.isArray(e.payload?.palette) && e.payload.palette.length > 0) {
      palette = (e.payload.palette as unknown[]).filter((c): c is string => typeof c === 'string')
    }
  }
  return palette && palette.length > 0 ? { palette } : undefined
}

/** Un fichier de projet, pour l'Œil Design — unifié sur `ProjectFile` (#R2 : ce type
 *  dupliquait auparavant `ProjectFile` de types.ts, champ pour champ). Alias conservé pour
 *  ne pas casser un éventuel import externe du nom `DesignFile`. */
export type DesignFile = ProjectFile

const STYLE_EXT = ['.css', '.scss', '.jsx', '.tsx', '.html', '.vue', '.svelte']
function isStyle(p: string): boolean {
  return STYLE_EXT.some(e => p.endsWith(e))
}

/** Palette DÉCLARÉE = valeurs hex assignées à des variables CSS (`--x: #hex`)
 * ou des tokens `@theme`. C'est le design system du projet : tout hex employé
 * ailleurs et absent d'ici est « hors palette ». */
export function extractDeclaredPalette(css: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const re = /--[\w-]+\s*:\s*(#[0-9a-fA-F]{3,6})\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css)) !== null) {
    const n = normalizeHex(m[1])
    if (n && !seen.has(n)) {
      seen.add(n)
      out.push(n)
    }
  }
  return out
}

/** Construit un contexte design à partir des fichiers de style d'un projet, puis
 * lance l'Œil. La palette déclarée (variables CSS) sert de référence de tokens. */
export function inspectProjectDesign(files: ProjectFile[], brief?: DesignContext['brief']): DesignObservation {
  const styleFiles = files.filter(f => isStyle(f.path))
  const allCss = styleFiles.map(f => f.content).join('\n')

  const palette = extractDeclaredPalette(allCss)
  const ctx: DesignContext = {
    palette,
    pairs: extractContrastPairs(allCss),
    usedColors: extractCssColors(allCss),
    brief,
  }
  return inspectDesign(ctx)
}

export interface DesignEyeDeps {
  writeFile?: (file: string, data: string) => void
  now?: () => number
}

/** Un passage de l'Œil sur un projet : mesure et écrit les observations.
 * N'écrit AUCUN verdict, ne renvoie aucun blocage. Renvoie le rapport. */
export function runDesignEye(
  projDir: string,
  files: ProjectFile[],
  deps: DesignEyeDeps = {},
  brief?: DesignContext['brief'],
): DesignObservation {
  const writeFile = deps.writeFile ?? atomicWriteFileSync
  const now = deps.now ?? (() => Date.now())

  const obs = inspectProjectDesign(files, brief)
  try {
    const dir = path.join(projDir, '.mangoqa')
    fs.mkdirSync(dir, { recursive: true })
    writeFile(path.join(dir, OBSERVATIONS_FILE), JSON.stringify({ ...obs, observedAt: now() }, null, 2))
  } catch (err) {
    // fail-open : l'Œil n'arrête jamais la production pour un échec d'écriture.
    console.warn('[mango-qa] œil-design:', (err as Error)?.message ?? err)
  }
  return obs
}
