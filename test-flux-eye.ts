// Tests de l'Auditeur de Flux (Tier 0 déterministe). Exécution : npx tsx test-flux-eye.ts
// Déterministe, zéro réseau, zéro LLM. Logique pure ; runner avec deps injectées.
import { findStateMachines, buildGraph } from './src/flux-eye/graph.js'
import { inspectFlux } from './src/flux-eye/eye.js'
import { inspectProjectFlux, runFluxEye } from './src/flux-eye/runner.js'
import { initFluxParser } from './src/flux-eye/parser.js'
import type { ProjectFile } from './src/types.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Le moteur AST (tree-sitter/WASM) se pré-charge une fois ; `buildGraph` reste sync.
await initFluxParser()

let passed = 0
let failed = 0
function check(name: string, cond: boolean): void {
  if (cond) passed++
  else {
    failed++
    console.error(`  ❌ ${name}`)
  }
}
// Le « ; » final est REQUIS : sans lui, le parseur TS colle le bloc « { » suivant
// au corps de l'arrow function (TS1005) — les blocs autonomes de test suivent.
const F = (p: string, content: string): ProjectFile => ({ path: p, content });

// ── Auto-découverte de la machine à états de nav ─────────────────────────────
{
  const src = `const [screen, setScreen] = useState("home"); setScreen("x")`
  const m = findStateMachines(src)
  check('machine détectée', m.length === 1)
  check('state = screen', m[0]?.state === 'screen')
  check('setter = setScreen', m[0]?.setter === 'setScreen')
  check('init = home', m[0]?.init === 'home')

  // useState sans setter appelé avec littéral ⇒ pas une machine de nav.
  check('useState non-nav ignoré', findStateMachines(`const [n, setN] = useState("x"); setN(count + 1)`).length === 0)

  // Nom de variable quelconque (app générée) — auto-découverte.
  const m2 = findStateMachines(`const [page, setPage] = useState("accueil"); setPage("détail")`)
  check('variable non-"screen" découverte', m2[0]?.state === 'page' && m2[0]?.init === 'accueil')
}

// ── Construction du graphe (état + fenêtres) ─────────────────────────────────
{
  const files = [
    F('App.jsx', `
      const [screen, setScreen] = useState("home");
      if (screen === "home") return <Home/>;
      if (screen === "settings") return <Settings onBack={() => setScreen("home")}/>;
      <button onClick={() => setScreen("settings")}>go</button>
      openWindow({ type: "projects", title: "P" });
    `),
    F('WindowManager.jsx', `
      if (win.type === "projects") return <Projects/>;
    `),
  ]
  const g = buildGraph(files)
  check('entrée = home', g.entries.includes('home') && g.entries.length === 1)
  check('écrans rendus', g.screensRendered.includes('home') && g.screensRendered.includes('settings'))
  check('cibles écran', g.screenTargets.some(e => e.target === 'settings'))
  check('fenêtre rendue', g.windowsRendered.includes('projects'))
  check('cible fenêtre', g.windowTargets.some(e => e.target === 'projects'))
}

// ── Moteur AST (#140-#3) : code BIEN FORMÉ → vrai arbre syntaxique ───────────
// Prouve la valeur de l'AST : un `setScreen(...)` en COMMENTAIRE (ou dans une string)
// n'est PAS une cible — là où le regex produisait un faux positif « fantôme ».
{
  const files = [
    F('App.tsx', `
      function App() {
        const [screen, setScreen] = useState("home");
        // setScreen("ghostcomment") — en commentaire, ne doit PAS compter comme cible
        if (screen === "home") return <Home onGo={() => setScreen("about")} />;
        if (screen === "about") return <About onBack={() => setScreen("home")} />;
        return null;
      }
    `),
  ]
  const g = buildGraph(files)
  check('AST : écrans rendus home+about', g.screensRendered.includes('home') && g.screensRendered.includes('about'))
  check('AST : cible "about" captée', g.screenTargets.some(e => e.target === 'about'))
  check('AST : commentaire ignoré (pas de cible "ghostcomment")', g.screenTargets.every(e => e.target !== 'ghostcomment'))
  check('AST : graphe sain (le commentaire n\'est pas un fantôme) → measured 0', inspectFlux(g).counts.measured === 0)
}

// ── Résolution de constantes (#140-#3 bonus) : WINDOWS.SUITE → "suite" ───────
// Depuis #140-#2, la nav s'écrit `WINDOWS.SUITE` / `SCREENS.X`, pas `"suite"`. L'AST
// résout ces membres via une table des symboles — la regex en serait incapable.
{
  const files = [
    F('nav.js', `
      export const SCREENS = Object.freeze({ HOME: "home", DETAIL: "detail" });
      export const WINDOWS = Object.freeze({ SUITE: "suite", PROJECTS: "projects" });
    `),
    F('App.jsx', `
      import { SCREENS, WINDOWS } from "./nav.js";
      const [screen, setScreen] = useState(SCREENS.HOME);
      if (screen === SCREENS.HOME) return <Home onGo={() => setScreen(SCREENS.DETAIL)} />;
      if (screen === SCREENS.DETAIL) return <Detail onBack={() => setScreen(SCREENS.HOME)} />;
      openWindow({ type: WINDOWS.SUITE });
      openWindow({ type: WINDOWS.PROJECTS });
    `),
    F('WindowManager.jsx', `
      import { WINDOWS } from "./nav.js";
      if (win.type === WINDOWS.SUITE) return <Suite/>;
      if (win.type === WINDOWS.PROJECTS) return <Projects/>;
    `),
  ]
  const g = buildGraph(files)
  // L'init useState(SCREENS.HOME) est résolu → entrée "home".
  check('const : entrée résolue depuis SCREENS.HOME', g.entries.includes('home') && g.entries.length === 1)
  // La machine est retenue alors que setScreen n'est appelé QU'avec des constantes.
  check('const : écrans rendus home+detail (via SCREENS.X)', g.screensRendered.includes('home') && g.screensRendered.includes('detail'))
  check('const : cible "detail" résolue (setScreen(SCREENS.DETAIL))', g.screenTargets.some(e => e.target === 'detail'))
  // Fenêtres : rendu (win.type === WINDOWS.X) ET cible (openWindow type: WINDOWS.X) résolus.
  check('const : fenêtres rendues suite+projects (via WINDOWS.X)', g.windowsRendered.includes('suite') && g.windowsRendered.includes('projects'))
  check('const : cible fenêtre "suite" résolue', g.windowTargets.some(e => e.target === 'suite'))
  // Le payoff : tout est réconcilié → ZÉRO fantôme (avant la résolution : 2 faux fantômes).
  check('const : zéro fantôme (cibles réconciliées avec les rendus)', inspectFlux(g).counts.measured === 0)
}

// ── Robustesse AST : erreur JSX bénigne profonde + ouvreur en appel de méthode ─
// Deux régressions réelles attrapées sur le cockpit : (a) un `&` brut dans du texte JSX
// (valide en React) flague tout le fichier `hasError` — il ne doit PAS jeter le fichier
// vers le regex (qui raterait les rendus `WINDOWS.X`) ; (b) les ouvreurs sont souvent des
// appels de MÉTHODE `a.onOpenWindow?.({type: WINDOWS.X})`, pas un identifiant nu.
{
  const files = [
    F('nav.js', `export const WINDOWS = Object.freeze({ SUITE: "suite" });`),
    F('App.jsx', `
      import { WINDOWS } from "./nav.js";
      function App({ api }) {
        return <button onClick={() => api.onOpenWindow?.({ type: WINDOWS.SUITE })}>Créer & construire</button>;
      }
    `),
    F('WindowManager.jsx', `
      import { WINDOWS } from "./nav.js";
      function WM({ win }) {
        // le '&' ci-dessous (Créer & construire) met le fichier en hasError sans casser la structure
        if (win.type === WINDOWS.SUITE) return <div>Créer & construire</div>;
        return null;
      }
    `),
  ]
  const g = buildGraph(files)
  check('robustesse : rendu capté malgré un & bénin (erreur profonde, pas top-level)', g.windowsRendered.includes('suite'))
  check('robustesse : ouvreur en méthode a.onOpenWindow?.(…) capté', g.windowTargets.some(e => e.target === 'suite'))
  check('robustesse : zéro fantôme (rendu ↔ cible réconciliés)', inspectFlux(g).counts.measured === 0)
}

// ── R3 : écran fantôme (le bug réel #136 « chat ») ───────────────────────────
{
  const files = [
    F('App.jsx', `
      const [screen, setScreen] = useState("home");
      if (screen === "home") return <Home/>;
      <button onClick={() => setScreen("chat")}>chat</button>
    `),
  ]
  const obs = inspectFlux(buildGraph(files))
  // Cible d'état sans rendu dédié ⇒ CONVERGENCE (ambigu : peut retomber sur un else).
  check('R3 chat → convergence (pas erreur)', obs.convergence.some(q => q.includes('chat')))
  check('R3 chat pas en measured (état = souple)', obs.measured.phantomTargets.every(p => p.target !== 'chat'))
}

// ── R3 dur : fenêtre fantôme (surface SANS fallback ⇒ fait mesuré) ───────────
{
  const files = [
    F('App.jsx', `openWindow({ type: "ghostwin" });`),
    F('WM.jsx', `if (win.type === "projects") return <P/>;`),
  ]
  const obs = inspectFlux(buildGraph(files))
  check('R3 fenêtre fantôme → measured', obs.measured.phantomTargets.some(p => p.target === 'ghostwin' && p.kind === 'window'))
}

// ── R5 : surface inatteignable ───────────────────────────────────────────────
{
  const files = [
    F('App.jsx', `
      const [screen, setScreen] = useState("home");
      if (screen === "home") return <Home onBack={() => setScreen("home")}/>;
      if (screen === "lonely") return <Lonely/>;
      openWindow({ type: "projects" });
    `),
    F('WM.jsx', `
      if (win.type === "projects") return <P/>;
      if (win.type === "orphanwin") return <O/>;
    `),
  ]
  const obs = inspectFlux(buildGraph(files))
  check('R5 écran inatteignable (suspect)', obs.suspects.unreachable.some(u => u.id === 'lonely' && u.kind === 'screen'))
  check('R5 fenêtre inatteignable (suspect)', obs.suspects.unreachable.some(u => u.id === 'orphanwin' && u.kind === 'window'))
  check('home (entrée) jamais inatteignable', obs.suspects.unreachable.every(u => u.id !== 'home'))
  check('R5 → convergence (souple, pas measured)', obs.convergence.some(q => q.includes('jamais ciblée')) && obs.counts.measured === 0)
}

// ── Routes (react-router) + attrape-tout ─────────────────────────────────────
{
  const phantom = inspectFlux(buildGraph([
    F('Router.jsx', `<Route path="/home" element={<H/>}/> <Link to="/ghost">x</Link>`),
  ]))
  check('route fantôme (sans catch-all) → measured', phantom.measured.phantomTargets.some(p => p.target === '/ghost' && p.kind === 'route'))

  const withCatchAll = inspectFlux(buildGraph([
    F('Router.jsx', `<Route path="/home" element={<H/>}/> <Route path="*" element={<NF/>}/> <Link to="/ghost">x</Link>`),
  ]))
  check('route fantôme supprimée si catch-all', withCatchAll.measured.phantomTargets.every(p => p.kind !== 'route'))
}

// ── R2 : sur-duplication (≥3 sources) → convergence ──────────────────────────
{
  const files = [
    F('a.jsx', `setScreen("dash")`),
    F('b.jsx', `setScreen("dash")`),
    F('c.jsx', `setScreen("dash")`),
    F('App.jsx', `const [screen, setScreen] = useState("home"); if (screen === "dash") return <D/>;`),
  ]
  const obs = inspectFlux(buildGraph(files))
  check('R2 doublon ≥3 → convergence', obs.convergence.some(q => q.includes('dash')))
}

// ── Invariant : ne bloque JAMAIS · graphe sain = zéro mesuré ─────────────────
{
  const healthy = inspectFlux(buildGraph([
    F('App.jsx', `
      const [screen, setScreen] = useState("home");
      if (screen === "home") return <Home onGo={() => setScreen("about")}/>;
      if (screen === "about") return <About onBack={() => setScreen("home")}/>;
    `),
  ]))
  check('graphe sain → measured 0', healthy.counts.measured === 0)
  check('invariant blocking:false (sain)', healthy.blocking === false)
  check('summary sain explicite', healthy.summary.includes('cohérente'))

  const broken = inspectFlux(buildGraph([F('x.jsx', `openWindow({type:"ghost"})`)]))
  check('invariant blocking:false (cassé)', broken.blocking === false)
}

// ── Runner : fail-open (écriture qui throw n'arrête rien) ─────────────────────
{
  const files = [F('App.jsx', `openWindow({type:"ghost"})`)]
  let threw = false
  let obs
  try {
    obs = runFluxEye(path.join(os.tmpdir(), 'flux-noexist-' + process.pid), {
      readSource: () => files,
      writeFile: () => { throw new Error('disque plein') },
      now: () => 0,
    })
  } catch {
    threw = true
  }
  check('runner fail-open (ne throw pas)', !threw)
  check('runner renvoie quand même le rapport', obs?.measured.phantomTargets.length === 1)

  // Écriture réelle (deps par défaut) dans un tmp → fichier présent.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxeye-'))
  const written = runFluxEye(tmp, { readSource: () => files, now: () => 123 })
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, '.mangoqa', 'flux-observations.json'), 'utf8'))
  check('observations écrites sur disque', onDisk.blocking === false && onDisk.observedAt === 123)
  check('inspectProjectFlux cohérent avec runner', written.counts.measured === inspectProjectFlux(files).counts.measured)
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? '✅' : '❌'} Auditeur de Flux : ${passed}/${passed + failed} passed`)
if (failed > 0) process.exit(1)
