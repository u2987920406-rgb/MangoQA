// Lot 1 (ADR-001) — portée sur le diff. Testé contre un VRAI dépôt git temporaire :
// une intégration git ne se vérifie pas avec un simulacre, elle se vérifie avec git.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fichiersModifies, ErreurGit } from '../../src/git.js'

let depot: string
const git = (args: string[], cwd = depot): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const ecrire = (rel: string, contenu = '// code\n'): void => {
  const abs = path.join(depot, rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, contenu)
}

beforeAll(() => {
  depot = mkdtempSync(path.join(tmpdir(), 'mangoqa-git-'))
  git(['init', '-q', '-b', 'principale'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test'])
  ecrire('src/socle.ts')
  ecrire('.gitignore', 'node_modules/\n')
  git(['add', '-A'])
  git(['commit', '-qm', 'socle'])
})

afterAll(() => {
  rmSync(depot, { recursive: true, force: true })
})

describe('fichiersModifies — sans référence (travail non commité)', () => {
  it('un dépôt propre ne rend aucun fichier', () => {
    expect(fichiersModifies(depot)).toEqual([])
  })

  it('voit une modification non commitée', () => {
    ecrire('src/socle.ts', '// modifié\n')
    expect(fichiersModifies(depot)).toEqual(['src/socle.ts'])
    git(['checkout', '--', 'src/socle.ts'])
  })

  it('voit un fichier NEUF non suivi — c\'est celui qu\'on veut faire relire en priorité', () => {
    ecrire('src/nouveau.tsx')
    expect(fichiersModifies(depot)).toContain('src/nouveau.tsx')
    rmSync(path.join(depot, 'src/nouveau.tsx'))
  })

  it('respecte .gitignore et écarte les dossiers ignorés', () => {
    ecrire('node_modules/paquet/index.js')
    expect(fichiersModifies(depot)).toEqual([])
    rmSync(path.join(depot, 'node_modules'), { recursive: true, force: true })
  })

  it('écarte les fichiers non-source — on ne paie pas de jetons pour un .md', () => {
    ecrire('NOTES.md', '# notes\n')
    ecrire('logo.png', 'binaire')
    expect(fichiersModifies(depot)).toEqual([])
    rmSync(path.join(depot, 'NOTES.md'))
    rmSync(path.join(depot, 'logo.png'))
  })
})

describe('fichiersModifies — avec référence (divergence depuis un point)', () => {
  beforeAll(() => {
    git(['checkout', '-qb', 'travaux'])
    ecrire('src/ajoute.ts')
    ecrire('src/socle.ts', '// touché sur la branche\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'travaux'])
  })

  it('rend les fichiers divergents depuis la branche de base', () => {
    expect(fichiersModifies(depot, 'principale').sort()).toEqual(['src/ajoute.ts', 'src/socle.ts'])
  })

  it('accepte aussi une étiquette et un identifiant de commit', () => {
    git(['tag', 'jalon-1', 'principale'])
    const sha = git(['rev-parse', 'principale']).trim()
    expect(fichiersModifies(depot, 'jalon-1').sort()).toEqual(['src/ajoute.ts', 'src/socle.ts'])
    expect(fichiersModifies(depot, sha).sort()).toEqual(['src/ajoute.ts', 'src/socle.ts'])
  })

  it('exclut les SUPPRESSIONS — sinon elles compteraient comme « jamais lues » et feraient paraître la couverture incomplète', () => {
    rmSync(path.join(depot, 'src/socle.ts'))
    git(['add', '-A'])
    git(['commit', '-qm', 'suppression'])
    const liste = fichiersModifies(depot, 'principale')
    expect(liste).toContain('src/ajoute.ts')
    expect(liste).not.toContain('src/socle.ts')
  })
})

describe('fichiersModifies — sous-dossier et erreurs', () => {
  it('rend des chemins relatifs au DOSSIER AUDITÉ, pas à la racine du dépôt', () => {
    const sousDossier = path.join(depot, 'src')
    // `src/ajoute.ts` vu depuis `src/` doit être `ajoute.ts`.
    expect(fichiersModifies(sousDossier, 'principale')).toEqual(['ajoute.ts'])
  })

  it('référence inconnue : erreur d\'USAGE lisible, pas un message de git sur les plages', () => {
    expect(() => fichiersModifies(depot, 'nexiste-pas')).toThrow(ErreurGit)
    expect(() => fichiersModifies(depot, 'nexiste-pas')).toThrow(/Référence git inconnue/)
  })

  it('hors dépôt git : erreur d\'usage explicite', () => {
    const horsDepot = mkdtempSync(path.join(tmpdir(), 'mangoqa-nogit-'))
    try {
      expect(() => fichiersModifies(horsDepot)).toThrow(ErreurGit)
    } finally {
      rmSync(horsDepot, { recursive: true, force: true })
    }
  })
})
