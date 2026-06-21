// Mango QA — Auditeur de Suite (cross-app) : LE VISAGE.
//
// #138 OS d'apps — les apps d'une suite « se parlent » via des COLLECTIONS partagées
// déclarées dans leur manifest `.mangoapp.json` (qui lit / qui écrit / quelle forme).
// Cet auditeur juge la COHÉRENCE de ce graphe de données entre apps — ce que ni tsc
// ni l'Auditeur de Flux (qui regarde UNE app) ne voient : une app lit une collection
// que personne ne produit, deux apps déclarent la même donnée avec des TYPES
// incompatibles (le lecteur va mal lire ce que l'écrivain écrit), une app est un silo.
//
// MÊME PRINCIPE que [[flux]] / l'Œil Design : RIGIDE sur le CERTAIN, SOUPLE sur l'AMBIGU.
//   measured    → un fait DUR : conflit de schéma (même collection+champ, types de base
//                 différents entre apps). Un lecteur mal-typera CERTAINEMENT la donnée.
//   convergence → tout le reste en QUESTIONS : « lue sans écrivain » (peut être seedée
//                 ailleurs), « écrite sans lecteur » (lecteurs à venir ?), app en silo.
// INVARIANT GRAVÉ : `blocking: false` — l'Auditeur conseille, ne bloque JAMAIS.

export type CollectionAccess = 'read' | 'write' | 'readwrite'

/** Une collection déclarée par une app (sous-ensemble du manifest MangoApp). */
export interface SuiteCollection {
  name: string
  access: CollectionAccess
  schema?: Record<string, string>
}
/** Une app conforme (sous-ensemble du `.mangoapp.json`). */
export interface SuiteApp {
  id: string
  name: string
  collections: SuiteCollection[]
}

/** Un conflit de schéma : un champ d'une collection déclaré avec des types incompatibles. */
export interface SchemaConflict {
  collection: string
  field: string
  declarations: { app: string; type: string }[]
}

/** Le rapport de l'Auditeur de Suite. Jamais un verdict : des faits durs + des questions. */
export interface SuiteObservation {
  /** Invariant gravé : l'Auditeur ne bloque JAMAIS. */
  blocking: false
  /** Le seul fait DUR : champ d'une collection aux types incompatibles entre apps. */
  measured: { schemaConflicts: SchemaConflict[] }
  /** Questions de convergence (souple) : lue sans écrivain · écrite sans lecteur · silo. */
  convergence: string[]
  summary: string
  counts: { apps: number; collections: number; measured: number; convergence: number }
}

/** Normalise un nom de collection comme le store partagé (slug) → matching fiable. */
export function slugCollection(name: string): string {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const isReader = (a: CollectionAccess) => a === 'read' || a === 'readwrite'
const isWriter = (a: CollectionAccess) => a === 'write' || a === 'readwrite'
/** Type de base d'un champ (sans le « ? » optionnel). */
const baseType = (spec: string) => (spec.endsWith('?') ? spec.slice(0, -1) : spec).trim()

interface CollInfo {
  readers: Set<string> // ids d'apps
  writers: Set<string>
  declarers: Set<string>
  schemas: { app: string; schema: Record<string, string> }[] // app = nom (affichage)
}

export function auditSuite(apps: SuiteApp[]): SuiteObservation {
  const nameOf = new Map<string, string>()
  const byCollection = new Map<string, CollInfo>()
  let collectionDeclCount = 0

  for (const app of apps) {
    nameOf.set(app.id, app.name)
    for (const c of app.collections ?? []) {
      const key = slugCollection(c.name)
      if (!key) continue
      collectionDeclCount++
      let info = byCollection.get(key)
      if (!info) {
        info = { readers: new Set(), writers: new Set(), declarers: new Set(), schemas: [] }
        byCollection.set(key, info)
      }
      info.declarers.add(app.id)
      if (isReader(c.access)) info.readers.add(app.id)
      if (isWriter(c.access)) info.writers.add(app.id)
      if (c.schema && Object.keys(c.schema).length) info.schemas.push({ app: app.name, schema: c.schema })
    }
  }

  // ── MESURÉ (fait DUR) : conflits de schéma ──────────────────────────────────
  // Même collection + même champ, déclaré avec ≥2 types de base distincts entre apps.
  // Un lecteur mal-typera CERTAINEMENT ce que l'écrivain écrit.
  const schemaConflicts: SchemaConflict[] = []
  for (const [collection, info] of byCollection) {
    if (info.schemas.length < 2) continue
    const fields = new Map<string, Map<string, Set<string>>>() // field -> baseType -> apps
    for (const { app, schema } of info.schemas) {
      for (const [field, spec] of Object.entries(schema)) {
        const bt = baseType(spec)
        if (!fields.has(field)) fields.set(field, new Map())
        const types = fields.get(field)!
        if (!types.has(bt)) types.set(bt, new Set())
        types.get(bt)!.add(app)
      }
    }
    for (const [field, types] of fields) {
      if (types.size < 2) continue
      const declarations: { app: string; type: string }[] = []
      for (const [type, appsForType] of types) for (const app of appsForType) declarations.push({ app, type })
      schemaConflicts.push({ collection, field, declarations })
    }
  }

  // ── CONVERGENCE (questions souples) ─────────────────────────────────────────
  const convergence: string[] = []

  // Collections LUES sans écrivain — donnée seedée ailleurs, ou lecture morte ?
  const readNoWriter = [...byCollection.entries()]
    .filter(([, i]) => i.readers.size > 0 && i.writers.size === 0)
    .map(([c]) => c)
  if (readNoWriter.length) {
    convergence.push(
      `${readNoWriter.length} collection(s) lue(s) sans aucun écrivain (${readNoWriter.slice(0, 6).join(', ')}${readNoWriter.length > 6 ? '…' : ''}) — donnée seedée hors-suite, ou lecture morte ?`,
    )
  }

  // Collections ÉCRITES sans lecteur — donnée orpheline, ou lecteurs à venir ?
  const writeNoReader = [...byCollection.entries()]
    .filter(([, i]) => i.writers.size > 0 && i.readers.size === 0)
    .map(([c]) => c)
  if (writeNoReader.length) {
    convergence.push(
      `${writeNoReader.length} collection(s) écrite(s) que personne ne lit (${writeNoReader.slice(0, 6).join(', ')}${writeNoReader.length > 6 ? '…' : ''}) — donnée orpheline, ou lecteurs à venir ?`,
    )
  }

  // Apps en SILO : aucune de leurs collections n'est partagée avec une autre app.
  const isolated = apps
    .filter((app) => {
      const cols = (app.collections ?? []).map((c) => slugCollection(c.name)).filter(Boolean)
      if (cols.length === 0) return true // ne partage rien
      return cols.every((key) => {
        const decl = byCollection.get(key)?.declarers ?? new Set()
        return decl.size <= 1 // seule cette app la déclare
      })
    })
    .map((a) => a.name)
  if (isolated.length && apps.length > 1) {
    convergence.push(
      `${isolated.length} app(s) en silo (${isolated.slice(0, 6).join(', ')}${isolated.length > 6 ? '…' : ''}) — ne partagent de donnée avec aucune autre app : voulu, ou intégration oubliée ?`,
    )
  }

  return {
    blocking: false,
    measured: { schemaConflicts },
    convergence,
    summary: buildSummary(apps.length, byCollection.size, schemaConflicts, convergence.length),
    counts: { apps: apps.length, collections: byCollection.size, measured: schemaConflicts.length, convergence: convergence.length },
  }
}

function buildSummary(apps: number, collections: number, conflicts: SchemaConflict[], convergence: number): string {
  if (apps === 0) return 'Auditeur de Suite : aucune app composable déclarée — rien à auditer.'
  const head = `Auditeur de Suite : ${apps} app(s), ${collections} collection(s) partagée(s)`
  if (conflicts.length === 0 && convergence === 0) {
    return `${head} — graphe de données cohérent, aucun conflit.`
  }
  const parts: string[] = []
  if (conflicts.length > 0) {
    const sample = conflicts.slice(0, 4).map((c) => `${c.collection}.${c.field}`).join(', ')
    parts.push(`${conflicts.length} conflit(s) de schéma DUR(s) (${sample}${conflicts.length > 4 ? '…' : ''})`)
  }
  const tail = parts.length ? parts.join(' · ') : 'aucun fait dur'
  return `${head} — ${tail}. ${convergence} question(s) de convergence — rien n'est bloqué, Raf tranche.`
}
