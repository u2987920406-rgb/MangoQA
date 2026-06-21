// Mango QA — Auditeur de Flux : moteur de parsing tree-sitter (web-tree-sitter, WASM).
//
// Remplace les heuristiques regex de graph.ts par un VRAI arbre syntaxique. Le
// chargement du runtime WASM + de la grammaire est ASYNC (une fois), mais `parse()`
// est ensuite SYNCHRONE : on pré-charge via `initFluxParser()` au point d'entrée,
// ce qui laisse `buildGraph()` synchrone (contrat inchangé en aval). Combo épinglé :
// web-tree-sitter 0.24 (ancien loader) + tree-sitter-wasms (grammaires pré-compilées).
//
// La grammaire TSX est un sur-ensemble (TypeScript + JSX) : elle parse .ts/.tsx/.js/.jsx
// sans broncher. Les autres langages (.vue/.svelte/.html) ne sont pas encore migrés vers
// l'AST — `buildGraph` leur applique un repli (voir graph.ts).
import Parser from 'web-tree-sitter'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

let tsx: Parser.Language | null = null
let parser: Parser | null = null
let initPromise: Promise<void> | null = null

/** Pré-charge le runtime WASM + la grammaire TSX + un parser réutilisable. Idempotent
 *  (promesse mise en cache) : rappeler est instantané. À appeler à chaque point d'entrée. */
export function initFluxParser(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      await Parser.init()
      const wasm = require.resolve('tree-sitter-wasms/out/tree-sitter-tsx.wasm')
      tsx = await Parser.Language.load(wasm)
      parser = new Parser()
      parser.setLanguage(tsx)
    })()
  }
  return initPromise
}

/** Le parser est-il prêt ? (pour un repli défensif côté graph.ts). */
export function isFluxParserReady(): boolean {
  return tsx !== null && parser !== null
}

/** Parse du code TSX/TS/JS/JSX en un arbre. Synchrone — exige `initFluxParser()` au préalable.
 *  Réutilise UN parser singleton (pas de fuite WASM ni de crash de cleanup). */
export function parseTsx(code: string): Parser.Tree {
  if (!parser) throw new Error('initFluxParser() doit être appelé avant parseTsx()')
  return parser.parse(code)
}

/** La grammaire TSX chargée (pour compiler des requêtes). Exige l'init. */
export function tsxLanguage(): Parser.Language {
  if (!tsx) throw new Error('initFluxParser() doit être appelé avant tsxLanguage()')
  return tsx
}
