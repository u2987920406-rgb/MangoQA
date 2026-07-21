// Tests du cœur pur du superviseur MangoQA (#Q-watchdog, limites.md L127).
// Déterministe, zéro process réel, zéro disque, zéro timer.
import { describe, it, expect } from 'vitest'
import {
  parseHeartbeat,
  heartbeatAgeMs,
  isHeartbeatStale,
  respawnDelayMs,
  DEFAULT_STALE_THRESHOLD_MS,
  FAST_FAILURE_THRESHOLD_MS,
} from '../../src/watchdog-core.js'

describe('parseHeartbeat', () => {
  it('parse une sentinelle valide', () => {
    const r = parseHeartbeat(JSON.stringify({ heartbeat: '2026-07-21T10:00:00.000Z', pid: 1234 }))
    expect(r).toEqual({ heartbeat: '2026-07-21T10:00:00.000Z', pid: 1234 })
  })

  it('rejette un JSON invalide sans lever', () => {
    expect(parseHeartbeat('{ pas du json')).toBeNull()
  })

  it('rejette un objet sans champ heartbeat', () => {
    expect(parseHeartbeat(JSON.stringify({ pid: 1 }))).toBeNull()
  })

  it('rejette un objet sans champ pid', () => {
    expect(parseHeartbeat(JSON.stringify({ heartbeat: '2026-07-21T10:00:00.000Z' }))).toBeNull()
  })

  it('rejette une date heartbeat invalide', () => {
    expect(parseHeartbeat(JSON.stringify({ heartbeat: 'pas-une-date', pid: 1 }))).toBeNull()
  })
})

describe('heartbeatAgeMs', () => {
  const now = Date.parse('2026-07-21T10:01:00.000Z')

  it('sentinelle absente (null) → Infinity, jamais frais par défaut', () => {
    expect(heartbeatAgeMs(null, now)).toBe(Infinity)
  })

  it('sentinelle illisible/corrompue → Infinity', () => {
    expect(heartbeatAgeMs('pas du json', now)).toBe(Infinity)
  })

  it('calcule l’écart réel en ms', () => {
    const raw = JSON.stringify({ heartbeat: '2026-07-21T10:00:00.000Z', pid: 1 })
    expect(heartbeatAgeMs(raw, now)).toBe(60_000)
  })

  it('heartbeat futur (horloge décalée) → âge négatif, jamais périmé', () => {
    const raw = JSON.stringify({ heartbeat: '2026-07-21T10:02:00.000Z', pid: 1 })
    expect(heartbeatAgeMs(raw, now)).toBeLessThan(0)
  })
})

describe('isHeartbeatStale', () => {
  it('frais (< seuil) → pas périmé', () => {
    expect(isHeartbeatStale(30_000, DEFAULT_STALE_THRESHOLD_MS)).toBe(false)
  })

  it('exactement au seuil → pas encore périmé (strictement >)', () => {
    expect(isHeartbeatStale(DEFAULT_STALE_THRESHOLD_MS, DEFAULT_STALE_THRESHOLD_MS)).toBe(false)
  })

  it('au-delà du seuil → périmé', () => {
    expect(isHeartbeatStale(DEFAULT_STALE_THRESHOLD_MS + 1, DEFAULT_STALE_THRESHOLD_MS)).toBe(true)
  })

  it('Infinity (sentinelle absente) → toujours périmé', () => {
    expect(isHeartbeatStale(Infinity, DEFAULT_STALE_THRESHOLD_MS)).toBe(true)
  })

  it('seuil custom respecté', () => {
    expect(isHeartbeatStale(5_000, 10_000)).toBe(false)
    expect(isHeartbeatStale(15_000, 10_000)).toBe(true)
  })
})

describe('respawnDelayMs — anti-tempête de relances', () => {
  it('0 échec rapide consécutif → délai de base', () => {
    expect(respawnDelayMs(0, 3_000, 60_000)).toBe(3_000)
  })

  it('grandit avec les échecs rapides consécutifs', () => {
    expect(respawnDelayMs(1, 3_000, 60_000)).toBe(6_000)
    expect(respawnDelayMs(2, 3_000, 60_000)).toBe(9_000)
  })

  it('borné au maximum (pas de croissance infinie)', () => {
    expect(respawnDelayMs(100, 3_000, 60_000)).toBe(60_000)
  })
})

describe('FAST_FAILURE_THRESHOLD_MS — cohérence des constantes', () => {
  it('reste strictement inférieur au seuil de heartbeat périmé (sinon un cycle sain se ferait passer pour un échec rapide)', () => {
    expect(FAST_FAILURE_THRESHOLD_MS).toBeLessThan(DEFAULT_STALE_THRESHOLD_MS)
  })
})
