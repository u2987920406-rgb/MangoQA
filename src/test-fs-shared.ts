// Tests du module partagé fs-shared.ts (#R3). Exécution : npx tsx src/test-fs-shared.ts
// Déterministe, zéro réseau, zéro LLM, zéro disque réel (fs en mémoire injecté).
import { renderFiles, walkTree, type WalkEntry, type WalkFs } from './fs-shared.js'
import type { ProjectFile } from './types.js'

let passed = 0
let failed = 0
function check(name: string, cond: boolean): void {
  if (cond) passed++
  else {
    failed++
    console.error(`  ❌ ${name}`)
  }
}

// ── renderFiles ───────────────────────────────────────────────────────────────

{
  const files: ProjectFile[] = [
    { path: 'a.ts', content: 'const a = 1' },
    { path: 'b.ts', content: 'const b = 2' },
  ]
  const out = renderFiles(files, 10_000)
  check('renderFiles : les deux fichiers présents', out.includes('a.ts') && out.includes('b.ts'))
  check('renderFiles : en-têtes avant contenu', out.indexOf('----- a.ts -----') < out.indexOf('const a = 1'))
}

// Parité avec l'ancien llm.ts : cap 24 000, libellé "…(tronqué)…" (avec accent, défaut).
{
  const big: ProjectFile = { path: 'big.ts', content: 'x'.repeat(30_000) }
  const out = renderFiles([big], 24_000)
  check('renderFiles (llm.ts) : tronqué au cap', out.length < 30_000)
  check('renderFiles (llm.ts) : libellé accentué par défaut', out.includes('…(tronqué)…'))
}

// Parité avec l'ancien flux-eye/deep.ts : cap 20 000, libellé "…(tronque)…" (sans accent).
{
  const big: ProjectFile = { path: 'big.ts', content: 'y'.repeat(25_000) }
  const out = renderFiles([big], 20_000, '…(tronque)…')
  check('renderFiles (deep.ts) : tronqué au cap 20000', out.length < 25_000)
  check('renderFiles (deep.ts) : libellé SANS accent (comportement historique)', out.includes('…(tronque)…'))
  check('renderFiles (deep.ts) : pas le libellé accentué de llm.ts', !out.includes('…(tronqué)…'))
}

// Fichier trop gros pour laisser de la place (room <= 200) : entièrement sauté, pas de fichier suivant.
{
  const files: ProjectFile[] = [
    { path: 'huge.ts', content: 'z'.repeat(50) },
    { path: 'next.ts', content: 'const n = 1' },
  ]
  const out = renderFiles(files, 10) // cap minuscule : le header seul dépasse déjà
  check('renderFiles : cap minuscule → sortie vide (rien ne tient)', out === '')
}

// ── walkTree : arborescence en mémoire ───────────────────────────────────────

interface Node {
  name: string
  dir: boolean
}
// path.join()/path.relative() produisent des séparateurs natifs (backslash sous Windows) —
// on normalise les clés en '/' pour que l'arborescence en mémoire reste portable (même
// technique que test-orchestrator.ts).
const norm = (p: string): string => p.replace(/\\/g, '/')
function makeFsx(tree: Record<string, Node[]>, unreadableDirs: Set<string> = new Set()): WalkFs {
  return {
    readdirSync(dir: string): WalkEntry[] {
      const d = norm(dir)
      if (unreadableDirs.has(d)) throw new Error(`EACCES: ${d}`)
      return (tree[d] ?? []).map(n => ({ name: n.name, isDirectory: () => n.dir }))
    },
  }
}

// Parcours récursif, dossiers cachés/ignorés sautés, extension filtrée.
{
  const tree: Record<string, Node[]> = {
    '/p': [
      { name: 'a.ts', dir: false },
      { name: 'node_modules', dir: true },
      { name: '.git', dir: true },
      { name: 'sub', dir: true },
      { name: 'img.png', dir: false },
    ],
    '/p/sub': [{ name: 'b.tsx', dir: false }],
  }
  const acc: string[] = []
  walkTree<string>('/p', '/p', acc, {
    skipDirs: new Set(['node_modules']),
    extRe: /\.(ts|tsx)$/,
    maxFiles: 100,
    fsx: makeFsx(tree),
    visit: (_full, rel) => rel,
  })
  const rel = acc.map(p => p.replace(/\\/g, '/'))
  check('walkTree : fichiers trouvés (récursif)', rel.includes('a.ts') && rel.includes('sub/b.tsx'))
  check('walkTree : extension hors filtre ignorée', !rel.includes('img.png'))
  check('walkTree : dossier skipDirs + dossier caché (.git) sautés', rel.length === 2)
}

// maxFiles borne le total.
{
  const tree: Record<string, Node[]> = {
    '/p': [
      { name: 'a.ts', dir: false },
      { name: 'b.ts', dir: false },
      { name: 'c.ts', dir: false },
    ],
  }
  const acc: string[] = []
  walkTree<string>('/p', '/p', acc, {
    skipDirs: new Set(),
    extRe: /\.ts$/,
    maxFiles: 2,
    fsx: makeFsx(tree),
    visit: (_full, rel) => rel,
  })
  check('walkTree : maxFiles respecté', acc.length === 2)
}

// visit → undefined (ex. lecture échouée) ne consomme PAS de place dans maxFiles — comportement
// historique de flux-eye/runner.ts (readAllSource) : un fichier illisible n'entame pas le cap.
{
  const tree: Record<string, Node[]> = {
    '/p': [
      { name: 'ok1.ts', dir: false },
      { name: 'bad.ts', dir: false },
      { name: 'ok2.ts', dir: false },
    ],
  }
  const acc: { path: string }[] = []
  walkTree<{ path: string }>('/p', '/p', acc, {
    skipDirs: new Set(),
    extRe: /\.ts$/,
    maxFiles: 2,
    fsx: makeFsx(tree),
    visit: (_full, rel) => (rel.includes('bad') ? undefined : { path: rel }),
  })
  check('walkTree : visit→undefined ignoré sans compter dans maxFiles', acc.length === 2)
  check('walkTree : les 2 fichiers lisibles sont bien ok1/ok2', acc.every(f => f.path.includes('ok')))
}

// Dossier illisible : fail-open + tracé via onError, ne jette pas.
{
  const tree: Record<string, Node[]> = {
    '/p': [
      { name: 'sub', dir: true },
      { name: 'a.ts', dir: false },
    ],
  }
  const acc: string[] = []
  let errored: unknown = null
  walkTree<string>('/p', '/p', acc, {
    skipDirs: new Set(),
    extRe: /\.ts$/,
    maxFiles: 100,
    fsx: makeFsx(tree, new Set(['/p/sub'])),
    visit: (_full, rel) => rel,
    onError: err => { errored = err },
  })
  check('walkTree : dossier illisible n\'interrompt pas le parcours', acc.map(p => p.replace(/\\/g, '/')).includes('a.ts'))
  check('walkTree : erreur tracée via onError (fail-open, pas silencieux — #Q3)', errored !== null)
}

console.log(`\n${failed === 0 ? '✅' : '❌'} fs-shared : ${passed}/${passed + failed} passed`)
if (failed > 0) process.exit(1)
