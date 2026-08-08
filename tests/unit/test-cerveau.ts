// Choix du cerveau d'audit (`QA_BRAIN`) — déterministe, zéro réseau.
//
// Décision de cadrage du 2026-08-05 : le cerveau est un CHOIX de l'utilisateur, et
// Claude peut être PRIMAIRE. Ce qui est gelé ici n'est pas la préférence (elle
// bougera) mais les invariants qui la rendent sûre :
//   • un cerveau inconnu ne devient jamais une erreur silencieuse ;
//   • Claude en primaire n'a PAS de repli — se rabattre sur un modèle plus faible
//     rendrait un verdict de moindre qualité sans le déclarer ;
//   • `QA_LOCAL_ONLY=on` + `--cerveau claude` est une contradiction REFUSÉE, jamais
//     arbitrée en silence : l'un promet que rien ne sort, l'autre fait sortir.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cerveauPrimaire, askLLM, CERVEAUX } from '../../src/llm.js'
import { parseArgs } from '../../src/cli.js'

const initial = { ...process.env }
afterEach(() => {
  process.env = { ...initial }
})

describe('cerveauPrimaire — lecture de QA_BRAIN', () => {
  it('défaut : ollama (comportement historique préservé pour MangoOS et les évals)', () => {
    delete process.env.QA_BRAIN
    expect(cerveauPrimaire()).toBe('ollama')
  })

  it('accepte les deux cerveaux, insensible à la casse et aux espaces', () => {
    for (const c of CERVEAUX) {
      process.env.QA_BRAIN = `  ${c.toUpperCase()} `
      expect(cerveauPrimaire()).toBe(c)
    }
  })

  it('valeur inconnue → repli sur ollama, jamais un plantage', () => {
    process.env.QA_BRAIN = 'gpt-maison'
    expect(cerveauPrimaire()).toBe('ollama')
  })
})

describe('askLLM — routage selon le cerveau', () => {
  it('QA_BRAIN=ollama : Ollama en primaire, Claude en repli après épuisement', async () => {
    process.env.QA_BRAIN = 'ollama'
    const ask = vi.fn(async () => {
      throw new Error('Ollama injoignable')
    })
    const askFallback = vi.fn(async () => 'réponse claude')
    const r = await askLLM('sys', 'user', { ask, askFallback, sleep: async () => {}, retryAttempts: 1 })
    expect(r).toBe('réponse claude')
    expect(ask).toHaveBeenCalledTimes(2)
    expect(askFallback).toHaveBeenCalledTimes(1)
  })

  it('`deps.ask` reste prioritaire sur QA_BRAIN — sinon les tests partiraient sur le réseau', async () => {
    process.env.QA_BRAIN = 'claude'
    const ask = vi.fn(async () => 'réponse injectée')
    const askFallback = vi.fn(async () => 'ne doit pas être appelé')
    const r = await askLLM('sys', 'user', { ask, askFallback, sleep: async () => {} })
    expect(r).toBe('réponse injectée')
    expect(askFallback).not.toHaveBeenCalled()
  })
})

describe('CLI — options de cerveau', () => {
  const opts = (argv: string[]) => {
    const r = parseArgs(argv)
    if ('aide' in r) throw new Error('aide inattendue')
    if ('commande' in r) throw new Error('commande inattendue')
    return r
  }

  it('--cerveau accepte les cerveaux connus, refuse les autres en les nommant', () => {
    expect(opts(['.', '--cerveau', 'claude']).cerveau).toBe('claude')
    expect(opts(['.', '--cerveau', 'OLLAMA']).cerveau).toBe('ollama')
    expect(() => opts(['.', '--cerveau', 'gpt5'])).toThrow(/gpt5/)
  })

  it('--modele passe l\'identifiant tel quel (le modèle par défaut bougera, pas cette API)', () => {
    expect(opts(['.', '--modele', 'claude-opus-5']).modele).toBe('claude-opus-5')
  })

  it('QA_LOCAL_ONLY=on + --cerveau claude : REFUSÉ, avec les deux issues nommées', () => {
    process.env.QA_LOCAL_ONLY = 'on'
    expect(() => opts(['.', '--cerveau', 'claude'])).toThrow(/QA_LOCAL_ONLY/)
    expect(() => opts(['.', '--cerveau', 'claude'])).toThrow(/--cerveau ollama/)
  })

  it('QA_LOCAL_ONLY=on + --cerveau ollama : cohérent, accepté', () => {
    process.env.QA_LOCAL_ONLY = 'on'
    expect(opts(['.', '--cerveau', 'ollama']).cerveau).toBe('ollama')
  })
})
