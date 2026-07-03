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
// Le repli regex ne se déclenche que si la STRUCTURE top-level est cassée (cf. topLevelBroken) :
// une erreur PROFONDE (un `&` brut dans du texte JSX, valide en React) garde l'AST.
//
// RÉSOLUTION DE CONSTANTES (#140-#3, bonus que seul l'AST permet) : depuis l'adoption
// `WINDOWS.*`/`SCREENS.*` (#140-#2), la nav s'écrit `win.type === WINDOWS.SUITE` et non
// plus `=== "suite"`. On construit donc une TABLE DES SYMBOLES (`OBJET.CLÉ → "valeur"`)
// depuis les `const X = Object.freeze({ KEY: "v" })` du projet, et on résout ces membres
// partout où on n'acceptait qu'un littéral. Sans ça, les 8 fenêtres du cockpit migrées
// vers `WINDOWS.*` devenaient de faux fantômes. La regex ne pourra JAMAIS faire ça.
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

/** Table des symboles de nav : `OBJET.CLÉ` → "valeur" (constantes d'écrans/fenêtres). */
type SymbolTable = Map<string, string>

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

/** La structure de PREMIER niveau est-elle cassée ? (un enfant direct de la racine est une
 * erreur). On replie alors sur le regex car l'AST n'est pas fiable. À l'inverse, une erreur
 * PROFONDE — typiquement un `&`/`<` brut dans du texte JSX, parfaitement valide en React mais
 * que la grammaire TSX flague — laisse l'AST fiable tout autour : on le garde. C'est plus fin
 * que `rootNode.hasError`, qui jetait un fichier réel entier pour une scorie cosmétique. */
function topLevelBroken(root: TSNode): boolean {
  return root.namedChildren.some((c: TSNode) => c.type === 'ERROR' || c.isMissing)
}

// ═══════════════════════════════════════════════════════════════════════════
// MOTEUR AST (tree-sitter) — fichiers JS/TS/JSX/TSX
// ═══════════════════════════════════════════════════════════════════════════

// Requêtes compilées une seule fois (après initFluxParser()).
type TSNode = any
type TSQuery = any
let Q: { decl: TSQuery; call: TSQuery; binary: TSQuery; jsxAttr: TSQuery; pair: TSQuery; constDecl: TSQuery } | null = null

function queries() {
  if (Q) return Q
  const L = tsxLanguage()
  Q = {
    // const [state, setter] = useState(...)  → on valide useState + 1er arg string en JS
    decl: L.query(`(variable_declarator
      name: (array_pattern (identifier) @state (identifier) @setter)
      value: (call_expression) @call)`),
    // tout appel — le nom de callee (identifiant nu OU propriété de membre, ex.
    // `a.onOpenWindow?.(…)`) et le 1er argument sont résolus en JS (cf. calleeName/firstArg).
    call: L.query(`(call_expression) @call`),
    // toute comparaison binaire (on filtre l'opérateur === en JS)
    binary: L.query(`(binary_expression) @bin`),
    // attribut JSX  name="literal"  (path=, to=)
    jsxAttr: L.query(`(jsx_attribute (property_identifier) @name (string (string_fragment) @val))`),
    // paire d'objet  key: "literal"  (path:)
    pair: L.query(`(pair key: (property_identifier) @k value: (string (string_fragment) @v))`),
    // const NAME = <value>  → pour la table des symboles (Object.freeze({...}), {...}, as const)
    constDecl: L.query(`(variable_declarator name: (identifier) @name value: (_) @val)`),
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

/** Nom appelé d'un `call_expression` : identifiant nu (`openWindow`) OU propriété finale
 * d'un membre (`a.onOpenWindow?.(…)` → "onOpenWindow", `props.setScreen(…)` → "setScreen").
 * Restaure la parité avec l'ancien regex `\b(?:setScreen|onOpenWindow)\(`. */
function calleeName(call: TSNode): string | null {
  const fn = call.childForFieldName('function')
  if (!fn) return null
  if (fn.type === 'identifier') return fn.text
  if (fn.type === 'member_expression') return fn.childForFieldName('property')?.text ?? null
  return null
}
/** Premier argument d'un appel (quel qu'en soit le type), ou null. */
function firstArg(call: TSNode): TSNode | null {
  return call.childForFieldName('arguments')?.namedChildren[0] ?? null
}

/** Résout un nœud en sa valeur chaîne : littéral `string` OU membre de constante connue
 *  (`WINDOWS.SUITE` → "suite" via la table des symboles). null si non résoluble. Le charset
 *  N'EST PAS filtré ici — c'est `ok()` au push des cibles qui tranche (équivalence historique). */
function resolve(node: TSNode | null, symbols: SymbolTable): string | null {
  if (!node) return null
  if (node.type === 'string') return stringValue(node)
  if (node.type === 'member_expression') {
    const obj = node.childForFieldName('object')
    const prop = node.childForFieldName('property')
    if (obj?.type === 'identifier' && prop) return symbols.get(`${obj.text}.${prop.text}`) ?? null
  }
  return null
}

/** Le nœud-objet derrière une valeur de `const` : `{...}` direct, `Object.freeze({...})`/
 *  `Object.assign({}, ...)`, ou `{...} as const` (TS). null sinon. */
function objectArg(node: TSNode | null): TSNode | null {
  if (!node) return null
  if (node.type === 'object') return node
  if (node.type === 'as_expression' || node.type === 'satisfies_expression') {
    return objectArg(node.namedChildren[0] ?? null)
  }
  if (node.type === 'call_expression') {
    const fn = node.childForFieldName('function')
    if (fn && /(?:^|\.)(freeze|assign)$/.test(fn.text)) {
      const args = node.childForFieldName('arguments')
      return args?.namedChildren.find((c: TSNode) => c.type === 'object') ?? null
    }
  }
  return null
}

/** Construit la table des symboles d'un arbre : `OBJET.CLÉ` → "valeur littérale". Couvre les
 *  objets gelés (`Object.freeze`), nus (`{...}`) et `as const`. Seules les valeurs string sont
 *  retenues (une nav cible toujours une chaîne). Permet de résoudre `WINDOWS.SUITE` (#140-#2). */
function collectConstants(root: TSNode): SymbolTable {
  const out: SymbolTable = new Map()
  for (const m of queries().constDecl.matches(root)) {
    const name = cap(m, 'name')?.text
    const obj = objectArg(cap(m, 'val'))
    if (!name || !obj) continue
    for (const pairNode of obj.namedChildren) {
      if (pairNode.type !== 'pair') continue
      const k = pairNode.childForFieldName('key')
      const v = stringValue(pairNode.childForFieldName('value'))
      if (k && typeof v === 'string') out.set(`${name}.${k.text}`, v)
    }
  }
  return out
}

/** Table des symboles GLOBALE fusionnée depuis plusieurs arbres (un par fichier) — remplace le
 *  parse d'un blob concaténé (#R1). Une constante `OBJET.CLÉ` définie dans un fichier et
 *  utilisée dans un autre reste résolue : on fusionne dans l'ordre des arbres, une définition
 *  plus tardive écrase la précédente pour une même clé (même effet net que la concaténation). */
function symbolsFromRoots(roots: TSNode[]): SymbolTable {
  const out: SymbolTable = new Map()
  for (const root of roots) for (const [k, v] of collectConstants(root)) out.set(k, v)
  return out
}

/** Déclarations `[state, setter] = useState("init" | CONST.X)` d'un arbre (avant filtre de rétention). */
function collectStateDecls(root: TSNode, symbols: SymbolTable): StateMachine[] {
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
    const init = resolve(args?.namedChildren[0] ?? null, symbols)
    if (!ok(init)) continue
    out.push({ state, setter, init })
  }
  return out
}

/** Couples (fonction, valeur-résolue) des appels `fn(<arg>)` d'un arbre. Le charset N'EST PAS
 * filtré ici : la rétention d'une machine ne dépend que de l'EXISTENCE d'un appel à valeur
 * connue (comme l'ancien `callRe`). L'arg peut être un littéral OU une constante (`SCREENS.X`).
 * Le filtre charset s'applique au push des cibles. */
function collectCalls(root: TSNode, symbols: SymbolTable): { fn: string; arg: string }[] {
  const out: { fn: string; arg: string }[] = []
  for (const m of queries().call.matches(root)) {
    const call = cap(m, 'call')
    if (!call) continue
    const fn = calleeName(call)
    const arg = resolve(firstArg(call), symbols)
    if (fn && typeof arg === 'string') out.push({ fn, arg })
  }
  return out
}

/** Extraction AST des contributions d'un fichier JS/TS (arbre déjà parsé). */
function extractAst(file: ProjectFile, root: TSNode, machines: StateMachine[], symbols: SymbolTable): FilePart {
  const part = emptyPart()
  const calls = collectCalls(root, symbols)

  // Écrans rendus (state === "x" / "x" === state) + fenêtres rendues (win.type === "x").
  for (const m of queries().binary.matches(root)) {
    const bin = cap(m, 'bin')
    if (!bin || bin.childForFieldName('operator')?.text !== '===') continue
    const left = bin.childForFieldName('left')
    const right = bin.childForFieldName('right')
    if (!left || !right) continue
    // window.type === "x" | WINDOWS.X
    if (left.type === 'member_expression') {
      const obj = left.childForFieldName('object')
      const prop = left.childForFieldName('property')
      if (obj && prop && (obj.text === 'win' || obj.text === 'window') && prop.text === 'type') {
        const v = resolve(right, symbols)
        if (ok(v)) part.windowsRendered.push(v)
      }
    }
    // stateVar === "x" | SCREENS.X (les deux sens)
    for (const { state } of machines) {
      if (left.type === 'identifier' && left.text === state) {
        const v = resolve(right, symbols)
        if (ok(v)) part.screensRendered.push(v)
      } else if (right.type === 'identifier' && right.text === state) {
        const v = resolve(left, symbols)
        if (ok(v)) part.screensRendered.push(v)
      }
    }
  }

  // Cibles d'écran : setX("x" | SCREENS.X) / onSetX(...).
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

  // Cibles de fenêtre : openWindow({ type: … }) / a.onOpenWindow?.({ type: … }).
  for (const m of queries().call.matches(root)) {
    const call = cap(m, 'call')
    if (!call) continue
    const fn = calleeName(call)
    if (fn !== 'openWindow' && fn !== 'onOpenWindow') continue
    const obj = firstArg(call)
    if (!obj || obj.type !== 'object') continue
    for (const pairNode of obj.namedChildren) {
      if (pairNode.type !== 'pair') continue
      const k = pairNode.childForFieldName('key')
      if (k?.text !== 'type') continue
      const v = resolve(pairNode.childForFieldName('value'), symbols)
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

/** Machines de nav agrégées depuis PLUSIEURS arbres (un par fichier) + la table des symboles
 *  GLOBALE : on ne retient que les états dont le SETTER est appelé (dans N'IMPORTE LEQUEL des
 *  arbres) avec une valeur connue (littéral OU constante). Remplace `machinesFromRoot` sur un
 *  blob concaténé (#R1) — un état déclaré dans un fichier et dont le setter n'est appelé que
 *  depuis d'autres fichiers (cf. le doublon ≥3 sources du test « R2 ») reste une vraie machine. */
function machinesFromRoots(roots: TSNode[], symbols: SymbolTable): StateMachine[] {
  const decls: StateMachine[] = []
  const called = new Set<string>()
  for (const root of roots) {
    decls.push(...collectStateDecls(root, symbols))
    for (const { fn } of collectCalls(root, symbols)) called.add(fn)
  }
  return decls.filter((d) => called.has(d.setter))
}

/** Repère `const [x, setX] = useState("init")` → { state, setter, init }, en ne retenant
 * que les états dont le SETTER est appelé avec une valeur connue (vraie machine de nav). */
export function findStateMachines(allContent: string): StateMachine[] {
  if (!isFluxParserReady()) return []
  const root = parseTsx(allContent).rootNode
  return machinesFromRoots([root], collectConstants(root))
}

/** Construit le graphe de navigation d'un projet (déterministe).
 *
 * #R1 : chaque fichier JS/TS n'est parsé QU'UNE FOIS (plus de blob concaténé re-parsé en
 * plus des fichiers individuels). L'arbre par fichier sert à la fois à la table des symboles
 * et aux machines à états GLOBALES (liens inter-fichiers — ex. `WINDOWS.*` défini dans nav.js
 * et consommé dans App.jsx/WindowManager.jsx) ET à l'extraction locale (screens/targets). */
export function buildGraph(files: ProjectFile[]): NavGraph {
  const ready = isFluxParserReady()

  // Un seul parse par fichier JS/TS, réutilisé pour tout ce qui suit. Indexé en parallèle de
  // `files` (pas par chemin) : deux entrées partageant le même `path` restent parsées et
  // extraites CHACUNE indépendamment, comme avant (pas de collision de clé).
  const roots: (TSNode | null)[] = ready
    ? files.map((f) => (JS_EXT.test(f.path) ? parseTsx(f.content).rootNode : null))
    : files.map(() => null)
  const allRoots = roots.filter((r): r is TSNode => r !== null)
  const symbols: SymbolTable = symbolsFromRoots(allRoots)
  const machines = machinesFromRoots(allRoots, symbols)

  const acc = emptyPart()
  files.forEach((f, i) => {
    // JS/TS dont la STRUCTURE top-level tient → AST (fiable, même avec une scorie JSX
    // profonde). Structure top-level cassée (fragment nu, vraie erreur de syntaxe) ou
    // langage non migré (.vue/.svelte/.html) → repli regex (comportement historique).
    const root = roots[i]
    const part: FilePart = root
      ? topLevelBroken(root)
        ? extractRegex(f, machines)
        : extractAst(f, root, machines, symbols)
      : extractRegex(f, machines)
    acc.screensRendered.push(...part.screensRendered)
    acc.screenTargets.push(...part.screenTargets)
    acc.windowsRendered.push(...part.windowsRendered)
    acc.windowTargets.push(...part.windowTargets)
    acc.routesRenderedRaw.push(...part.routesRenderedRaw)
    acc.routeTargets.push(...part.routeTargets)
  })

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
