// Tests du filet de secours du watcher (#Q-fallback).
// Déterministe, zéro disque réel (fs injecté, même fake que test-orchestrator.ts).
import { describe, it, expect } from 'vitest'
import type { FsLike } from '../../src/orchestrator.js'
import { scanForSignals, filterChangedSignals, initFallbackScanState } from '../../src/watch-fallback.js'

const norm = (p: string): string => p.replace(/\\/g, '/')

function makeFakeFs(initialFiles: Record<string, string>, dirs: string[] = []): FsLike {
  const files = new Map(Object.entries(initialFiles).map(([k, v]) => [norm(k), v]))
  const dirSet = new Set(dirs.map(norm))
  return {
    existsSync: p => files.has(norm(p)) || dirSet.has(norm(p)),
    readFileSync: p => {
      const v = files.get(norm(p))
      if (v === undefined) throw new Error(`ENOENT: ${p}`)
      return v
    },
    writeFileSync: (p, data) => { files.set(norm(p), data) },
    mkdirSync: p => { dirSet.add(norm(p)) },
    readdirSync: p => {
      const base = norm(p)
      const seen = new Map<string, boolean>()
      const consider = (full: string) => {
        if (!full.startsWith(base + '/')) return
        const rest = full.slice(base.length + 1)
        const name = rest.split('/')[0]
        const isDir = rest.includes('/')
        if (!seen.has(name) || isDir) seen.set(name, seen.get(name) || isDir)
      }
      for (const f of files.keys()) consider(f)
      for (const d of dirSet) consider(d)
      return [...seen.entries()].map(([name, isDir]) => ({ name, isDirectory: () => isDir }))
    },
    // Reflète le VRAI comportement de realFs.isFile (`fs.statSync(p).isFile()`,
    // orchestrator.ts) : lève ENOENT sur un chemin absent, ne renvoie PAS false.
    // Un fake plus laxiste ici aurait laissé passer un vrai bug (cf. commit du
    // 2026-07-19 : scanForSignals appelait isFile() sans existsSync() d'abord —
    // crash en prod au 1er scan sur un projet sans signal, cas normal/fréquent).
    isFile: p => {
      if (!files.has(norm(p))) throw new Error(`ENOENT: ${p}`)
      return true
    },
  }
}

describe('watch-fallback', () => {
  it('workspace absent : liste vide, jamais d\'erreur', () => {
    const fsx = makeFakeFs({})
    expect(scanForSignals('/ws', fsx)).toEqual([])
  })

  it('workspace vide : liste vide', () => {
    const fsx = makeFakeFs({}, ['/ws'])
    expect(scanForSignals('/ws', fsx)).toEqual([])
  })

  it('un projet avec signal présent : trouvé', () => {
    const fsx = makeFakeFs({ '/ws/proj-a/.mangoqa/phase-complete.json': '{}' }, ['/ws', '/ws/proj-a'])
    const found = scanForSignals('/ws', fsx).map(norm)
    expect(found).toEqual(['/ws/proj-a/.mangoqa/phase-complete.json'])
  })

  it('plusieurs projets, certains sans signal : seuls ceux avec signal sont retenus', () => {
    const fsx = makeFakeFs(
      {
        '/ws/proj-a/.mangoqa/phase-complete.json': '{}',
        '/ws/proj-c/.mangoqa/phase-complete.json': '{}',
      },
      ['/ws', '/ws/proj-a', '/ws/proj-b', '/ws/proj-c'],
    )
    const found = scanForSignals('/ws', fsx).map(norm).sort()
    expect(found).toEqual(['/ws/proj-a/.mangoqa/phase-complete.json', '/ws/proj-c/.mangoqa/phase-complete.json'])
  })

  it('un fichier au niveau workspace (pas un dossier projet) : ignoré', () => {
    const fsx = makeFakeFs({ '/ws/readme.txt': 'x' }, ['/ws'])
    expect(scanForSignals('/ws', fsx)).toEqual([])
  })

  it('readdirSync qui lève : liste vide, jamais d\'exception (best-effort)', () => {
    const fsx: FsLike = {
      ...makeFakeFs({}, ['/ws']),
      readdirSync: () => { throw new Error('EACCES (simulé)') },
    }
    expect(() => scanForSignals('/ws', fsx)).not.toThrow()
    expect(scanForSignals('/ws', fsx)).toEqual([])
  })

  describe('filterChangedSignals (ignoreInitial)', () => {
    it('bug reproduit puis corrige : au 1er scan, des signaux DEJA PRESENTS ne sont jamais retenus', () => {
      const state = initFallbackScanState()
      const mtimes = { '/ws/proj-a/.mangoqa/phase-complete.json': 1000, '/ws/proj-b/.mangoqa/phase-complete.json': 2000 }
      const getMtimeMs = (p: string) => mtimes[p as keyof typeof mtimes] ?? null
      const out = filterChangedSignals(Object.keys(mtimes), getMtimeMs, state)
      expect(out).toEqual([]) // baseline au boot : jamais traite (== ignoreInitial de chokidar)
    })

    it('un signal inchange au 2e scan : toujours pas retenu', () => {
      const state = initFallbackScanState()
      const p = '/ws/proj-a/.mangoqa/phase-complete.json'
      const getMtimeMs = () => 1000
      filterChangedSignals([p], getMtimeMs, state) // 1er scan (baseline)
      state.firstScan = false // simule le passage du 1er au 2e tick (fait par l'appelant)
      const out = filterChangedSignals([p], getMtimeMs, state)
      expect(out).toEqual([]) // meme mtime -> rien de nouveau
    })

    it('un signal REELLEMENT reecrit (mtime change) apres la baseline : retenu', () => {
      const state = initFallbackScanState()
      const p = '/ws/proj-a/.mangoqa/phase-complete.json'
      filterChangedSignals([p], () => 1000, state) // baseline
      state.firstScan = false
      const out = filterChangedSignals([p], () => 2000, state) // reecrit -> nouveau mtime
      expect(out).toEqual([p])
    })

    it('un TOUT NOUVEAU projet apparu apres le boot (pas dans la baseline) : retenu des sa 1ere apparition post-boot', () => {
      const state = initFallbackScanState()
      filterChangedSignals([], () => null, state) // baseline vide (aucun projet au boot)
      state.firstScan = false
      const p = '/ws/proj-neuf/.mangoqa/phase-complete.json'
      const out = filterChangedSignals([p], () => 5000, state)
      expect(out).toEqual([p]) // jamais vu -> prev=undefined != mtime -> traite
    })

    it('getMtimeMs qui renvoie null (fichier disparu entre scanForSignals et le stat) : ignore proprement', () => {
      const state = initFallbackScanState()
      const p = '/ws/proj-a/.mangoqa/phase-complete.json'
      state.firstScan = false
      const out = filterChangedSignals([p], () => null, state)
      expect(out).toEqual([])
    })
  })
})
