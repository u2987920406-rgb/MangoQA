// Mango QA — Auditeur de Flux : extraction du GRAPHE DE NAVIGATION (déterministe).
//
// Pur, zéro LLM, zéro I/O. À partir des fichiers source d'un projet, on reconstruit
// le plan de navigation : écrans/fenêtres/routes RENDUS vs CIBLÉS, et les points
// d'entrée. La variable d'état de nav est AUTO-DÉCOUVERTE (pas de « screen » codé en dur).
//
// MOTEUR (#140-#3) : pour les fichiers JS/TS/JSX/TSX on parse un VRAI arbre syntaxique
// (tree-sitter, grammaire TSX) — fini les faux positifs des heuristiques regex (ex.
// `d.type`/`e.type` confondus avec `win.type`). Les autres langages (.vue/.svelte/.html)
// gardent un REPLI regex byte-identique à l'historique (grammaires dédiées = amélioration
// future). Conservateur comme avant : on ne capture que des chaînes LITTÉRALES passant le
// charset historique `[\w/.:*-]+` (cibles calculées ignorées — mieux vaut rater que mentir).
//
// `buildGraph` reste SYNCHRONE (contrat aval inchangé) ; le parser WASM est pré-chargé
// via `initFluxParser()` au point d'entrée (voir parser.ts).
import type { ProjectFile } from '../types.js'
import { parseTsx, tsxLanguage, isFluxParserReady } from './parser.js'

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

interface StateMachine { state: string; setter: string; init: string }

/** Contribution d'un fichier au graphe (avant dédup/agrégation globale). */
interface FilePart {
  screensRendered: string[]
  screenTargets: NavEdge[]
  windowsRendered: string[]
  windowTargets: NavEdge[]
  routesRenderedRaw: string[]
  routeTargets: NavEdge[]
}

const JS_EXT = /\.(tsx|jsx|ts|js|mjs|cjs)$/
// Charset historique de l'ancien `ID` : on ne retient que ces valeurs (équivalence stricte).
const LITERAL_OK = /^[\w/.:*-]+$/

function uniq(xs: string[]): string[] {
  return [...new Set(xs)]
}
function ok(s: string | null | undefined): s is string {
  return typeof s === 'string' && LITERAL_OK.test(s)
}
function emptyPart(): FilePart {
  return { screensRendered: [], screenTargets: [], windowsRendered: [], windowTargets: [], routesRenderedRaw: [], routeTargets: [] }
}

// ═══════════════════════════════════════════════════════════════════════════
// MOTEUR AST (tree-sitter) — fichiers JS/TS/JSX/TSX
// ═══════════════════════════════════════════════════════════════════════════

// Requêtes compilées une seule fois (après initFluxParser()).
type TSNode = any
type TSQuery = any
let Q: { decl: TSQuery; call: TSQuery; binary: TSQuery; objCall: TSQuery; jsxAttr: TSQuery; pair: TSQuery } | null = null

function queries() {
  if (Q) return Q
  const L = tsxLanguage()
  Q = {
    // const [state, setter] = useState(...)  → on valide useState + 1er arg string en JS
    decl: L.query(`(variable_declarator
      name: (array_pattern (identifier) @state (identifier) @setter)
      value: (call_expression) @call)`),
    // fn("literal")  → nom de fonction + 1er argument string littéral
    call: L.query(`(call_expression
      function: (identifier) @fn
      arguments: (arguments . (string (string_fragment) @arg)))`),
    // toute comparaison binaire (on filtre l'opérateur === en JS)
    binary: L.query(`(binary_expression) @bin`),
    // fn({ ... })  → 1er argument objet (openWindow/onOpenWindow)
    objCall: L.query(`(call_expression
      function: (identifier) @fn
      arguments: (arguments . (object) @obj))`),
    // attribut JSX  name="literal"  (path=, to=)
    jsxAttr: L.query(`(jsx_attribute (property_identifier) @name (string (string_fragment) @val))`),
    // paire d'objet  key: "literal"  (path:)
    pair: L.query(`(pair key: (property_identifier) @k value: (string (string_fragment) @v))`),
  }
  return Q
}

/** Valeur interne d'un nœud `string` (sans les guillemets), ou null si vide/absent. */
function stringValue(node: TSNode | null): string | null {
  if (!node || node.type !== 'string') return null
  for (const c of node.namedChildren) if (c.type === 'string_fragment') return c.text
  return null
}
function cap(match: { captures: { name: string; node: TSNode }[] }, name: string): TSNode | null {
  return match.captures.find((c) => c.name === name)?.node ?? null
}

/** Déclarations `[state, setter] = useState("init")` d'un arbre (avant filtre de rétention). */
function collectStateDecls(root: TSNode): StateMachine[] {
  const out: StateMachine[] = []
  for (const m of queries().decl.matches(root)) {
    const state = cap(m, 'state')?.text
    const setter = cap(m, 'setter')?.text
    const call = cap(m, 'call')
    if (!state || !setter || !call) continue
    if (!/^set\w+$/.test(setter)) continue
    const fnNode = call.childForFieldName('function')
    if (!fnNode || !/(?:^|\.)useState$/.test(fnNode.text)) continue
    const args = call.childForFieldName('arguments')
    const firstStr = args?.namedChildren.find((c: TSNode) => c.type === 'string')
    const init = stringValue(firstStr ?? null)
    if (!ok(init)) continue
    out.push({ state, setter, init })
  }
  return out
}

/** Couples (fonction, littéral) des appels `fn("x")` d'un arbre. Le charset N'EST PAS
 * filtré ici : la rétention d'une machine ne dépend que de l'EXISTENCE d'un appel
 * littéral (comme l'ancien `callRe`). Le filtre charset s'applique au push des cibles. */
function collectLiteralCalls(root: TSNode): { fn: string; arg: string }[] {
  const out: { fn: string; arg: string }[] = []
  for (const m of queries().call.matches(root)) {
    const fn = cap(m, 'fn')?.text
    const arg = cap(m, 'arg')?.text
    if (fn && typeof arg === 'string') out.push({ fn, arg })
  }
  return out
}

/** Extraction AST des contributions d'un fichier JS/TS (arbre déjà parsé). */
function extractAst(file: ProjectFile, root: TSNode, machines: StateMachine[]): FilePart {
  const part = emptyPart()
  const calls = collectLiteralCalls(root)

  // Écrans rendus (state === "x" / "x" === state) + fenêtres rendues (win.type === "x").
  for (const m of queries().binary.matches(root)) {
    const bin = cap(m, 'bin')
    if (!bin || bin.childForFieldName('operator')?.text !== '===') continue
    const left = bin.childForFieldName('left')
    const right = bin.childForFieldName('right')
    if (!left || !right) continue
    // window.type === "x"
    if (left.type === 'member_expression') {
      const obj = left.childForFieldName('object')
      const prop = left.childForFieldName('property')
      if (obj && prop && (obj.text === 'win' || obj.text === 'window') && prop.text === 'type') {
        const v = stringValue(right)
        if (ok(v)) part.windowsRendered.push(v)
      }
    }
    // stateVar === "x" (les deux sens)
    for (const { state } of machines) {
      if (left.type === 'identifier' && left.text === state) {
        const v = stringValue(right)
        if (ok(v)) part.screensRendered.push(v)
      } else if (right.type === 'identifier' && right.text === state) {
        const v = stringValue(left)
        if (ok(v)) part.screensRendered.push(v)
      }
    }
  }

  // Cibles d'écran : setX("x") / onSetX("x").
  const setterNames = new Set<string>()
  for (const { setter } of machines) {
    setterNames.add(setter)
    setterNames.add('on' + setter.charAt(0).toUpperCase() + setter.slice(1))
  }
  for (const { fn, arg } of calls) {
    if (!ok(arg)) continue
    if (setterNames.has(fn)) part.screenTargets.push({ target: arg, from: file.path })
    if (fn === 'onOpenApp') part.windowTargets.push({ target: arg, from: file.path })
    if (fn === 'navigate') part.routeTargets.push({ target: arg, from: file.path })
  }

  // Cibles de fenêtre : openWindow({ type: "x" }) / onOpenWindow({ type: "x" }).
  for (const m of queries().objCall.matches(root)) {
    const fn = cap(m, 'fn')?.text
    const obj = cap(m, 'obj')
    if (!obj || (fn !== 'openWindow' && fn !== 'onOpenWindow')) continue
    for (const pairNode of obj.namedChildren) {
      if (pairNode.type !== 'pair') continue
      const k = pairNode.childForFieldName('key')
      if (k?.text !== 'type') continue
      const v = stringValue(pairNode.childForFieldName('value'))
      if (ok(v)) part.windowTargets.push({ target: v, from: file.path })
    }
  }

  // Attributs JSX : path="x" (route rendue) · to="x" (cible route).
  for (const m of queries().jsxAttr.matches(root)) {
    const name = cap(m, 'name')?.text
    const val = cap(m, 'val')?.text
    if (!ok(val)) continue
    if (name === 'path') part.routesRenderedRaw.push(val)
    else if (name === 'to') part.routeTargets.push({ target: val, from: file.path })
  }

  // Propriétés d'objet : { path: "x" } (route rendue).
  for (const m of queries().pair.matches(root)) {
    if (cap(m, 'k')?.text !== 'path') continue
    const v = cap(m, 'v')?.text
    if (ok(v)) part.routesRenderedRaw.push(v)
  }

  return part
}

// ═══════════════════════════════════════════════════════════════════════════
// REPLI REGEX — fichiers non-JS (.vue/.svelte/.html) : comportement historique
// ═══════════════════════════════════════════════════════════════════════════

const ID = `["']([\\w/.:*-]+)["']`

function allMatches(re: RegExp, content: string): string[] {
  const out: string[] = []
  let m: RegExpExecArray | null
  re.lastIndex = 0
  while ((m = re.exec(content)) !== null) out.push(m[1])
  return out
}

function extractRegex(f: ProjectFile, machines: StateMachine[]): FilePart {
  const part = emptyPart()
  for (const { state, setter } of machines) {
    const cmpA = new RegExp(`\\b${state}\\s*===\\s*${ID}`, 'g')
    const cmpB = new RegExp(`${ID}\\s*===\\s*${state}\\b`, 'g')
    const onSetter = 'on' + setter.charAt(0).toUpperCase() + setter.slice(1)
    const callRe = new RegExp(`\\b(?:${setter}|${onSetter})\\s*(?:\\?\\.)?\\(\\s*${ID}`, 'g')
    part.screensRendered.push(...allMatches(cmpA, f.content), ...allMatches(cmpB, f.content))
    for (const t of allMatches(callRe, f.content)) part.screenTargets.push({ target: t, from: f.path })
  }
  const winRenderRe = new RegExp(`(?:win|window)\\.type\\s*===\\s*${ID}`, 'g')
  const winOpenRe = new RegExp(`(?:openWindow|onOpenWindow)\\s*(?:\\?\\.)?\\(\\s*\\{[^}]*?\\btype\\s*:\\s*${ID}`, 'g')
  const onOpenAppRe = new RegExp(`onOpenApp\\s*(?:\\?\\.)?\\(\\s*${ID}`, 'g')
  const routeRenderRe = new RegExp(`(?:<Route[^>]*?\\bpath|\\bpath)\\s*[=:]\\s*${ID}`, 'g')
  const toRe = new RegExp(`\\bto\\s*=\\s*${ID}`, 'g')
  const navigateRe = new RegExp(`navigate\\s*(?:\\?\\.)?\\(\\s*${ID}`, 'g')
  part.windowsRendered.push(...allMatches(winRenderRe, f.content))
  part.routesRenderedRaw.push(...allMatches(routeRenderRe, f.content))
  for (const t of allMatches(winOpenRe, f.content)) part.windowTargets.push({ target: t, from: f.path })
  for (const t of allMatches(onOpenAppRe, f.content)) part.windowTargets.push({ target: t, from: f.path })
  for (const t of allMatches(toRe, f.content)) part.routeTargets.push({ target: t, from: f.path })
  for (const t of allMatches(navigateRe, f.content)) part.routeTargets.push({ target: t, from: f.path })
  return part
}

// ═══════════════════════════════════════════════════════════════════════════
// API publique
// ═══════════════════════════════════════════════════════════════════════════

/** Repère `const [x, setX] = useState("init")` → { state, setter, init }, en ne retenant
 * que les états dont le SETTER est appelé avec un littéral (vraie machine de nav). */
export function findStateMachines(allContent: string): StateMachine[] {
  if (!isFluxParserReady()) return []
  const root = parseTsx(allContent).rootNode
  const decls = collectStateDecls(root)
  const called = new Set(collectLiteralCalls(root).map((c) => c.fn))
  return decls.filter((d) => called.has(d.setter))
}

/** Construit le graphe de navigation d'un projet (déterministe). */
export function buildGraph(files: ProjectFile[]): NavGraph {
  const all = files.map((f) => f.content).join('\n')
  const machines = findStateMachines(all)

  const acc = emptyPart()
  for (const f of files) {
    // JS/TS bien formé → AST (fiable). Parse cassé (fragment, vraie erreur de syntaxe)
    // ou langage non migré (.vue/.svelte/.html) → repli regex (comportement historique).
    let part: FilePart
    if (JS_EXT.test(f.path) && isFluxParserReady()) {
      const tree = parseTsx(f.content)
      part = tree.rootNode.hasError ? extractRegex(f, machines) : extractAst(f, tree.rootNode, machines)
    } else {
      part = extractRegex(f, machines)
    }
    acc.screensRendered.push(...part.screensRendered)
    acc.screenTargets.push(...part.screenTargets)
    acc.windowsRendered.push(...part.windowsRendered)
    acc.windowTargets.push(...part.windowTargets)
    acc.routesRenderedRaw.push(...part.routesRenderedRaw)
    acc.routeTargets.push(...part.routeTargets)
  }

  return {
    entries: uniq(machines.map((m) => m.init)),
    screensRendered: uniq(acc.screensRendered),
    screenTargets: acc.screenTargets,
    windowsRendered: uniq(acc.windowsRendered),
    windowTargets: acc.windowTargets,
    routesRendered: uniq(acc.routesRenderedRaw.filter((p) => p !== '*')),
    routeTargets: acc.routeTargets,
    hasCatchAllRoute: acc.routesRenderedRaw.includes('*'),
  }
}
