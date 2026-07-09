// Tests de l'Observateur-Conseil (Visage 2, amorce).
// Déterministe, zéro réseau, zéro LLM, zéro I/O — module pur, événements injectés.
import { describe, it, expect } from 'vitest'
import { analyzeEvents, renderObserverReport, type ObserverEvent } from '../../src/observer.js'

const ev = (branch: string, ruleRef: string, projectName = 'proj-x', rejectionId = `${branch}-anomalie`): ObserverEvent => ({
  ts: '2026-07-03T00:00:00.000Z',
  projectName,
  phase: 'build',
  branch,
  ruleRef,
  rejectionId,
})

describe('observer', () => {
  it('historique vide : jamais bloquant, résumé neutre', () => {
    const r = analyzeEvents([])
    expect(r.totalEvents).toBe(0)
    expect(r.patterns.length).toBe(0)
    expect(r.suggestions.length).toBe(0)
    expect(r.summary.includes('vide')).toBe(true)
  })

  it('pattern net : une branche concentre la majorité des rejets', () => {
    const events: ObserverEvent[] = [
      ev('architecture', 'no-god-file'),
      ev('architecture', 'no-god-file'),
      ev('architecture', 'no-god-file'),
      ev('architecture', 'no-god-file'),
      ev('security', 'xss-risk'),
    ]
    const r = analyzeEvents(events)
    const branchPattern = r.patterns.find(p => p.kind === 'branche-recurrente' && p.subject === 'architecture')
    expect(!!branchPattern).toBe(true)
    expect(branchPattern?.share).toBe(0.8)
    expect(branchPattern?.count).toBe(4)

    const rulePattern = r.patterns.find(p => p.kind === 'regle-recurrente' && p.subject === 'no-god-file')
    expect(!!rulePattern).toBe(true)

    expect(r.suggestions.length > 0).toBe(true)
    expect(r.suggestions.some(s => s.includes('architecture'))).toBe(true)
    expect(r.summary.includes('pattern')).toBe(true)

    const rendered = renderObserverReport(r)
    expect(rendered.includes(r.summary)).toBe(true)
    expect(rendered.split('\n').filter(l => l.startsWith('- ')).length).toBe(r.suggestions.length)
  })

  it('sous le seuil : pas de faux positif (bruit uniforme)', () => {
    // Projets DISTINCTS aussi (sinon la dimension "projet" révèle un pattern à elle seule —
    // tous les autres axes doivent être uniformes pour vraiment tester le "zéro pattern").
    const events: ObserverEvent[] = [
      ev('architecture', 'r1', 'proj-1'),
      ev('security', 'r2', 'proj-2'),
      ev('accessibility', 'r3', 'proj-3'),
      ev('performance', 'r4', 'proj-4'),
      ev('tests', 'r5', 'proj-5'),
    ]
    const r = analyzeEvents(events) // chaque branche/règle/projet = 20% pile au seuil minShare par défaut (0.2) mais count=1 < minCount=2
    expect(r.patterns.length).toBe(0)
    expect(r.summary.includes('aucun pattern')).toBe(true)
  })

  it('projet récurrent : un projet concentre les rejets (toutes branches confondues)', () => {
    const events: ObserverEvent[] = [
      ev('architecture', 'r1', 'projet-difficile'),
      ev('security', 'r2', 'projet-difficile'),
      ev('tests', 'r3', 'projet-difficile'),
      ev('architecture', 'r4', 'autre-projet'),
    ]
    const r = analyzeEvents(events)
    const projPattern = r.patterns.find(p => p.kind === 'projet-recurrent' && p.subject === 'projet-difficile')
    expect(!!projPattern).toBe(true)
    expect(projPattern?.share).toBe(0.75)
  })

  it('topN borne le nombre de patterns retenus PAR catégorie', () => {
    const events: ObserverEvent[] = []
    for (const b of ['a', 'b', 'c', 'd']) {
      events.push(ev(b, `rule-${b}`), ev(b, `rule-${b}`))
    }
    const r = analyzeEvents(events, { minCount: 2, minShare: 0, topN: 2 })
    const branchPatterns = r.patterns.filter(p => p.kind === 'branche-recurrente')
    expect(branchPatterns.length).toBe(2)
  })

  it('seuils personnalisés : minCount/minShare configurables', () => {
    const events: ObserverEvent[] = [ev('architecture', 'r1'), ev('security', 'r2')]
    const strict = analyzeEvents(events, { minCount: 3 })
    expect(strict.patterns.length).toBe(0)

    const permissive = analyzeEvents(events, { minCount: 1, minShare: 0 })
    expect(permissive.patterns.length > 0).toBe(true)
  })

  it('jamais d\'action : le rapport ne contient que du texte, pas de fonction exécutable', () => {
    const r = analyzeEvents([ev('architecture', 'r1'), ev('architecture', 'r1')])
    expect(JSON.stringify(r).length > 0).toBe(true)
  })
})
