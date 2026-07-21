// Tests du retry/backoff Ollama avant repli Claude (limites.md L128).
// Déterministe, zéro réseau, zéro vrai délai (sleep injecté et compté, jamais attendu).
import { describe, it, expect, vi } from 'vitest'
import { askLLM } from '../../src/llm.js'

function noopSleep() {
  const calls: number[] = []
  const sleep = vi.fn(async (ms: number) => { calls.push(ms) })
  return { sleep, calls }
}

describe('askLLM — retry Ollama avant repli Claude', () => {
  it('succès du 1er coup → askFallback jamais appelé, zéro sleep', async () => {
    const ask = vi.fn(async () => 'réponse ollama')
    const askFallback = vi.fn(async () => 'réponse claude')
    const { sleep, calls } = noopSleep()
    const r = await askLLM('sys', 'user', { ask, askFallback, sleep })
    expect(r).toBe('réponse ollama')
    expect(ask).toHaveBeenCalledTimes(1)
    expect(askFallback).not.toHaveBeenCalled()
    expect(calls.length).toBe(0)
  })

  it('échec transitoire puis succès (2e tentative) → repli JAMAIS déclenché', async () => {
    let n = 0
    const ask = vi.fn(async () => {
      n++
      if (n === 1) throw new Error('ECONNRESET')
      return 'réponse ollama (2e essai)'
    })
    const askFallback = vi.fn(async () => 'réponse claude')
    const { sleep } = noopSleep()
    const r = await askLLM('sys', 'user', { ask, askFallback, sleep })
    expect(r).toBe('réponse ollama (2e essai)')
    expect(ask).toHaveBeenCalledTimes(2)
    expect(askFallback).not.toHaveBeenCalled()
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('3 échecs consécutifs (défaut) → repli Claude, backoff entre CHAQUE tentative Ollama', async () => {
    const ask = vi.fn(async () => { throw new Error('timeout') })
    const askFallback = vi.fn(async () => 'réponse claude (repli)')
    const { sleep, calls } = noopSleep()
    const r = await askLLM('sys', 'user', { ask, askFallback, sleep })
    expect(r).toBe('réponse claude (repli)')
    expect(ask).toHaveBeenCalledTimes(3) // 1 essai + 2 retries (OLLAMA_RETRY_ATTEMPTS par défaut)
    expect(askFallback).toHaveBeenCalledTimes(1)
    expect(calls.length).toBe(2) // backoff APRÈS l'essai 1 et l'essai 2, jamais après le dernier
  })

  it('retryAttempts=0 (override) → repli dès le 1er échec, comportement historique disponible', async () => {
    const ask = vi.fn(async () => { throw new Error('boom') })
    const askFallback = vi.fn(async () => 'réponse claude')
    const { sleep } = noopSleep()
    const r = await askLLM('sys', 'user', { ask, askFallback, sleep, retryAttempts: 0 })
    expect(r).toBe('réponse claude')
    expect(ask).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('les DEUX échouent (Ollama épuisé + Claude en erreur) → l’erreur remonte (ne masque jamais une double panne)', async () => {
    const ask = vi.fn(async () => { throw new Error('ollama down') })
    const askFallback = vi.fn(async () => { throw new Error('claude down aussi') })
    const { sleep } = noopSleep()
    await expect(askLLM('sys', 'user', { ask, askFallback, sleep, retryAttempts: 1 })).rejects.toThrow('claude down aussi')
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('retryDelayMs custom respecté', async () => {
    const ask = vi.fn(async () => { throw new Error('x') })
    const askFallback = vi.fn(async () => 'ok')
    const { sleep, calls } = noopSleep()
    await askLLM('sys', 'user', { ask, askFallback, sleep, retryAttempts: 1, retryDelayMs: 250 })
    expect(calls).toEqual([250])
  })
})
