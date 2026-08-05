// Mango QA — Auditeur de Flux : TIER 1 (audit LLM conseil, cost-aware).
//
// Complète le Tier 0 deterministe : la ou le Tier 0 mesure des FAITS structurels
// (cibles fantomes, surfaces inatteignables), le Tier 1 juge le SENS du flux —
// R4 (surfaces homogenes) et la coherence humaine — ce qui demande un jugement (LLM).
//
// COST-AWARE : ne tourne PAS a chaque build. `shouldRunDeep` gate le declenchement
// (build qui galere, app complexe, fait dur Tier 0, escalade cerveau, ou a la demande).
// #165 : askLLM (llm.ts) route en PRIMAIRE vers Ollama (qwen3.5:cloud, souverain,
// $0 API), repli automatique sur l'abonnement Claude si Ollama est injoignable.
//
// POSTURE : conseil, JAMAIS bloquant (`blocking: false`). Fail-open partout.
import fs from 'node:fs'
import path from 'node:path'
import type { AuditCoverage, ProjectFile, PhaseSignal } from '../types.js'
import type { NavGraph } from './graph.js'
import type { FluxObservation } from './eye.js'
import { askLLM, coverageBlock, parseFirstJson } from '../llm.js'
import { readJsonlTail } from '../jsonl.js'
import { renderFilesWithCoverage } from '../fs-shared.js'

export const DEEP_OBSERVATIONS_FILE = 'flux-deep-observations.json'

/** Plafond de code injecté dans le prompt de l'Auditeur de Flux, en caractères.
 *
 *  (2026-08-05, faille J2-b) DÉLIBÉRÉMENT laissé à 20 000, alors que les 6 branches
 *  sont passées à 100 000. Ce visage-ci n'a jamais été mesuré contre un corpus : le
 *  relever changerait son comportement sans donnée pour dire si c'est en mieux. La
 *  discipline de J2 vaut ici aussi — on DÉCLARE d'abord, on relève ensuite, et
 *  seulement sur mesure. Réglable par `FLUX_DEEP_PAYLOAD_CAP` pour que ce relèvement
 *  soit un geste explicite le jour où il sera fondé. */
export const DEFAULT_FLUX_PAYLOAD_CAP = 20_000
function fluxPayloadCap(): number {
  const raw = parseInt((process.env.FLUX_DEEP_PAYLOAD_CAP ?? '').trim(), 10)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FLUX_PAYLOAD_CAP
}

function envInt(name: string, def: number): number {
  const v = parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(v) ? v : def
}

// ── 1. Declencheur (pur, deterministe, testable) ─────────────────────────────
export interface DeepTriggerDeps {
  workspace?: string
  /** Lit les N dernieres lignes de workspace/.metrics.jsonl (injectable pour les tests). */
  readMetricsTail?: (workspace: string, n: number) => Array<Record<string, unknown>>
  /** Force l'audit (CLI --deep). */
  force?: boolean
}

export interface DeepDecision {
  run: boolean
  reason: string
}

/** Cap octets de la queue métrique : 20 lignes utiles tiennent très largement dedans. */
const METRICS_TAIL_BYTES = 512 * 1024

/** Lit la queue de workspace/.metrics.jsonl via le lecteur JSONL partagé (#Q1 :
 *  lecture BORNÉE — l'ancienne version relisait le fichier ENTIER pour garder n lignes). */
export function readMetricsTail(workspace: string, n: number): Array<Record<string, unknown>> {
  return readJsonlTail<Record<string, unknown>>(path.join(workspace, '.metrics.jsonl'), {
    maxBytes: METRICS_TAIL_BYTES,
    maxLines: n,
  })
}

export function shouldRunDeep(
  graph: NavGraph,
  tier0: FluxObservation,
  signal: PhaseSignal,
  deps: DeepTriggerDeps = {},
): DeepDecision {
  if (deps.force || process.env.FLUX_DEEP === 'always') return { run: true, reason: 'a la demande' }

  const minRetries = envInt('FLUX_DEEP_MIN_RETRIES', 2)
  if ((signal.retryCount ?? 0) >= minRetries) {
    return { run: true, reason: `build en difficulte (tentative ${signal.retryCount})` }
  }

  if (tier0.measured.phantomTargets.length > 0) {
    return { run: true, reason: `${tier0.measured.phantomTargets.length} fantome(s) dur(s) au Tier 0` }
  }

  const surfaces = graph.screensRendered.length + graph.windowsRendered.length + graph.routesRendered.length
  const minSurfaces = envInt('FLUX_DEEP_MIN_SURFACES', 12)
  if (surfaces >= minSurfaces) {
    return { run: true, reason: `app complexe (${surfaces} surfaces)` }
  }

  // Escalade cerveau (le filet du Brain Adaptateur) : un build resolu par le Maitre
  // (Claude apres echec de l'Eleve) = projet difficile → l'audit de sens vaut le coup.
  const ws = deps.workspace ?? process.env.MANGOAI_WORKSPACE ?? ''
  if (ws) {
    const metrics = (deps.readMetricsTail ?? readMetricsTail)(ws, 20)
    if (metrics.some(m => m.project === signal.projectName && m.resolvedBy === 'maitre')) {
      return { run: true, reason: 'escalade cerveau (resolvedBy=maitre)' }
    }
  }

  return { run: false, reason: 'aucun declencheur (Tier 0 suffit)' }
}

// ── 2. Audit LLM (async, fail-open, conseil) ─────────────────────────────────
export interface DeepFinding {
  observation: string
  kind: 'homogeneite' | 'coherence' | 'autre'
  severity: 'note' | 'suggestion'
  surfaces?: string[]
}

export interface FluxDeepObservation {
  /** Invariant grave : jamais bloquant. */
  blocking: false
  ran: boolean
  reason: string
  model: string
  findings: DeepFinding[]
  summary: string
  /** Ce que le modèle a RÉELLEMENT lu (faille J2-b). Écrite telle quelle dans
   *  `flux-deep-observations.json` : un lecteur de ce fichier doit pouvoir savoir si
   *  « flux cohérent » porte sur tout le code ou sur un cinquième. `undefined` quand
   *  aucun rendu n'a eu lieu (audit non exécuté). */
  coverage?: AuditCoverage
}

export interface DeepAuditDeps {
  /** (system, user) -> texte. Defaut askClaude (abonnement). Injectable pour les tests. */
  askLLM?: (system: string, user: string) => Promise<string>
  model?: string
}

function graphSummary(g: NavGraph): string {
  const line = (label: string, xs: string[]) => `${label}: ${xs.length ? xs.join(', ') : '—'}`
  return [
    line('Entrees', g.entries),
    line('Ecrans (etat) rendus', g.screensRendered),
    line('Fenetres rendues', g.windowsRendered),
    line('Routes rendues', g.routesRendered),
  ].join('\n')
}

const DEEP_SYSTEM = `Tu es l'Auditeur de Flux de Mango QA (posture CONSEIL, JAMAIS bloquant). Tu juges la COHERENCE DU CHEMIN HUMAIN d'une app — pas son code, que tsc/lint couvrent deja. Concentre-toi sur deux axes :
- R4 SURFACES HOMOGENES : une meme CATEGORIE de chose doit vivre sur une meme surface (une app -> une fenetre ; un reglage -> une sous-section ; un outil projet -> un panneau). Signale les heterogeneites (ex. un reglage en plein ecran alors que les autres sont des sous-sections).
- COHERENCE SEMANTIQUE : chemins confus ou trop longs, impasses qu'un humain heurterait, decalage entre l'intention de l'utilisateur et le chemin, acces dupliques genants.
Tu ne donnes que des OBSERVATIONS et des SUGGESTIONS — jamais des erreurs, jamais de blocage. Raf est seul juge.
Reponds UNIQUEMENT par un objet JSON valide, sans texte autour :
{ "findings": [ { "observation": "<phrase courte en francais>", "kind": "homogeneite" | "coherence" | "autre", "severity": "note" | "suggestion", "surfaces": ["<id de surface concernee>"] } ], "summary": "<une phrase en francais>" }
Si le flux est coherent : "findings" vide et un "summary" positif. N'invente jamais un probleme.`

export async function auditFluxDeep(
  graph: NavGraph,
  tier0: FluxObservation,
  files: ProjectFile[],
  signal: PhaseSignal,
  deps: DeepAuditDeps = {},
): Promise<FluxDeepObservation> {
  const model = deps.model ?? process.env.FLUX_DEEP_MODEL ?? process.env.QA_MODEL ?? 'sonnet'
  const ask = deps.askLLM ?? askLLM

  const { text: payload, coverage } = renderFilesWithCoverage(files, fluxPayloadCap(), '…(tronque)…')

  // Le risque de conclure par absence est PLUS fort ici que sur les 6 branches : « cette
  // surface est inatteignable », « aucune entree ne mene la » sont exactement des jugements
  // d'absence. Mais le GRAPHE, lui, vient d'une analyse statique menee hors de ce payload —
  // il reste complet meme quand le code est plafonne. On dit donc les deux au modele : ce
  // qu'il ne voit pas, et ce a quoi il peut se fier malgre tout.
  const couverture = coverageBlock(coverage, {
    consigne: 'Ne signale une observation que sur ce qui est VISIBLE dans les fichiers ci-dessous ou dans le graphe.',
    signalDeterministe: 'GRAPHE DE NAVIGATION / FAIT DU TIER 0',
  })

  const user = `Projet : ${signal.projectName} — phase ${signal.phase}.

GRAPHE DE NAVIGATION (extrait deterministe du Tier 0) :
${graphSummary(graph)}

FAITS DU TIER 0 :
- mesure (durs) : ${tier0.summary}
- questions de convergence : ${tier0.convergence.length ? tier0.convergence.join(' | ') : '—'}${couverture}

CODE PERTINENT :
${payload}`

  try {
    const raw = await ask(DEEP_SYSTEM, user)
    const parsed = parseFirstJson<{ findings?: unknown[]; summary?: string }>(raw)
    if (!parsed) {
      return { blocking: false, ran: false, reason: 'reponse illisible', model, findings: [], summary: 'Audit profond ignore (reponse illisible).', coverage }
    }
    const findings: DeepFinding[] = (Array.isArray(parsed.findings) ? parsed.findings : [])
      .map(raw => raw as Record<string, unknown>)
      .filter(f => f && typeof f.observation === 'string' && (f.observation as string).trim())
      .map(f => {
        const kind = f.kind === 'homogeneite' || f.kind === 'coherence' ? f.kind : 'autre'
        const severity = f.severity === 'suggestion' ? 'suggestion' : 'note'
        const surfaces = Array.isArray(f.surfaces) ? (f.surfaces as unknown[]).filter((s): s is string => typeof s === 'string') : undefined
        const finding: DeepFinding = { observation: (f.observation as string).trim(), kind, severity }
        if (surfaces && surfaces.length) finding.surfaces = surfaces
        return finding
      })
    // « Flux coherent » sur une lecture partielle n'est PAS « flux coherent ». La reserve
    // est recopiee dans le texte du resume, pas seulement dans le champ structure — meme
    // regle que buildVerdict : aucun affichage existant ne doit pouvoir presenter un audit
    // partiel comme complet sans avoir ete mis a jour.
    const base = (parsed.summary ?? '').trim() ||
      (findings.length ? `${findings.length} observation(s) de flux.` : 'Flux coherent (audit profond).')
    const summary = coverage.complete
      ? base
      : `${base} [lecture partielle : ${coverage.filesRendered}/${coverage.filesTotal} fichiers lus]`
    return { blocking: false, ran: true, reason: 'audit effectue', model, findings, summary, coverage }
  } catch (err) {
    return {
      blocking: false,
      ran: false,
      reason: `erreur : ${err instanceof Error ? err.message : String(err)}`,
      model,
      findings: [],
      summary: 'Audit profond ignore (fail-open).',
      coverage,
    }
  }
}

// ── 3. Runner : ecrit flux-deep-observations.json ────────────────────────────
export interface RunDeepDeps extends DeepAuditDeps {
  writeFile?: (file: string, data: string) => void
  now?: () => number
}

export async function runFluxDeep(
  projDir: string,
  graph: NavGraph,
  tier0: FluxObservation,
  files: ProjectFile[],
  signal: PhaseSignal,
  deps: RunDeepDeps = {},
): Promise<FluxDeepObservation> {
  const obs = await auditFluxDeep(graph, tier0, files, signal, deps)
  try {
    const writeFile = deps.writeFile ?? ((f, d) => fs.writeFileSync(f, d, 'utf8'))
    const now = deps.now ?? (() => Date.now())
    const dir = path.join(projDir, '.mangoqa')
    fs.mkdirSync(dir, { recursive: true })
    writeFile(path.join(dir, DEEP_OBSERVATIONS_FILE), JSON.stringify({ ...obs, observedAt: now() }, null, 2))
  } catch (err) {
    // fail-open
    console.warn('[mango-qa] flux-tier1:', (err as Error)?.message ?? err)
  }
  return obs
}
