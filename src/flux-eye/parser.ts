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
// (2026-08-05, J3 packaging) Import de TYPE seulement — effacé à la compilation, donc
// zéro dépendance au runtime. Le vrai chargement est DYNAMIQUE, plus bas.
//
// Motif : `web-tree-sitter` + `tree-sitter-wasms` pèsent 50 Mo, et sont désormais des
// dépendances de pair OPTIONNELLES (non installées par défaut). Un utilisateur qui
// installe la CLI pour auditer un dossier n'a aucune raison de les payer — l'Auditeur
// de Flux ne sert que le chemin MangoOS. Un import statique aurait fait échouer le
// chargement du module entier chez lui, au lieu de désactiver la seule fonctionnalité
// concernée.
import type Parser from 'web-tree-sitter'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

let tsx: Parser.Language | null = null
let parser: Parser | null = null
let initPromise: Promise<void> | null = null

function estModuleAbsent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND'
}

/** Pré-charge le runtime WASM + la grammaire TSX + un parser réutilisable. Idempotent
 *  (promesse mise en cache) : rappeler est instantané. À appeler à chaque point d'entrée.
 *
 *  Si `web-tree-sitter`/`tree-sitter-wasms` ne sont pas installés, l'Auditeur de Flux se
 *  DÉSACTIVE proprement : `isFluxParserReady()` reste faux et `graph.ts` retombe sur ses
 *  heuristiques regex — le repli qui existait déjà pour .vue/.svelte/.html. Fail-open,
 *  mais JAMAIS silencieux (#Q3) : l'absence est tracée une fois.
 *
 *  Toute AUTRE erreur est relancée : un moteur AST installé qui refuse de démarrer est
 *  un vrai problème, et l'appelant (orchestrator.ts) est déjà fail-open autour. */
export function initFluxParser(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      let P: typeof Parser
      try {
        const mod = (await import('web-tree-sitter')) as unknown as { default?: typeof Parser }
        P = (mod.default ?? (mod as unknown as typeof Parser))
      } catch (err) {
        if (!estModuleAbsent(err)) throw err
        console.warn(
          "[mango-qa] flux-eye : web-tree-sitter absent — Auditeur de Flux désactivé (repli regex). " +
            "Pour l'activer : npm i web-tree-sitter tree-sitter-wasms",
        )
        return
      }
      await P.init()
      const wasm = require.resolve('tree-sitter-wasms/out/tree-sitter-tsx.wasm')
      tsx = await P.Language.load(wasm)
      parser = new P()
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
