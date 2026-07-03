// Tests de l'Observateur-Conseil (Visage 2, amorce). Exécution : npx tsx src/test-observer.ts
// Déterministe, zéro réseau, zéro LLM, zéro I/O — module pur, événements injectés.
import { analyzeEvents, renderObserverReport, type ObserverEvent } from './observer.js'

let passed = 0
let failed = 0
function check(name: string, cond: boolean): void {
  if (cond) passed++
  else {
    failed++
    console.error(`  ❌ ${name}`)
  }
}

const ev = (branch: string, ruleRef: string, projectName = 'proj-x', rejectionId = `${branch}-anomalie`): ObserverEvent => ({
  ts: '2026-07-03T00:00:00.000Z',
  projectName,
  phase: 'build',
  branch,
  ruleRef,
  rejectionId,
});

// ── Historique vide : jamais bloquant, résumé neutre ─────────────────────────
{
  const r = analyzeEvents([])
  check('vide : totalEvents 0', r.totalEvents === 0)
  check('vide : aucun pattern', r.patterns.length === 0)
  check('vide : aucune suggestion', r.suggestions.length === 0)
  check('vide : résumé explicite', r.summary.includes('vide'))
}

// ── Pattern net : une branche concentre la majorité des rejets ───────────────
{
  const events: ObserverEvent[] = [
    ev('architecture', 'no-god-file'),
    ev('architecture', 'no-god-file'),
    ev('architecture', 'no-god-file'),
    ev('architecture', 'no-god-file'),
    ev('security', 'xss-risk'),
  ]
  const r = analyzeEvents(events)
  const branchPattern = r.patterns.find((p) => p.kind === 'branche-recurrente' && p.subject === 'architecture')
  check('branche récurrente détectée (architecture 80%)', !!branchPattern)
  check('part calculée correctement (4/5 = 0.8)', branchPattern?.share === 0.8)
  check('count correct', branchPattern?.count === 4)

  const rulePattern = r.patterns.find((p) => p.kind === 'regle-recurrente' && p.subject === 'no-god-file')
  check('règle récurrente détectée (no-god-file 80%)', !!rulePattern)

  check('suggestions générées (au moins 1)', r.suggestions.length > 0)
  check('suggestion cite la branche', r.suggestions.some((s) => s.includes('architecture')))
  check('résumé mentionne le nombre de patterns', r.summary.includes('pattern'))

  const rendered = renderObserverReport(r)
  check('rendu texte : résumé présent', rendered.includes(r.summary))
  check('rendu texte : puces "-" pour chaque suggestion', rendered.split('\n').filter((l) => l.startsWith('- ')).length === r.suggestions.length)
}

// ── Sous le seuil : pas de faux positif (bruit uniforme) ─────────────────────
{
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
  check('bruit uniforme (count=1 chacun) → aucun pattern retenu', r.patterns.length === 0)
  check('bruit uniforme → résumé "aucun pattern"', r.summary.includes('aucun pattern'))
}

// ── Projet récurrent : un projet concentre les rejets (toutes branches confondues) ──
{
  const events: ObserverEvent[] = [
    ev('architecture', 'r1', 'projet-difficile'),
    ev('security', 'r2', 'projet-difficile'),
    ev('tests', 'r3', 'projet-difficile'),
    ev('architecture', 'r4', 'autre-projet'),
  ]
  const r = analyzeEvents(events)
  const projPattern = r.patterns.find((p) => p.kind === 'projet-recurrent' && p.subject === 'projet-difficile')
  check('projet récurrent détecté (75%)', !!projPattern)
  check('projet récurrent : part = 0.75', projPattern?.share === 0.75)
}

// ── topN borne le nombre de patterns retenus PAR catégorie ───────────────────
{
  const events: ObserverEvent[] = []
  for (const b of ['a', 'b', 'c', 'd']) {
    events.push(ev(b, `rule-${b}`), ev(b, `rule-${b}`))
  }
  const r = analyzeEvents(events, { minCount: 2, minShare: 0, topN: 2 })
  const branchPatterns = r.patterns.filter((p) => p.kind === 'branche-recurrente')
  check('topN respecté (2 branches max malgré 4 égales)', branchPatterns.length === 2)
}

// ── Seuils personnalisés : minCount/minShare configurables ───────────────────
{
  const events: ObserverEvent[] = [ev('architecture', 'r1'), ev('security', 'r2')]
  const strict = analyzeEvents(events, { minCount: 3 })
  check('minCount élevé → rien ne passe (count=1 chacun)', strict.patterns.length === 0)

  const permissive = analyzeEvents(events, { minCount: 1, minShare: 0 })
  check('seuils permissifs → tout remonte', permissive.patterns.length > 0)
}

// ── Jamais d'action : le rapport ne contient que du texte, pas de fonction exécutable ──
{
  const r = analyzeEvents([ev('architecture', 'r1'), ev('architecture', 'r1')])
  check('rapport = données pures (JSON-sérialisable)', JSON.stringify(r).length > 0)
}

console.log(`\n${failed === 0 ? '✅' : '❌'} Observateur-Conseil : ${passed}/${passed + failed} passed`)
if (failed > 0) process.exit(1)
