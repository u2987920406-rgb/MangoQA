// Helpers partagés entre les tests du Visage 1 — Le Disjoncteur (découpé par
// breaker en fichiers frères depuis l'ancien test-disjoncteur.ts monolithique).
// Déterministe, zéro réseau, zéro LLM.
import {
  evaluateBreakers,
  tripSignature,
  DEFAULT_BREAKER_CONFIG,
  type BreakerConfig,
  type BreakerId,
  type BusEvent,
} from '../../src/breakers/disjoncteur.js'

export { evaluateBreakers, tripSignature, DEFAULT_BREAKER_CONFIG }
export type { BreakerConfig, BreakerId, BusEvent }

export const FROZEN = (): number => 1_000_000
export const cfg: BreakerConfig = { ...DEFAULT_BREAKER_CONFIG }

/** Compteur passed/failed + rapport final, un par fichier de test. */
export function makeChecker(label: string): { check: (name: string, cond: boolean) => void; report: () => void } {
  let passed = 0
  let failed = 0
  function check(name: string, cond: boolean): void {
    if (cond) {
      passed++
    } else {
      failed++
      console.error(`  ❌ ${name}`)
    }
  }
  function report(): void {
    console.log(`\n[${label}] ${passed} ✅  ${failed ? failed + ' ❌' : '0 ❌'}  (${passed + failed} assertions)`)
    if (failed > 0) process.exit(1)
  }
  return { check, report }
}

/** Constructeur d'enveloppe BusEvent, avec un compteur `ts` isolé par appelant. */
export function makeEv(): (partial: Partial<BusEvent> & { type: string; sender: string }) => BusEvent {
  let seq = 0
  return partial => ({ kind: 'success', ts: ++seq, payload: {}, ...partial })
}

export function tripIds(events: BusEvent[], c: BreakerConfig = cfg, opts = {}): BreakerId[] {
  return evaluateBreakers(events, c, { now: FROZEN, ...opts }).trips.map(t => t.breaker)
}
