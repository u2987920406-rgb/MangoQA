// Tests du module partagé fs-shared.ts (#R3).
// Déterministe, zéro réseau, zéro LLM, zéro disque réel (fs en mémoire injecté).
import { describe, it, expect } from 'vitest'
import { renderFiles, walkTree, type WalkEntry, type WalkFs } from '../../src/fs-shared.js'
import type { ProjectFile } from '../../src/types.js'

describe('fs-shared', () => {
  describe('renderFiles', () => {
    it('les deux fichiers présents, en-têtes avant contenu', () => {
      const files: ProjectFile[] = [
        { path: 'a.ts', content: 'const a = 1' },
        { path: 'b.ts', content: 'const b = 2' },
      ]
      const out = renderFiles(files, 10_000)
      expect(out.includes('a.ts') && out.includes('b.ts')).toBe(true)
      expect(out.indexOf('----- a.ts -----') < out.indexOf('const a = 1')).toBe(true)
    })

    it('parité avec l\'ancien llm.ts : cap 24 000, libellé "…(tronqué)…" (avec accent, défaut)', () => {
      const big: ProjectFile = { path: 'big.ts', content: 'x'.repeat(30_000) }
      const out = renderFiles([big], 24_000)
      expect(out.length).toBeLessThan(30_000)
      expect(out.includes('…(tronqué)…')).toBe(true)
    })

    it('parité avec l\'ancien flux-eye/deep.ts : cap 20 000, libellé "…(tronque)…" (sans accent)', () => {
      const big: ProjectFile = { path: 'big.ts', content: 'y'.repeat(25_000) }
      const out = renderFiles([big], 20_000, '…(tronque)…')
      expect(out.length).toBeLessThan(25_000)
      expect(out.includes('…(tronque)…')).toBe(true)
      expect(out.includes('…(tronqué)…')).toBe(false)
    })

    it('fichier trop gros pour laisser de la place (room <= 200) : entièrement sauté, pas de fichier suivant', () => {
      const files: ProjectFile[] = [
        { path: 'huge.ts', content: 'z'.repeat(50) },
        { path: 'next.ts', content: 'const n = 1' },
      ]
      const out = renderFiles(files, 10) // cap minuscule : le header seul dépasse déjà
      expect(out).toBe('')
    })
  })

  describe('walkTree', () => {
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

    it('parcours récursif, dossiers cachés/ignorés sautés, extension filtrée', () => {
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
      expect(rel.includes('a.ts') && rel.includes('sub/b.tsx')).toBe(true)
      expect(rel.includes('img.png')).toBe(false)
      expect(rel.length).toBe(2)
    })

    it('maxFiles borne le total', () => {
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
      expect(acc.length).toBe(2)
    })

    it('visit → undefined (ex. lecture échouée) ne consomme pas de place dans maxFiles — comportement historique de flux-eye/runner.ts (readAllSource) : un fichier illisible n\'entame pas le cap', () => {
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
      expect(acc.length).toBe(2)
      expect(acc.every(f => f.path.includes('ok'))).toBe(true)
    })

    it('dossier illisible : fail-open + tracé via onError, ne jette pas', () => {
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
      expect(acc.map(p => p.replace(/\\/g, '/')).includes('a.ts')).toBe(true)
      expect(errored).not.toBeNull()
    })
  })
})
