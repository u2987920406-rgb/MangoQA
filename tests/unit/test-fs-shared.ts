// Tests du module partagé fs-shared.ts (#R3).
// Déterministe, zéro réseau, zéro LLM, zéro disque réel (fs en mémoire injecté).
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  renderFiles,
  renderFilesWithCoverage,
  walkTree,
  atomicWriteFileSync,
  type WalkEntry,
  type WalkFs,
} from '../../src/fs-shared.js'
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

  // ── Couverture de rendu (J1 défaut n°2 — l'audit partiel silencieux) ────────
  // Ce que le modèle a réellement vu doit être MESURÉ ici, sinon plus rien en aval
  // ne peut le déclarer. Le texte rendu, lui, doit rester byte-identique.
  describe('renderFilesWithCoverage', () => {
    it("tout tient sous le cap → complete, rien d'omis ni de coupé", () => {
      const files: ProjectFile[] = [
        { path: 'a.ts', content: 'const a = 1' },
        { path: 'b.ts', content: 'const b = 2' },
      ]
      const { coverage } = renderFilesWithCoverage(files, 10_000)
      expect(coverage.complete).toBe(true)
      expect(coverage.filesRendered).toBe(2)
      expect(coverage.filesTotal).toBe(2)
      expect(coverage.omitted).toEqual([])
      expect(coverage.charsRendered).toBe(coverage.charsTotal)
    })

    it('le cap abandonne les fichiers suivants : ils sont COMPTÉS ET NOMMÉS, pas perdus', () => {
      // 3 fichiers de 1 000 car., cap 1 500 : le 1er passe, le 2e est coupé, le 3e saute.
      const files: ProjectFile[] = [
        { path: 'un.ts', content: 'x'.repeat(1_000) },
        { path: 'deux.ts', content: 'y'.repeat(1_000) },
        { path: 'trois.ts', content: 'z'.repeat(1_000) },
      ]
      const { coverage } = renderFilesWithCoverage(files, 1_500)
      expect(coverage.complete).toBe(false)
      expect(coverage.filesTotal).toBe(3)
      expect(coverage.truncated).toEqual(['deux.ts'])
      expect(coverage.omitted).toEqual(['trois.ts'])
      expect(coverage.charsRendered).toBeLessThan(coverage.charsTotal)
    })

    it('cap minuscule : le fichier absent du payload est déclaré OMIS, jamais rendu', () => {
      const files: ProjectFile[] = [
        { path: 'huge.ts', content: 'z'.repeat(50) },
        { path: 'next.ts', content: 'const n = 1' },
      ]
      const { text, coverage } = renderFilesWithCoverage(files, 10)
      expect(text).toBe('')
      expect(coverage.filesRendered).toBe(0)
      expect(coverage.omitted).toEqual(['huge.ts', 'next.ts'])
      expect(coverage.complete).toBe(false)
    })

    it('fichier DÉJÀ coupé en amont (MAX_FILE_CHARS) : jamais "complete", et le vrai total sert de dénominateur', () => {
      const files: ProjectFile[] = [{ path: 'gros.ts', content: 'x'.repeat(100), truncated: true, fullChars: 50_000 }]
      const { coverage } = renderFilesWithCoverage(files, 10_000)
      // Tout ce qu'on nous a donné tient dans le prompt — mais ce n'est pas tout le fichier.
      expect(coverage.filesRendered).toBe(1)
      expect(coverage.sourceTruncated).toEqual(['gros.ts'])
      expect(coverage.complete).toBe(false)
      expect(coverage.charsTotal).toBe(50_000)
      expect(coverage.charsRendered).toBe(100)
    })

    it("un fichier JAMAIS envoyé n'est pas déclaré « fourni mais coupé » — omis, point", () => {
      const files: ProjectFile[] = [
        { path: 'un.ts', content: 'x'.repeat(1_400) },
        // Coupé au disque ET hors cap : il est ABSENT du prompt, pas amputé dedans.
        { path: 'deux.ts', content: 'y'.repeat(1_000), truncated: true, fullChars: 40_000 },
      ]
      const { coverage } = renderFilesWithCoverage(files, 1_450)
      expect(coverage.omitted).toEqual(['deux.ts'])
      expect(coverage.sourceTruncated).toEqual([])
      expect(coverage.complete).toBe(false)
    })

    it('le TEXTE rendu est identique à renderFiles (extraction, pas changement de comportement)', () => {
      const files: ProjectFile[] = [
        { path: 'a.ts', content: 'x'.repeat(1_000) },
        { path: 'b.ts', content: 'y'.repeat(1_000) },
        { path: 'c.ts', content: 'z'.repeat(1_000) },
      ]
      for (const cap of [10, 500, 1_500, 2_400, 10_000]) {
        expect(renderFilesWithCoverage(files, cap).text).toBe(renderFiles(files, cap))
      }
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

  // atomicWriteFileSync fait de la VRAIE I/O (rename atomique) — contrairement au reste
  // du fichier (fs en mémoire), on teste sur un dossier temp réel, nettoyé après.
  describe('atomicWriteFileSync', () => {
    it('écrit le contenu final correct et ne laisse aucun fichier .tmp derrière', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mangoqa-atomic-'))
      try {
        const target = path.join(dir, 'obs.json')
        atomicWriteFileSync(target, '{"a":1}')
        expect(fs.readFileSync(target, 'utf8')).toBe('{"a":1}')
        // Aucun résidu .tmp-* (le rename a bien consommé le temporaire).
        expect(fs.readdirSync(dir).filter(n => n.includes('.tmp'))).toEqual([])
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('écrase proprement un fichier existant (2 écritures successives)', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mangoqa-atomic-'))
      try {
        const target = path.join(dir, 'obs.json')
        atomicWriteFileSync(target, 'premier')
        atomicWriteFileSync(target, 'second')
        expect(fs.readFileSync(target, 'utf8')).toBe('second')
        expect(fs.readdirSync(dir)).toEqual(['obs.json'])
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})
