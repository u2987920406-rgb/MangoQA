// Mango QA — Auditeur de Flux : extraction du GRAPHE DE NAVIGATION (déterministe).
//
// Pur, zéro LLM, zéro I/O. À partir des fichiers source d'un projet, on reconstruit
// le plan de navigation : écrans/fenêtres/routes RENDUS vs CIBLÉS, et les points
// d'entrée. Heuristiques regex CONSERVATRICES — on ne capture que des chaînes
// LITTÉRALES (cibles calculées ignorées : mieux vaut rater que mentir). La variable
// d'état de nav est AUTO-DÉCOUVERTE (pas de « screen » codé en dur) pour coller à
// n'importe quelle app générée.
import type { ProjectFile } from '../types.js'

/** Une arête de navigation : un déclencheur (dans `from`) vers une cible. */
export interface NavEdge {
  target: string
  from: string
}

/** Le graphe de navigation reconstruit d'un projet. */
export interface NavGraph {
  /** Valeurs initiales d'état de nav + route racine — les points d'entrée. */
  entries: string[]
  /** Écrans rendus via `<stateVar> === "x"` (machine à états). */
  screensRendered: string[]
  /** Cibles `setX("x")` (changement d'écran). */
  screenTargets: NavEdge[]
  /** Types de fenêtre gérés via `.type === "x"` (WindowManager). */
  windowsRendered: string[]
  /** Cibles `openWindow({type:"x"})` / `onOpenApp("x")` / `onOpenWindow(...)`. */
  windowTargets: NavEdge[]
  /** Chemins rendus via `<Route path="x">` / `{ path: "x" }`. */
  routesRendered: string[]
  /** Cibles `to="x"` / `navigate("x")`. */
  routeTargets: NavEdge[]
  /** Le routeur a-t-il une route attrape-tout (`path="*"`) ? */
  hasCatchAllRoute: boolean
}

const ID = `["']([\\w/.:*-]+)["']`

function uniq(xs: string[]): string[] {
  return [...new Set(xs)]
}

function allMatches(re: RegExp, content: string): string[] {
  const out: string[] = []
  let m: RegExpExecArray | null
  re.lastIndex = 0
  while ((m = re.exec(content)) !== null) out.push(m[1])
  return out
}

// ── Machines à états de navigation (auto-découverte) ─────────────────────────
/** Repère `const [x, setX] = useState("init")` → { state, setter, init }.
 * On ne retient que les états dont le SETTER est ensuite appelé avec un littéral
 * (`setX("y")`) — signature d'une vraie machine de navigation, pas d'un état quelconque. */
export function findStateMachines(allContent: string): { state: string; setter: string; init: string }[] {
  const re = new RegExp(`const\\s*\\[\\s*(\\w+)\\s*,\\s*(set\\w+)\\s*\\]\\s*=\\s*useState\\s*(?:<[^>]*>)?\\s*\\(\\s*${ID}`, 'g')
  const out: { state: string; setter: string; init: string }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(allContent)) !== null) {
    const [, state, setter, init] = m
    const callRe = new RegExp(`\\b${setter}\\s*(?:\\?\\.)?\\(\\s*["']`)
    if (callRe.test(allContent)) out.push({ state, setter, init })
  }
  return out
}

// ── Construction du graphe ───────────────────────────────────────────────────
export function buildGraph(files: ProjectFile[]): NavGraph {
  const all = files.map(f => f.content).join('\n')
  const machines = findStateMachines(all)

  const entries: string[] = []
  const screensRendered: string[] = []
  const screenTargets: NavEdge[] = []
  const windowTargets: NavEdge[] = []
  const windowsRendered: string[] = []
  const routesRendered: string[] = []
  const routeTargets: NavEdge[] = []

  for (const { state, setter, init } of machines) {
    entries.push(init)
    const cmpA = new RegExp(`\\b${state}\\s*===\\s*${ID}`, 'g')
    const cmpB = new RegExp(`${ID}\\s*===\\s*${state}\\b`, 'g')
    // Le setter est souvent passé en prop sous sa forme `on`+Setter (ex. setScreen
    // → onSetScreen={setScreen}) puis appelé dans un enfant. On suit les deux formes.
    const onSetter = 'on' + setter.charAt(0).toUpperCase() + setter.slice(1)
    const callRe = new RegExp(`\\b(?:${setter}|${onSetter})\\s*(?:\\?\\.)?\\(\\s*${ID}`, 'g')
    for (const f of files) {
      screensRendered.push(...allMatches(cmpA, f.content), ...allMatches(cmpB, f.content))
      for (const t of allMatches(callRe, f.content)) screenTargets.push({ target: t, from: f.path })
    }
  }

  // Fenêtres (WindowManager) — pas de fallback : surface fiable. On restreint à
  // `win.type ===` (la convention du WindowManager) pour ne PAS confondre avec les
  // `d.type`/`e.type` des handlers de message/SSE (sinon faux positifs).
  const winRenderRe = new RegExp(`(?:win|window)\\.type\\s*===\\s*${ID}`, 'g')
  const winOpenRe = new RegExp(`(?:openWindow|onOpenWindow)\\s*(?:\\?\\.)?\\(\\s*\\{[^}]*?\\btype\\s*:\\s*${ID}`, 'g')
  const onOpenAppRe = new RegExp(`onOpenApp\\s*(?:\\?\\.)?\\(\\s*${ID}`, 'g')
  // Routes (react-router & co.)
  const routeRenderRe = new RegExp(`(?:<Route[^>]*?\\bpath|\\bpath)\\s*[=:]\\s*${ID}`, 'g')
  const toRe = new RegExp(`\\bto\\s*=\\s*${ID}`, 'g')
  const navigateRe = new RegExp(`navigate\\s*(?:\\?\\.)?\\(\\s*${ID}`, 'g')

  for (const f of files) {
    windowsRendered.push(...allMatches(winRenderRe, f.content))
    routesRendered.push(...allMatches(routeRenderRe, f.content))
    for (const t of allMatches(winOpenRe, f.content)) windowTargets.push({ target: t, from: f.path })
    for (const t of allMatches(onOpenAppRe, f.content)) windowTargets.push({ target: t, from: f.path })
    for (const t of allMatches(toRe, f.content)) routeTargets.push({ target: t, from: f.path })
    for (const t of allMatches(navigateRe, f.content)) routeTargets.push({ target: t, from: f.path })
  }

  return {
    entries: uniq(entries),
    screensRendered: uniq(screensRendered),
    screenTargets,
    windowsRendered: uniq(windowsRendered),
    windowTargets,
    routesRendered: uniq(routesRendered.filter(p => p !== '*')),
    routeTargets,
    hasCatchAllRoute: routesRendered.includes('*'),
  }
}
