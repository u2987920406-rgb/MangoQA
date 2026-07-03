// Lecteur JSONL partagé — lecture BORNÉE par la queue (anti-OOM, famille #L70).
//
// Pattern prouvé par readBusEvents (breakers/runner.ts) : un flux .jsonl append-only
// grossit sans limite ; le relire ENTIER à chaque cycle alloue une string de la taille
// du fichier → pression heap → OOM V8 (exit 134). Ici, on ne lit JAMAIS plus de
// `maxBytes` octets (positionnés sur la FIN du fichier = les entrées récentes, seules
// pertinentes), on jette la 1ʳᵉ ligne probablement tronquée, et on borne le nombre
// d'entrées gardées en mémoire (`maxLines`).
//
// Deux modes :
//   readJsonlTail  — stateless : la queue du fichier, bornée. (readLatestBrief,
//                    readMetricsTail, Retex.loadAll, readBusEvents)
//   readJsonlSince — incrémental : seulement les octets NOUVEAUX depuis le dernier
//                    passage (curseur), reset si le fichier a rétréci (rotation).
//                    (polling du Disjoncteur, cycle 5 s)
//
// Fail-open ≠ fail-silent : fichier ABSENT (ENOENT) = état normal → silencieux ;
// toute autre erreur I/O est avalée mais TRACÉE (console.warn).
import fs from 'node:fs'

export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024 // 4 Mo lus au maximum par appel
export const DEFAULT_MAX_LINES = 20_000 // borne dure du tableau d'entrées en mémoire

export interface JsonlTailOptions {
  /** Octets lus au maximum (défaut 4 Mo) — positionnés sur la fin du fichier. */
  maxBytes?: number
  /** Nombre max d'entrées renvoyées (les plus récentes gagnent — défaut 20 000). */
  maxLines?: number
}

/** ENOENT = fichier pas encore créé → normal, silencieux. Le reste est tracé. */
function warnUnlessMissing(context: string, err: unknown): void {
  if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return
  console.warn(`[mango-qa] ${context}:`, (err as Error)?.message ?? err)
}

/** Parse des lignes JSONL (tolérant : ligne vide/corrompue ignorée), borné à maxLines. */
function parseLines<T>(raw: string, maxLines: number): T[] {
  const out: T[] = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const v = JSON.parse(t) as T
      if (v !== null && typeof v === 'object') out.push(v)
    } catch {
      /* ligne partielle/corrompue ignorée — tolérance JSONL standard */
    }
  }
  return out.length > maxLines ? out.slice(-maxLines) : out
}

/** Lit la QUEUE d'un fichier JSONL, bornée en octets et en lignes.
 *  Fichier absent → []. Fichier > maxBytes → seuls les derniers maxBytes octets sont
 *  lus et la 1ʳᵉ ligne (probablement tronquée) est jetée. Allocation bornée quelle
 *  que soit la taille du fichier. */
export function readJsonlTail<T = Record<string, unknown>>(file: string, opts: JsonlTailOptions = {}): T[] {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES
  let raw: string
  try {
    const size = fs.statSync(file).size
    if (size <= maxBytes) {
      raw = fs.readFileSync(file, 'utf8')
    } else {
      // Ne lire que les derniers maxBytes octets (la queue = les entrées récentes).
      const fd = fs.openSync(file, 'r')
      try {
        const buf = Buffer.alloc(maxBytes)
        const read = fs.readSync(fd, buf, 0, maxBytes, size - maxBytes)
        raw = buf.toString('utf8', 0, read)
      } finally {
        fs.closeSync(fd)
      }
      // La 1ʳᵉ ligne est probablement tronquée → on la jette. (S'il n'y a aucun \n,
      // tout le fragment est une ligne tronquée : JSON.parse échouera → ignorée.)
      const nl = raw.indexOf('\n')
      if (nl >= 0) raw = raw.slice(nl + 1)
    }
  } catch (err) {
    warnUnlessMissing(`jsonl-tail ${file}`, err)
    return []
  }
  return parseLines<T>(raw, maxLines)
}

/** Curseur de lecture incrémentale : position (octets) déjà consommée. */
export interface JsonlCursor {
  offset: number
}

export interface JsonlDelta<T> {
  /** Les entrées NOUVELLES depuis le dernier passage (lignes complètes uniquement). */
  entries: T[]
  /** true si le fichier a rétréci/disparu (rotation) → l'appelant doit repartir de zéro. */
  reset: boolean
}

/** Lecture INCRÉMENTALE : ne lit que les octets écrits depuis `cursor.offset`.
 *  - Le curseur n'avance que jusqu'à la dernière ligne COMPLÈTE (une fin de fichier
 *    en cours d'écriture sera relue au prochain passage).
 *  - Si le delta dépasse maxBytes, on saute au dernier maxBytes et on jette la 1ʳᵉ
 *    ligne tronquée (même garantie anti-OOM que readJsonlTail).
 *  - Fichier rétréci ou disparu (rotation) → { reset: true } et curseur remis à 0. */
export function readJsonlSince<T = Record<string, unknown>>(
  file: string,
  cursor: JsonlCursor,
  opts: JsonlTailOptions = {},
): JsonlDelta<T> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES

  let size: number
  try {
    size = fs.statSync(file).size
  } catch (err) {
    warnUnlessMissing(`jsonl-since ${file}`, err)
    const reset = cursor.offset > 0 // le fichier a disparu = rotation
    cursor.offset = 0
    return { entries: [], reset }
  }

  let reset = false
  if (size < cursor.offset) {
    // Le fichier a RÉTRÉCI (rotation/troncature) : tout ce qu'on savait est périmé.
    cursor.offset = 0
    reset = true
  }
  if (size === cursor.offset) return { entries: [], reset }

  // Borne anti-OOM : si le delta dépasse maxBytes, ne lire que la fin.
  let start = cursor.offset
  let skippedAhead = false
  if (size - start > maxBytes) {
    start = size - maxBytes
    skippedAhead = true
  }

  let chunk: Buffer
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(size - start)
      const read = fs.readSync(fd, buf, 0, size - start, start)
      chunk = buf.subarray(0, read)
    } finally {
      fs.closeSync(fd)
    }
  } catch (err) {
    warnUnlessMissing(`jsonl-since ${file}`, err)
    return { entries: [], reset }
  }

  // Si on a sauté en avant, la 1ʳᵉ ligne du fragment est probablement tronquée → jetée.
  let from = 0
  if (skippedAhead) {
    const nl = chunk.indexOf(0x0a)
    if (nl < 0) {
      // Un seul fragment géant sans \n : rien d'exploitable, tout consommé.
      cursor.offset = size
      return { entries: [], reset }
    }
    from = nl + 1
  }

  // N'avancer le curseur que jusqu'à la dernière ligne COMPLÈTE (\n final inclus).
  const lastNl = chunk.lastIndexOf(0x0a)
  if (lastNl < from) {
    // Aucune nouvelle ligne complète — la fin est en cours d'écriture.
    cursor.offset = start + from // on a tout de même consommé la ligne tronquée sautée
    return { entries: [], reset }
  }

  const raw = chunk.toString('utf8', from, lastNl + 1)
  cursor.offset = start + lastNl + 1
  return { entries: parseLines<T>(raw, maxLines), reset }
}
