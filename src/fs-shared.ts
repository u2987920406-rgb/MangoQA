// Mango QA — helpers partagés fichiers/rendu (#R3).
//
// Élimine deux duplications trouvées par l'audit :
// - `renderFiles` existait à l'identique (à un cap et un libellé de troncature
//   près) dans llm.ts ET flux-eye/deep.ts. Les deux visages appellent
//   désormais cette version partagée (llm.ts rédacte les secrets AVANT
//   de la passer en entrée, pour préserver son comportement d'origine).
// - `walk`/`walkSrc` existait à l'identique (à l'extension/aux dossiers ignorés/
//   au mode « chemins seuls vs contenu lu » près) dans orchestrator.ts ET
//   flux-eye/runner.ts.
//
// Les deux visages restent PARAMÉTRÉS (cap, extensions, dossiers ignorés, fs
// injectable) pour préserver EXACTEMENT leur comportement d'origine — ceci est
// une extraction, pas un changement de comportement.
import fs from 'node:fs'
import path from 'node:path'
import type { AuditCoverage, ProjectFile } from './types.js'

// ── atomicWriteFileSync : écriture jamais lue à moitié écrite ─────────────────

/** Écrit `data` dans `file` de façon ATOMIQUE (tmp + rename) : un lecteur ne voit
 *  jamais un fichier tronqué, même si le process meurt en plein écriture. Le nom
 *  temporaire inclut pid+timestamp pour ne pas entrer en collision entre process
 *  concurrents (MangoQA peut avoir des instances qui se chevauchent).
 *
 *  (Audit d'allègement 2026-07-24) Extrait de observer-runner.ts, où ce patron
 *  vivait en local avec le commentaire « le repo n'a pas de helper partagé pour ça ».
 *  Les 3 autres visages (design-eye/flux-eye/suite-eye) écrivaient, eux, en
 *  `fs.writeFileSync` DIRECT (non-atomique) — un vrai risque de fichier
 *  d'observations tronqué au crash, exactement la classe de bug traquée côté
 *  MangoOS. Ce helper unique ferme le gap ET la duplication d'un coup. */
export function atomicWriteFileSync(file: string, data: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, data, 'utf8')
  fs.renameSync(tmp, file)
}

// ── renderFiles : payload de prompt borné ────────────────────────────────────

/** Concatène des fichiers en un payload de prompt borné à `cap` caractères, ET
 *  rend la couverture correspondante. Au premier fichier qui ferait déborder le
 *  cap, tronque son contenu (si la place restante dépasse 200 caractères) et
 *  s'arrête — comportement identique à l'ancien `renderFiles` de llm.ts /
 *  flux-eye/deep.ts. `truncatedLabel` diffère entre visages (llm.ts :
 *  « …(tronqué)… » avec accent ; flux-eye/deep.ts : « …(tronque)… » sans accent,
 *  par convention du fichier) — préservé via paramètre plutôt que codé en dur. */
export function renderFilesWithCoverage(
  files: ProjectFile[],
  cap: number,
  truncatedLabel = '…(tronqué)…',
): { text: string; coverage: AuditCoverage } {
  let out = ''
  let charsRendered = 0
  let filesRendered = 0
  const truncated: string[] = []
  const sourceTruncated: string[] = []
  const omitted: string[] = []
  let stopped = false

  for (const f of files) {
    if (stopped) {
      omitted.push(f.path)
      continue
    }
    const header = `\n----- ${f.path} -----\n`
    if (out.length + header.length + f.content.length > cap) {
      const room = Math.max(0, cap - out.length - header.length)
      if (room > 200) {
        out += header + f.content.slice(0, room) + `\n${truncatedLabel}\n`
        charsRendered += room
        filesRendered++
        truncated.push(f.path)
      } else {
        // Pas même la place d'un fragment utile : le fichier est purement absent.
        omitted.push(f.path)
      }
      // Comportement historique : on s'arrête au premier débordement. Les fichiers
      // suivants ne sont pas envoyés — on continue la boucle uniquement pour les
      // COMPTER (c'est tout l'objet de cette fonction).
      stopped = true
      continue
    }
    out += header + f.content
    charsRendered += f.content.length
    filesRendered++
    // Coupé DÈS LA LECTURE disque (MAX_FILE_CHARS) : le fichier est bien dans le
    // prompt, mais amputé. On ne le note QUE s'il a été envoyé — dire d'un fichier
    // jamais fourni qu'il a été « fourni mais coupé » serait une fausse précision.
    if (f.truncated) sourceTruncated.push(f.path)
  }

  const charsTotal = files.reduce((n, f) => n + (f.fullChars ?? f.content.length), 0)
  return {
    text: out,
    coverage: {
      filesTotal: files.length,
      filesRendered,
      omitted,
      truncated,
      sourceTruncated,
      charsTotal,
      charsRendered,
      complete: omitted.length === 0 && truncated.length === 0 && sourceTruncated.length === 0,
    },
  }
}

/** Variante « texte seul » — signature et sortie strictement inchangées depuis #R3
 *  (les appelants qui n'ont pas besoin de la couverture ne changent pas). */
export function renderFiles(files: ProjectFile[], cap: number, truncatedLabel = '…(tronqué)…'): string {
  return renderFilesWithCoverage(files, cap, truncatedLabel).text
}

// ── walkTree : parcours récursif borné, extension/dossiers paramétrés ───────

/** Entrée de répertoire minimale requise (compatible `fs.Dirent` ET les
 *  `FsLike.readdirSync` injectés par l'orchestrateur pour les tests). */
export interface WalkEntry {
  name: string
  isDirectory(): boolean
}

/** Surface fs minimale requise par `walkTree` (juste `readdirSync`). */
export interface WalkFs {
  readdirSync(dir: string): WalkEntry[]
}

export interface WalkOptions<T> {
  /** Noms de dossiers à sauter (en plus des noms commençant par `.`). */
  skipDirs: Set<string>
  /** Extension(s) retenues pour un fichier candidat. */
  extRe: RegExp
  /** Borne dure du nombre d'éléments accumulés dans `acc`. */
  maxFiles: number
  fsx: WalkFs
  /** Traite un fichier candidat (déjà filtré par `extRe`) : chemin absolu et
   *  chemin relatif à `base`. Renvoie l'élément à accumuler, ou `undefined`
   *  pour l'ignorer SANS qu'il compte dans `maxFiles` — reproduit le
   *  comportement historique de flux-eye/runner.ts (un fichier illisible ne
   *  consommait pas de place dans le cap). */
  visit: (fullPath: string, relPath: string) => T | undefined
  /** Dossier illisible (fail-open) : tracé, jamais silencieux (#Q3). */
  onError?: (err: unknown) => void
}

/** Parcours récursif borné et paramétré — remplace `walkSrc` (orchestrator.ts,
 *  chemins seuls) ET `walk` (flux-eye/runner.ts, contenu lu) sans changer leur
 *  comportement respectif : chaque visage fournit son propre `visit`. */
export function walkTree<T>(dir: string, base: string, acc: T[], opts: WalkOptions<T>): void {
  if (acc.length >= opts.maxFiles) return
  let entries: WalkEntry[]
  try {
    entries = opts.fsx.readdirSync(dir)
  } catch (err) {
    opts.onError?.(err)
    return
  }
  for (const e of entries) {
    if (acc.length >= opts.maxFiles) return
    if (e.name.startsWith('.') || opts.skipDirs.has(e.name)) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      walkTree(full, base, acc, opts)
    } else if (opts.extRe.test(e.name)) {
      const item = opts.visit(full, path.relative(base, full))
      if (item !== undefined) acc.push(item)
    }
  }
}

/** Adaptateur fs réel (node:fs) pour `walkTree`, pour les visages qui ne
 *  passent pas déjà par un `FsLike` injectable (ex. flux-eye/runner.ts). */
export const realWalkFs: WalkFs = {
  readdirSync: d => fs.readdirSync(d, { withFileTypes: true }),
}
