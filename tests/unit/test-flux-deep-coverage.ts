// Couverture déclarée de l'Auditeur de Flux — Tier 1 (faille J2-b).
// Déterministe, zéro réseau : le cerveau est injecté et on inspecte le prompt reçu.
//
// Même garantie que pour les 6 branches, sur l'autre visage qui rend un payload borné :
// « un auditeur a le droit de ne pas tout lire ; il n'a pas le droit de le taire. »
// Avec une nuance propre à ce visage — le GRAPHE vient d'une analyse statique menée hors
// du payload, il reste donc fiable même quand le code est plafonné. Le dire évite de
// rendre l'auditeur muet là où il devait être prudent.
import { describe, it, expect } from 'vitest'
import { auditFluxDeep, DEFAULT_FLUX_PAYLOAD_CAP } from '../../src/flux-eye/deep.js'
import type { NavGraph } from '../../src/flux-eye/graph.js'
import type { FluxObservation } from '../../src/flux-eye/eye.js'
import type { PhaseSignal, ProjectFile } from '../../src/types.js'

const GRAPH: NavGraph = {
  entries: ['App'],
  screensRendered: ['Accueil', 'Reglages'],
  windowsRendered: [],
  routesRendered: ['/', '/reglages'],
  screenTargets: [
    { target: 'Accueil', from: 'App' },
    { target: 'Reglages', from: 'Accueil' },
  ],
  windowTargets: [],
  routeTargets: [
    { target: '/', from: 'App' },
    { target: '/reglages', from: 'Accueil' },
  ],
  hasCatchAllRoute: false,
}

const TIER0 = {
  summary: '2 surfaces, aucune cible fantome.',
  convergence: [],
  measured: { phantomTargets: [] },
} as unknown as FluxObservation

const SIGNAL: PhaseSignal = {
  projectName: 'projet-flux',
  phase: 'audit',
  timestamp: '2026-08-05T00:00:00.000Z',
  projectDir: '/p',
  changedFiles: [],
  retryCount: 0,
}

function spyBrain(response = JSON.stringify({ findings: [], summary: 'Flux coherent.' })) {
  const prompts: string[] = []
  return {
    prompts,
    askLLM: async (_s: string, user: string): Promise<string> => {
      prompts.push(user)
      return response
    },
  }
}

/** Assez de code pour déborder largement le cap de ce visage (20 000 par défaut). */
function gros(n: number): ProjectFile[] {
  return Array.from({ length: n }, (_, i) => ({ path: `src/ecran${i}.jsx`, content: 'x'.repeat(5_000) }))
}

const petit: ProjectFile[] = [{ path: 'src/App.jsx', content: 'export default function App() { return null }' }]

describe('auditFluxDeep — couverture déclarée (J2-b)', () => {
  it('lecture partielle : le prompt annonce le ratio et nomme les fichiers non fournis', async () => {
    const brain = spyBrain()
    await auditFluxDeep(GRAPH, TIER0, gros(20), SIGNAL, { askLLM: brain.askLLM })
    const p = brain.prompts[0]
    expect(p).toContain('COUVERTURE DE CETTE LECTURE')
    expect(p).toMatch(/tu ne vois que \d+ des 20 fichiers pertinents/)
    expect(p).toContain('Fichiers NON fournis')
  })

  it('le GRAPHE reste déclaré FIABLE malgré la lecture partielle (il vient d\'une analyse hors payload)', async () => {
    const brain = spyBrain()
    await auditFluxDeep(GRAPH, TIER0, gros(20), SIGNAL, { askLLM: brain.askLLM })
    const p = brain.prompts[0]
    expect(p).toContain('EXCEPTION : un GRAPHE DE NAVIGATION / FAIT DU TIER 0')
    // La consigne est celle du VOCABULAIRE de ce visage : il rend des observations,
    // jamais un "fail" — un texte parlant de "fail" ici serait un copier-coller mal relu.
    expect(p).toContain('Ne signale une observation que sur ce qui est VISIBLE')
    expect(p).not.toContain('"fail"')
  })

  it('le bloc couverture est placé AVANT le code, pas après (on prévient, on ne rattrape pas)', async () => {
    const brain = spyBrain()
    await auditFluxDeep(GRAPH, TIER0, gros(20), SIGNAL, { askLLM: brain.askLLM })
    const p = brain.prompts[0]
    expect(p.indexOf('COUVERTURE DE CETTE LECTURE')).toBeLessThan(p.indexOf('CODE PERTINENT'))
  })

  it('couverture complète : AUCUN bloc, prompt inchangé vs avant la mesure', async () => {
    const brain = spyBrain()
    await auditFluxDeep(GRAPH, TIER0, petit, SIGNAL, { askLLM: brain.askLLM })
    expect(brain.prompts[0]).not.toContain('COUVERTURE DE CETTE LECTURE')
  })

  it('l\'observation porte la couverture — le fichier .json écrit ne peut plus mentir', async () => {
    const brain = spyBrain()
    const obs = await auditFluxDeep(GRAPH, TIER0, gros(20), SIGNAL, { askLLM: brain.askLLM })
    expect(obs.coverage).toBeDefined()
    expect(obs.coverage!.complete).toBe(false)
    expect(obs.coverage!.filesTotal).toBe(20)
    expect(obs.coverage!.filesRendered).toBeLessThan(20)
  })

  it('« Flux coherent » sur lecture partielle le DIT dans le résumé, pas seulement dans le champ', async () => {
    const brain = spyBrain(JSON.stringify({ findings: [], summary: 'Flux coherent.' }))
    const obs = await auditFluxDeep(GRAPH, TIER0, gros(20), SIGNAL, { askLLM: brain.askLLM })
    expect(obs.summary).toMatch(/\[lecture partielle : \d+\/20 fichiers lus\]/)
  })

  it('couverture complète : résumé intact, aucune mention parasite', async () => {
    const brain = spyBrain(JSON.stringify({ findings: [], summary: 'Flux coherent.' }))
    const obs = await auditFluxDeep(GRAPH, TIER0, petit, SIGNAL, { askLLM: brain.askLLM })
    expect(obs.summary).toBe('Flux coherent.')
  })

  it('réponse illisible ET cerveau qui lève : couverture toujours déclarée, et JAMAIS bloquant', async () => {
    const illisible = await auditFluxDeep(GRAPH, TIER0, gros(20), SIGNAL, {
      askLLM: async () => 'pas du json',
    })
    expect(illisible.ran).toBe(false)
    expect(illisible.coverage).toBeDefined()
    expect(illisible.blocking).toBe(false)

    const casse = await auditFluxDeep(GRAPH, TIER0, gros(20), SIGNAL, {
      askLLM: async () => {
        throw new Error('Ollama injoignable')
      },
    })
    expect(casse.coverage).toBeDefined()
    // L'invariant grave de ce visage : conseil, jamais bloquant. Aucune des voies de
    // sortie ne doit pouvoir le violer, y compris celles ajoutées avec la couverture.
    expect(casse.blocking).toBe(false)
  })

  it('le cap reste à 20 000 par défaut — relever sans mesure serait refaire l\'erreur inverse', () => {
    expect(DEFAULT_FLUX_PAYLOAD_CAP).toBe(20_000)
  })

  it('FLUX_DEEP_PAYLOAD_CAP permet de le relever explicitement', async () => {
    const brain = spyBrain()
    process.env.FLUX_DEEP_PAYLOAD_CAP = '200000'
    try {
      const obs = await auditFluxDeep(GRAPH, TIER0, gros(20), SIGNAL, { askLLM: brain.askLLM })
      expect(obs.coverage!.complete).toBe(true)
      expect(brain.prompts[0]).not.toContain('COUVERTURE DE CETTE LECTURE')
    } finally {
      delete process.env.FLUX_DEEP_PAYLOAD_CAP
    }
  })
})
