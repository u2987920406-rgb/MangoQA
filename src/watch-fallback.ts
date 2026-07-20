// Filet de secours pour le watcher chokidar (#Q-fallback).
//
// Bug connu (constaté à l'audit du 2026-07-19) : les écritures faites depuis PowerShell/
// Bash MINGW ne déclenchent pas toujours l'événement chokidar (spécificités Windows du
// file-watching natif). chokidar reste le mécanisme PRIMAIRE (réactif, quasi instantané) ;
// ce module ajoute un scan périodique de secours qui relit le disque directement — un
// filet, pas un remplacement. Sûr par construction : `orchestrator.handleSignal` dédupe
// déjà par `signal.timestamp` par projet (lastHandled), donc rappeler handleSignal sur un
// fichier déjà traité est un no-op.
//
// Module PUR côté détection (scanForSignals) : dépendances fs injectées, zéro minuteur —
// le minuteur (setInterval) reste dans index.ts, comme le veut la séparation câblage/logique
// du repo (cf. orchestrator.ts).
import path from 'node:path'
import type { FsLike } from './orchestrator.js'

/** Liste les fichiers `<workspace>/<projet>/.mangoqa/phase-complete.json` présents sur
 *  disque, tous projets confondus. Un projet sans signal est simplement absent du résultat
 *  (jamais une erreur — le scan est best-effort, comme le veut la philosophie fail-open). */
export function scanForSignals(workspace: string, fsx: FsLike): string[] {
  if (!fsx.existsSync(workspace)) return []
  const out: string[] = []
  let entries: ReturnType<FsLike['readdirSync']>
  try {
    entries = fsx.readdirSync(workspace)
  } catch {
    return []
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const signalPath = path.join(workspace, entry.name, '.mangoqa', 'phase-complete.json')
    // BUG RÉEL trouvé en verif live (2026-07-19) : `FsLike.isFile` = `fs.statSync(p).isFile()`
    // (orchestrator.ts realFs) — `statSync` LÈVE (ENOENT) si le chemin n'existe pas, il ne
    // renvoie pas false. Le motif sûr déjà établi ailleurs dans ce repo (orchestrator.ts:116)
    // est `existsSync` AVANT `isFile` — cette ligne l'omettait et un `signalPath` absent (le
    // cas normal, il n'existe que le temps d'un vrai signal) crashait TOUT le process au 1er
    // scan. Try/catch en filet supplémentaire : best-effort, un projet illisible est ignoré.
    try {
      if (fsx.existsSync(signalPath) && fsx.isFile(signalPath)) out.push(signalPath)
    } catch {
      continue
    }
  }
  return out
}

/** État mutable du filtre mtime — un scan par processus, tenu par l'appelant (index.ts). */
export interface FallbackScanState {
  seen: Map<string, number>
  firstScan: boolean
}

export function initFallbackScanState(): FallbackScanState {
  return { seen: new Map(), firstScan: true }
}

/**
 * 2ᵉ bug RÉEL trouvé en verif live (2026-07-19) : sans protection, chaque redémarrage du
 * process rejouait TOUS les signaux déjà présents sur disque (des dizaines de vieux projets
 * jamais nettoyés) — chokidar a `ignoreInitial: true` exprès pour éviter ça, ce fallback ne
 * l'avait pas. Filtre PUR (mtime injecté, zéro I/O) : ne retient un chemin QUE si son mtime a
 * changé depuis le dernier scan vu par CE fallback ; la toute première observation d'un
 * chemin (baseline au boot, `firstScan`) est enregistrée mais jamais retenue pour traitement
 * — imite `ignoreInitial`. Un futur VRAI nouveau signal sur le même chemin change son mtime
 * → repris normalement au scan suivant.
 */
export function filterChangedSignals(
  paths: string[],
  getMtimeMs: (p: string) => number | null,
  state: FallbackScanState,
): string[] {
  const toProcess: string[] = []
  for (const p of paths) {
    const mtime = getMtimeMs(p)
    if (mtime === null) continue
    const prev = state.seen.get(p)
    state.seen.set(p, mtime)
    if (state.firstScan) continue
    if (prev === mtime) continue
    toProcess.push(p)
  }
  return toProcess
}
