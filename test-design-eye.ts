// Tests du Visage 3 — L'Œil Design. Exécution : npx tsx test-design-eye.ts
// Déterministe, zéro réseau, zéro LLM, zéro disque (runner avec writeFile injecté).
import {
  parseHex,
  relativeLuminance,
  contrastRatio,
  isLargeText,
  wcagLevel,
} from './src/design-eye/contrast.js'
import { normalizeHex, offPalette, offScale, offStep } from './src/design-eye/tokens.js'
import {
  inspectDesign,
  extractCssColors,
  extractContrastPairs,
  type DesignObservation,
} from './src/design-eye/eye.js'
import { extractDeclaredPalette, inspectProjectDesign, runDesignEye } from './src/design-eye/runner.js'

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
function near(a: number, b: number, eps = 0.05): boolean {
  return Math.abs(a - b) <= eps
}

// ── Contraste WCAG (la part RIGIDE, mesurable) ───────────────────────────────
{
  check('parseHex #fff', JSON.stringify(parseHex('#fff')) === JSON.stringify({ r: 255, g: 255, b: 255 }))
  check('parseHex #000000', JSON.stringify(parseHex('#000000')) === JSON.stringify({ r: 0, g: 0, b: 0 }))
  check('parseHex sans #', parseHex('7c5cff') !== null)
  check('parseHex invalide → null', parseHex('nope') === null)
  check('parseHex longueur invalide → null', parseHex('#12345') === null)

  check('luminance blanc = 1', near(relativeLuminance({ r: 255, g: 255, b: 255 }), 1))
  check('luminance noir = 0', near(relativeLuminance({ r: 0, g: 0, b: 0 }), 0))

  // Valeurs de référence WCAG connues.
  check('contraste noir/blanc = 21', contrastRatio('#000', '#fff') === 21)
  check('contraste blanc/blanc = 1', contrastRatio('#fff', '#fff') === 1)
  check('contraste symétrique', contrastRatio('#000', '#fff') === contrastRatio('#fff', '#000'))
  check('contraste hex invalide → null', contrastRatio('zzz', '#fff') === null)

  // Le violet signature MangoOS sur fond sombre.
  const r = contrastRatio('#7c5cff', '#0b0b12')
  check('violet/sombre mesuré > 1', r !== null && r > 1)

  check('grand texte : 24px', isLargeText(24) === true)
  check('grand texte : 18.66px gras', isLargeText(19, true) === true)
  check('petit texte : 16px', isLargeText(16) === false)
  check('petit texte : 20px non gras', isLargeText(20, false) === false)

  check('niveau AAA (21, normal)', wcagLevel(21, false) === 'AAA')
  check('niveau AA (4.5, normal)', wcagLevel(4.5, false) === 'AA')
  check('niveau fail (3, normal)', wcagLevel(3, false) === 'fail')
  check('niveau AA (3, grand)', wcagLevel(3, true) === 'AA')
  check('niveau fail (2.9, grand)', wcagLevel(2.9, true) === 'fail')
}

// ── Tokens (adhérence palette / échelle) ─────────────────────────────────────
{
  check('normalizeHex #ABC → #aabbcc', normalizeHex('#ABC') === '#aabbcc')
  check('offPalette détecte l’intrus', JSON.stringify(offPalette(['#fff', '#123456'], ['#ffffff'])) === JSON.stringify(['#123456']))
  check('offPalette robuste au format', offPalette(['#FFF'], ['#ffffff']).length === 0)
  check('offPalette vide si pas de palette', offPalette(['#abc'], []).length === 0)
  check('offScale hors échelle', JSON.stringify(offScale([8, 13], [4, 8, 12, 16])) === JSON.stringify([13]))
  check('offScale tolérance', offScale([13], [12], 1).length === 0)
  check('offScale vide si pas d’échelle', offScale([7], []).length === 0)
  check('offStep multiples de 4', JSON.stringify(offStep([4, 8, 10], 4)) === JSON.stringify([10]))
}

// ── Extraction CSS déterministe ──────────────────────────────────────────────
{
  const css = `
    :root { --bg: #0b0b12; --accent: #7c5cff; }
    .btn { color: #ffffff; background-color: #7c5cff; font-size: 16px; }
    .hero { color: #999; background: #aaa; font-size: 28px; font-weight: 700; }
  `
  const colors = extractCssColors(css)
  check('extractCssColors trouve les couleurs', colors.includes('#7c5cff') && colors.includes('#0b0b12'))
  check('extractCssColors déduplique', colors.filter(c => c === '#7c5cff').length === 1)

  const pairs = extractContrastPairs(css)
  check('extractContrastPairs : 2 paires', pairs.length === 2)
  const btn = pairs.find(p => p.where?.includes('.btn'))!
  check('paire .btn fg/bg', btn.fg === '#ffffff' && btn.bg === '#7c5cff')
  check('paire .btn taille', btn.fontPx === 16 && btn.bold === false)
  const hero = pairs.find(p => p.where?.includes('.hero'))!
  check('paire .hero gras + grand', hero.bold === true && hero.fontPx === 28)

  check('extractDeclaredPalette = variables CSS', JSON.stringify(extractDeclaredPalette(css)) === JSON.stringify(['#0b0b12', '#7c5cff']))
}

// ── L'Œil : jamais bloquant, sépare mesuré / convergence ─────────────────────
{
  // Contexte propre → rien à signaler.
  const clean = inspectDesign({
    palette: ['#0b0b12', '#7c5cff', '#ffffff'],
    usedColors: ['#0b0b12', '#7c5cff'],
    pairs: [{ fg: '#ffffff', bg: '#0b0b12', where: '.ok' }],
  })
  check('Œil propre → blocking false', clean.blocking === false)
  check('Œil propre → 0 mesuré', clean.counts.measured === 0)
  check('Œil propre → 0 convergence', clean.convergence.length === 0)
  check('Œil propre → summary positif', clean.summary.includes('OK'))

  // Contraste insuffisant mesuré.
  const lowContrast = inspectDesign({
    pairs: [{ fg: '#999999', bg: '#aaaaaa', fontPx: 16, where: '.faint' }],
  })
  check('Œil contraste faible → 1 mesuré', lowContrast.measured.contrast.length === 1)
  check('Œil contraste faible → blocking false', lowContrast.blocking === false)
  check('Œil contraste : seuil 4.5 (texte normal)', lowContrast.measured.contrast[0].required === 4.5)
  check('Œil contraste : niveau fail', lowContrast.measured.contrast[0].level === 'fail')

  // Grand texte → seuil abaissé à 3 ; une paire à 3.5 passe.
  const largeOk = inspectDesign({ pairs: [{ fg: '#777777', bg: '#ffffff', fontPx: 30 }] })
  check('Œil grand texte au-dessus de 3 → pas de fail', largeOk.measured.contrast.length === 0)

  // Hors palette → convergence (question, jamais erreur).
  const offPal = inspectDesign({ palette: ['#7c5cff'], usedColors: ['#7c5cff', '#ff0000'] })
  check('Œil hors palette → mesuré', offPal.measured.offPalette.length === 1)
  check('Œil hors palette → question de convergence', offPal.convergence.some(q => q.includes('voulu')))
  check('Œil hors palette → toujours blocking false', offPal.blocking === false)

  // Dérive vs cible Sharingan : couleur de la cible absente du rendu.
  const drift = inspectDesign({
    usedColors: ['#7c5cff'],
    brief: { palette: ['#7c5cff', '#00d4ff'] },
  })
  check('Œil dérive brief → #00d4ff manquant', JSON.stringify(drift.measured.briefDrift) === JSON.stringify(['#00d4ff']))
  check('Œil dérive brief → question Sharingan', drift.convergence.some(q => q.includes('Sharingan')))

  // Espacements hors pas de 4.
  const spacing = inspectDesign({ usedSpacings: [4, 8, 13], spacingStep: 4 })
  check('Œil espacement → 13 hors pas', JSON.stringify(spacing.measured.offSpacing) === JSON.stringify([13]))

  // Déterminisme : même contexte ⇒ même rapport.
  const b1 = JSON.stringify(inspectDesign({ palette: ['#7c5cff'], usedColors: ['#7c5cff', '#ff0000'] }))
  const b2 = JSON.stringify(inspectDesign({ palette: ['#7c5cff'], usedColors: ['#7c5cff', '#ff0000'] }))
  check('Œil déterministe', b1 === b2)
}

// ── inspectProjectDesign sur des fichiers ────────────────────────────────────
{
  const files = [
    { path: 'src/index.css', content: ':root { --accent: #7c5cff; --bg: #0b0b12; }' },
    { path: 'src/App.jsx', content: '<div style={{ color: "#ff0000", background: "#0b0b12", fontSize: "16px" }} />' },
    { path: 'src/style.css', content: '.x { color: #ff0000; background-color: #0b0b12; font-size: 14px; }' },
    { path: 'README.md', content: 'ignored #abcdef' }, // non-style → ignoré
  ]
  const obs = inspectProjectDesign(files)
  check('projet : palette déclarée prise des variables', !obs.measured.offPalette.includes('#7c5cff'))
  check('projet : #ff0000 hors palette', obs.measured.offPalette.includes('#ff0000'))
  check('projet : README ignoré (#abcdef absent)', !obs.measured.offPalette.includes('#abcdef'))
  check('projet : jamais bloquant', obs.blocking === false)
}

// ── runDesignEye : écrit le fichier d'observations, ne renvoie aucun verdict ──
{
  const writes: Record<string, string> = {}
  const files = [{ path: 'a.css', content: '.x { color: #999; background: #aaa; font-size: 16px; }' }]
  const obs: DesignObservation = runDesignEye(
    '/proj',
    files,
    { writeFile: (f, d) => { writes[f] = d }, now: () => 42 },
  )
  check('runDesignEye → fichier observations écrit', Object.keys(writes).some(f => f.includes('design-observations.json')))
  check('runDesignEye → observedAt injecté', Object.values(writes)[0].includes('"observedAt": 42'))
  check('runDesignEye → blocking false', obs.blocking === false)
  check('runDesignEye → contraste faible mesuré', obs.measured.contrast.length === 1)
}

// ── Bilan ────────────────────────────────────────────────────────────────────
console.log(`\n[œil-design] ${passed} ✅  ${failed ? failed + ' ❌' : '0 ❌'}  (${passed + failed} assertions)`)
if (failed > 0) process.exit(1)
