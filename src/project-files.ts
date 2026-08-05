// Mango QA — LECTURE BORNÉE des fichiers d'un projet.
//
// (2026-08-05, J3) Extrait de `orchestrator.ts`, sans un caractère de changement de
// comportement. Motif : PACKAGING de la CLI.
//
// `auditProject()` n'a besoin que de trois choses d'ici — `readProjectFiles`,
// `projectHasTests`, `realFs`. Mais en les important depuis `orchestrator.ts`, la CLI
// tirait TOUTE la chaîne des visages : design-eye, suite-eye, retex, et surtout
// flux-eye/parser → `web-tree-sitter` + `tree-sitter-wasms`, soit **50 Mo de WASM**
// installés et chargés pour parcourir un dossier. Un utilisateur qui fait
// `npm i -g mangoqa` n'a aucune raison de payer ça.
//
// `orchestrator.ts` ré-exporte tout ce module : aucun appelant existant ne change.
import fs from 'node:fs'
import path from 'node:path'
import type { ProjectFile } from './types.js'
import { walkTree } from './fs-shared.js'
import { sortByPriority } from './priority.js'

export const MAX_FILES = 40
export const MAX_FILE_CHARS = 16_000
export const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.mangoqa', '.snapshots', '.diffs'])
// #10 — cap de DÉCOUVERTE (chemins seuls, pas de contenu lu) distinct de MAX_FILES
// (sélection finale). On découvre large puis on trie par `priorityScore` avant de
// ne garder que les MAX_FILES élus — sans ce cap plus haut, walkTree s'arrêterait
// dès les 40 premiers fichiers rencontrés sur le disque (ordre alphabétique/inode),
// ce qui rend tout tri a posteriori inutile (rien à trier au-delà du 40ᵉ).
export const DISCOVERY_CAP = 500
// Fichiers de test — utilisé pour éviter un Feu Rouge fantôme sur la branche
// Tests quand les fichiers *.test.*/*.spec.* existent dans le projet mais sont
// hors du delta `changedFiles` de cette phase (cf. #10, constat "Tests").
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx)$/

// ── Système de fichiers injectable (surface minimale, testable sans disque) ──
export interface DirentLike {
  name: string
  isDirectory(): boolean
}

export interface FsLike {
  existsSync(p: string): boolean
  readFileSync(p: string): string
  writeFileSync(p: string, data: string): void
  mkdirSync(p: string): void
  readdirSync(p: string): DirentLike[]
  isFile(p: string): boolean
}

/** Implémentation réelle (node:fs) — le défaut hors tests. */
export const realFs: FsLike = {
  existsSync: p => fs.existsSync(p),
  readFileSync: p => fs.readFileSync(p, 'utf8'),
  writeFileSync: (p, data) => {
    // Atomic write: tmp+rename protects against mid-write crashes corrupting critical data
    const tmp = `${p}.tmp`
    fs.writeFileSync(tmp, data, 'utf8')
    try {
      fs.renameSync(tmp, p)
    } catch {
      // Windows may refuse rename if target is briefly held open (antivirus, editor)
      try {
        fs.writeFileSync(p, data, 'utf8')
      } finally {
        fs.rmSync(tmp, { force: true })
      }
    }
  },
  mkdirSync: p => fs.mkdirSync(p, { recursive: true }),
  readdirSync: p => fs.readdirSync(p, { withFileTypes: true }),
  isFile: p => fs.statSync(p).isFile(),
}

// ── Lecture bornée des fichiers livrés ───────────────────────────────────────
const SRC_EXT = /\.(ts|tsx|js|jsx|css|html|json)$/

/** Ce chemin désigne-t-il un fichier que les branches savent auditer ?
 *
 *  Exporté pour que `--diff` (git.ts) applique EXACTEMENT le même filtre que le
 *  parcours disque. Deux définitions de « fichier source » qui divergeraient
 *  donneraient deux périmètres différents selon le mode — et une couverture
 *  déclarée sur un périmètre variable ne veut plus rien dire.
 *
 *  Écarte aussi les chemins traversant un dossier ignoré (`node_modules`, `dist`…),
 *  qu'un diff peut parfaitement contenir. */
export function estFichierSource(relPath: string): boolean {
  const segments = relPath.split(/[\\/]/)
  if (segments.some(seg => SKIP_DIRS.has(seg))) return false
  return SRC_EXT.test(relPath)
}

/** Parcours récursif borné, chemins seuls (contenu lu séparément par `readProjectFiles`).
 *  Implémenté via le `walkTree` partagé (#R3) — comportement inchangé. */
export function walkSrc(dir: string, base: string, acc: string[], fsx: FsLike = realFs): void {
  walkTree<string>(dir, base, acc, {
    skipDirs: SKIP_DIRS,
    extRe: SRC_EXT,
    maxFiles: DISCOVERY_CAP,
    fsx,
    visit: (_full, rel) => rel,
    onError: err => console.warn('[mango-qa] orchestrateur:', (err as Error)?.message ?? err),
  })
}

/** Sonde de couverture de LECTURE, remplie par `readProjectFiles` si on la lui passe
 *  (J1 défaut n°2). Deuxième étage de perte, avant même le cap de prompt : le projet
 *  peut avoir plus de `MAX_FILES` fichiers, et les non-élus disparaissaient sans trace.
 *  Paramètre optionnel = zéro impact sur les appelants existants. */
export interface ReadStats {
  /** Candidats découverts (après filtre d'extension/dossiers, avant la coupe MAX_FILES). */
  discovered: number
  /** Fichiers réellement lus et transmis aux branches. */
  read: number
  /** Chemins découverts mais jamais lus (coupés par MAX_FILES, ou illisibles). */
  dropped: string[]
}

/** #10 — la troncature à MAX_FILES n'est plus "premier arrivé, premier servi" :
 *  on trie d'abord TOUS les candidats découverts (jusqu'à DISCOVERY_CAP) par
 *  `priorityScore` (points d'entrée HTTP, auth, secrets/config, bootstrap serveur
 *  en tête), puis on ne lit le contenu que des MAX_FILES élus. S'applique aussi
 *  au delta `changedFiles` quand il dépasse MAX_FILES. */
export function readProjectFiles(
  projDir: string,
  changedFiles: string[],
  fsx: FsLike = realFs,
  stats?: ReadStats,
): ProjectFile[] {
  let rel: string[]
  if (changedFiles && changedFiles.length > 0) {
    rel = changedFiles.filter(f => !f.split(/[\\/]/).some(seg => SKIP_DIRS.has(seg)))
  } else {
    rel = []
    walkSrc(path.join(projDir, 'src'), projDir, rel, fsx)
    if (rel.length === 0) walkSrc(projDir, projDir, rel, fsx)
  }
  const prioritized = sortByPriority(rel)
  const out: ProjectFile[] = []
  for (const r of prioritized.slice(0, MAX_FILES)) {
    const abs = path.join(projDir, r)
    try {
      if (!fsx.existsSync(abs) || !fsx.isFile(abs)) continue
      let content = fsx.readFileSync(abs)
      // (2026-08-05) Taille RÉELLE conservée avant la coupe : sans elle, la couverture
      // se calculerait sur ce qu'on a bien voulu lire — un dénominateur complaisant.
      const fullChars = content.length
      const truncated = fullChars > MAX_FILE_CHARS
      if (truncated) content = content.slice(0, MAX_FILE_CHARS) + '\n…(tronqué)…'
      out.push({ path: r.replace(/\\/g, '/'), content, fullChars, ...(truncated ? { truncated } : {}) })
    } catch (err) {
      /* fichier illisible ignoré */
      console.warn('[mango-qa] orchestrateur:', (err as Error)?.message ?? err)
    }
  }
  if (stats) {
    const readSet = new Set(out.map(f => f.path))
    stats.discovered = prioritized.length
    stats.read = out.length
    // Découverts mais jamais lus : coupés par MAX_FILES, ou illisibles/disparus.
    stats.dropped = prioritized.map(p => p.replace(/\\/g, '/')).filter(p => !readSet.has(p))
  }
  return out
}

/** #10 (constat "Tests") — détecte l'EXISTENCE de fichiers `*.test.*`/`*.spec.*`
 *  n'importe où dans le projet (pas seulement dans `changedFiles`). Sert à éviter
 *  un Feu Rouge fantôme sur la branche Tests quand des tests existent mais sont
 *  hors du delta de cette phase. Contenu jamais lu — coût borné (arrêt au premier
 *  match via `maxFiles: 1`). */
export function projectHasTests(projDir: string, fsx: FsLike = realFs): boolean {
  const acc: string[] = []
  walkTree<string>(projDir, projDir, acc, {
    skipDirs: SKIP_DIRS,
    extRe: TEST_FILE_RE,
    maxFiles: 1,
    fsx,
    visit: (_full, rel) => rel,
    onError: err => console.warn('[mango-qa] orchestrateur:', (err as Error)?.message ?? err),
  })
  return acc.length > 0
}

