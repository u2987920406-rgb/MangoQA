// Mango QA — Auditeur de Flux : LE VISAGE (cf. wiki/flux.md, contrat de flux).
//
// Audite le CHEMIN HUMAIN d'une app, pas son code : ce que tsc/lint/tests ne voient
// pas (le code peut être correct et le flux cassé — ex. un bouton « créer une app »
// disparu, ou `setScreen("chat")` qui ne rend rien). Il applique le contrat de flux :
//
//   R1 Zéro écran orphelin · R2 Une entrée par fonction · R3 Pas d'écran fantôme
//   R4 Surfaces homogènes (sémantique → Tier 1, hors scope) · R5 Tout atteignable
//
// PRINCIPE (comme l'Œil Design) : RIGIDE sur le CERTAIN, SOUPLE sur l'AMBIGU.
//   measured    → un seul fait DUR : une cible fenêtre/route sans handler. Ces surfaces
//                 n'ont pas de fallback ⇒ écran blanc CERTAIN. Aucun faux positif possible.
//   convergence → tout le reste en QUESTIONS : l'inatteignabilité ne se PROUVE pas
//                 statiquement (setter passé en prop, cible dynamique) ; une cible d'état
//                 sans rendu dédié peut retomber sur un else ; un doublon peut être voulu.
// INVARIANT GRAVÉ : `blocking: false` — l'Auditeur conseille, ne bloque JAMAIS.
import type { NavGraph, NavEdge } from './graph.js'

export type SurfaceKind = 'screen' | 'window' | 'route'

/** Une cible de nav sans rendu correspondant — un FAIT (R3, surface sans fallback). */
export interface PhantomTarget {
  target: string
  from: string
  kind: SurfaceKind
}

/** Une surface rendue qu'on n'a pas su atteindre statiquement — un SUSPECT (R1 + R5). */
export interface Unreachable {
  id: string
  kind: SurfaceKind
}

/** Le rapport de l'Auditeur. Jamais un verdict : un fait dur + des questions. */
export interface FluxObservation {
  /** Invariant gravé : l'Auditeur ne bloque JAMAIS. */
  blocking: false
  /** Le SEUL fait dur : cible fenêtre/route sans handler (blanc certain — R3). */
  measured: { phantomTargets: PhantomTarget[] }
  /** Suspects d'inatteignabilité (R1/R5) — incertain (alias/dynamique), donc en question. */
  suspects: { unreachable: Unreachable[] }
  /** Questions de convergence (souple) : inatteignables · fantôme d'état (R3 doux) · doublons (R2). */
  convergence: string[]
  summary: string
  counts: { measured: number; convergence: number }
}

function distinctTargets(edges: NavEdge[]): string[] {
  return [...new Set(edges.map(e => e.target))]
}

/** Cibles atteintes depuis ≥ `min` fichiers distincts (sur-duplication probable). */
function overDuplicated(edges: NavEdge[], min: number): string[] {
  const bySource = new Map<string, Set<string>>()
  for (const e of edges) {
    if (!bySource.has(e.target)) bySource.set(e.target, new Set())
    bySource.get(e.target)!.add(e.from)
  }
  return [...bySource.entries()].filter(([, srcs]) => srcs.size >= min).map(([t]) => t)
}

export function inspectFlux(g: NavGraph): FluxObservation {
  const entrySet = new Set(g.entries)

  // ── MESURÉ (le seul fait DUR) : R3 sur surfaces SANS fallback (fenêtre/route) ──
  const winRendered = new Set(g.windowsRendered)
  const routeRendered = new Set(g.routesRendered)
  const phantomTargets: PhantomTarget[] = []
  const seen = new Set<string>()
  for (const e of g.windowTargets) {
    if (!winRendered.has(e.target) && !seen.has('w:' + e.target)) {
      seen.add('w:' + e.target)
      phantomTargets.push({ target: e.target, from: e.from, kind: 'window' })
    }
  }
  if (!g.hasCatchAllRoute) {
    for (const e of g.routeTargets) {
      if (!routeRendered.has(e.target) && !seen.has('r:' + e.target)) {
        seen.add('r:' + e.target)
        phantomTargets.push({ target: e.target, from: e.from, kind: 'route' })
      }
    }
  }

  // ── SUSPECTS (R1 + R5) : surface RENDUE jamais ciblée et hors entrée ──────────
  // Incertain : un setter peut être passé en prop, une cible peut être dynamique.
  // On le présente donc en QUESTION, jamais en erreur.
  const screenTargetSet = new Set(distinctTargets(g.screenTargets))
  const windowTargetSet = new Set(distinctTargets(g.windowTargets))
  const routeTargetSet = new Set(distinctTargets(g.routeTargets))
  const unreachable: Unreachable[] = []
  for (const id of g.screensRendered) {
    if (!screenTargetSet.has(id) && !entrySet.has(id)) unreachable.push({ id, kind: 'screen' })
  }
  for (const id of g.windowsRendered) {
    if (!windowTargetSet.has(id)) unreachable.push({ id, kind: 'window' })
  }
  for (const id of g.routesRendered) {
    if (!routeTargetSet.has(id) && !entrySet.has(id)) unreachable.push({ id, kind: 'route' })
  }

  // ── CONVERGENCE (questions souples) ─────────────────────────────────────────
  const convergence: string[] = []
  if (unreachable.length > 0) {
    const sample = unreachable.slice(0, 8).map(u => u.id).join(', ')
    convergence.push(
      `${unreachable.length} surface(s) rendue(s) jamais ciblée(s) (${sample}${unreachable.length > 8 ? '…' : ''}) — code mort, ou atteintes via un alias/une cible dynamique ?`,
    )
  }
  // R3 doux : cible d'état sans rendu dédié (peut retomber sur un else — ambigu).
  const screenRenderedSet = new Set(g.screensRendered)
  const softPhantoms = distinctTargets(g.screenTargets).filter(t => !screenRenderedSet.has(t) && !entrySet.has(t))
  if (softPhantoms.length > 0) {
    convergence.push(
      `${softPhantoms.length} cible(s) d'écran sans rendu dédié (${softPhantoms.slice(0, 5).join(', ')}${softPhantoms.length > 5 ? '…' : ''}) — fantôme, ou couvert par un fallback voulu ?`,
    )
  }
  // R2 : sur-duplication d'accès (≥ 3 sources distinctes) — raccourci voulu ou doublon ?
  const dups = [
    ...overDuplicated(g.screenTargets, 3),
    ...overDuplicated(g.windowTargets, 3),
    ...overDuplicated(g.routeTargets, 3),
  ]
  if (dups.length > 0) {
    convergence.push(
      `${dups.length} cible(s) accessibles depuis 3+ endroits (${dups.slice(0, 5).join(', ')}) — raccourcis voulus, ou doublons à réduire ?`,
    )
  }

  return {
    blocking: false,
    measured: { phantomTargets },
    suspects: { unreachable },
    convergence,
    summary: buildSummary(phantomTargets.length, unreachable.length, convergence.length),
    counts: { measured: phantomTargets.length, convergence: convergence.length },
  }
}

function buildSummary(phantoms: number, unreachable: number, convergence: number): string {
  if (phantoms === 0 && convergence === 0) {
    return 'Auditeur de Flux : navigation cohérente — aucun écran fantôme, aucun suspect.'
  }
  const parts: string[] = []
  if (phantoms > 0) parts.push(`${phantoms} cible(s) fantôme(s) DURE(s) (surface sans handler)`)
  if (unreachable > 0) parts.push(`${unreachable} suspect(s) d'inatteignabilité`)
  const head = parts.length > 0 ? parts.join(' · ') : 'aucun fait dur'
  return `Auditeur de Flux : ${head}. ${convergence} question(s) de convergence — rien n'est bloqué, Raf tranche.`
}
