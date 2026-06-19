// Mango QA — Visage 3 : L'ŒIL DESIGN (cf. fondation.md §V).
//
// Le design est subjectif et sa cible BOUGE. Le brief est un point de départ, pas
// un contrat figé : l'utilisateur a des idées APRÈS avoir vu le rendu — c'est sain.
// L'Œil applique donc la règle gravée :
//
//   RIGIDE sur l'OBJECTIF mesurable  → contraste WCAG · tokens · conformité Sharingan
//                                       (des FAITS, calculés ici, pas une opinion)
//   SOUPLE sur le SUBJECTIF           → esthétique · goût · convergence
//                                       (des écarts présentés comme QUESTIONS,
//                                        jamais des erreurs : « voulu, ou je corrige ? »)
//
// PRINCIPE ABSOLU : l'Œil ne VALIDE jamais et ne BLOQUE jamais (`blocking: false`).
// Il VÉRIFIE la cohérence et CONVERGE avec Raf, seul juge du goût et de la cible.
// (Le blocage sur l'objectif mesurable, lui, appartient au Visage 1 — le Disjoncteur.)
import {
  contrastRatio,
  isLargeText,
  wcagLevel,
  type WcagLevel,
} from './contrast.js'
import { offPalette, offScale, offStep, normalizeHex } from './tokens.js'

/** Une paire texte/fond à mesurer (extraite du CSS ou fournie). */
export interface ColorPair {
  fg: string
  bg: string
  fontPx?: number
  bold?: boolean
  where?: string
}

/** Cible de référence (capture Sharingan, design system importé…). */
export interface BriefRef {
  /** Palette de la cible — l'Œil mesure ce que le rendu n'a PAS repris. */
  palette?: string[]
}

/** Contexte design soumis à l'Œil. Tout est optionnel : on ne mesure un écart
 * que si la référence existe (pas de palette déclarée ⇒ aucun reproche de palette). */
export interface DesignContext {
  palette?: string[]
  spacingScale?: number[]
  radiusScale?: number[]
  /** Régularité attendue si aucune échelle d'espacement n'est déclarée (défaut 4px). */
  spacingStep?: number
  pairs?: ColorPair[]
  usedColors?: string[]
  usedSpacings?: number[]
  usedRadii?: number[]
  brief?: BriefRef
}

/** Un contraste mesuré sous le seuil AA — un FAIT objectif. */
export interface ContrastObservation {
  fg: string
  bg: string
  ratio: number
  required: number
  level: WcagLevel
  large: boolean
  where?: string
}

/** Le rapport de l'Œil. Jamais un verdict : des observations + des questions. */
export interface DesignObservation {
  /** Invariant gravé : l'Œil ne bloque JAMAIS. */
  blocking: false
  /** Faits mesurés (objectif, rigide). */
  measured: {
    contrast: ContrastObservation[]
    offPalette: string[]
    offSpacing: number[]
    offRadius: number[]
    /** Couleurs de la cible Sharingan absentes du rendu (conformité mesurée). */
    briefDrift: string[]
  }
  /** Écarts subjectifs présentés comme questions de convergence (souple). */
  convergence: string[]
  summary: string
  counts: { measured: number; convergence: number }
}

// ── Extraction déterministe depuis du CSS ────────────────────────────────────
const HEX = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b/g

/** Toutes les couleurs hex employées dans une feuille CSS (dédupliquées, normalisées). */
export function extractCssColors(css: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of css.match(HEX) ?? []) {
    const n = normalizeHex(m)
    if (n && !seen.has(n)) {
      seen.add(n)
      out.push(n)
    }
  }
  return out
}

/** Paires texte/fond extraites règle par règle (`color` + `background[-color]`
 * dans le même bloc `{…}`), avec taille/graisse si présentes. Déterministe. */
export function extractContrastPairs(css: string): ColorPair[] {
  const pairs: ColorPair[] = []
  const ruleRe = /([^{}]*)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = ruleRe.exec(css)) !== null) {
    const selector = m[1].trim().replace(/\s+/g, ' ')
    const body = m[2]
    const fg = /(?:^|[;\s])color\s*:\s*(#[0-9a-fA-F]{3,6})/.exec(body)?.[1]
    const bg = /background(?:-color)?\s*:\s*(#[0-9a-fA-F]{3,6})/.exec(body)?.[1]
    if (!fg || !bg) continue
    const fontPx = parseFloat(/font-size\s*:\s*([\d.]+)px/.exec(body)?.[1] ?? '')
    const weight = /font-weight\s*:\s*(bold|[5-9]\d\d)/.exec(body)?.[1]
    pairs.push({
      fg,
      bg,
      fontPx: Number.isFinite(fontPx) ? fontPx : undefined,
      bold: weight !== undefined,
      where: selector || undefined,
    })
  }
  return pairs
}

/** Construit un contexte à partir de feuilles CSS brutes (couleurs + paires). */
export function contextFromCss(css: string, base: Partial<DesignContext> = {}): DesignContext {
  return {
    ...base,
    pairs: [...(base.pairs ?? []), ...extractContrastPairs(css)],
    usedColors: [...(base.usedColors ?? []), ...extractCssColors(css)],
  }
}

// ── L'Œil ────────────────────────────────────────────────────────────────────
/** Regarde un contexte design et produit des observations — jamais un blocage. */
export function inspectDesign(ctx: DesignContext): DesignObservation {
  // 1. Contraste WCAG (objectif) — on ne retient que les paires SOUS AA.
  const contrast: ContrastObservation[] = []
  for (const p of ctx.pairs ?? []) {
    const ratio = contrastRatio(p.fg, p.bg)
    if (ratio === null) continue
    const large = isLargeText(p.fontPx, p.bold)
    const level = wcagLevel(ratio, large)
    if (level === 'fail') {
      contrast.push({
        fg: p.fg,
        bg: p.bg,
        ratio,
        required: large ? 3 : 4.5,
        level,
        large,
        where: p.where,
      })
    }
  }

  // 2. Tokens (objectif).
  const offPal = offPalette(ctx.usedColors ?? [], ctx.palette ?? [])
  const offSpacing =
    ctx.spacingScale && ctx.spacingScale.length > 0
      ? offScale(ctx.usedSpacings ?? [], ctx.spacingScale)
      : offStep(ctx.usedSpacings ?? [], ctx.spacingStep ?? 4)
  const offRadius = offScale(ctx.usedRadii ?? [], ctx.radiusScale ?? [])

  // 3. Conformité à la cible Sharingan (objectif) : couleurs de la cible non reprises.
  const briefDrift: string[] = []
  if (ctx.brief?.palette && ctx.brief.palette.length > 0) {
    const used = new Set((ctx.usedColors ?? []).map(normalizeHex).filter(Boolean) as string[])
    const seen = new Set<string>()
    for (const c of ctx.brief.palette) {
      const n = normalizeHex(c)
      if (n && !seen.has(n)) {
        seen.add(n)
        if (!used.has(n)) briefDrift.push(n)
      }
    }
  }

  const measuredCount = contrast.length + offPal.length + offSpacing.length + offRadius.length + briefDrift.length

  // 4. Convergence (souple) : les écarts SUBJECTIFS deviennent des QUESTIONS, jamais
  //    des erreurs. On ne demande pas « corrige » — on demande « voulu, ou je corrige ? ».
  const convergence: string[] = []
  if (offPal.length > 0) {
    convergence.push(
      `${offPal.length} couleur(s) hors palette déclarée (${offPal.slice(0, 4).join(', ')}${offPal.length > 4 ? '…' : ''}) — voulu, ou je réaligne sur la palette ?`,
    )
  }
  if (briefDrift.length > 0) {
    convergence.push(
      `${briefDrift.length} couleur(s) de la référence Sharingan absente(s) du rendu — écart voulu, ou je m'en rapproche ?`,
    )
  }
  if (offSpacing.length > 0 || offRadius.length > 0) {
    convergence.push(
      `Espacements/rayons hors échelle (${[...offSpacing, ...offRadius].slice(0, 5).join(', ')}) — choix assumé, ou je régularise ?`,
    )
  }

  const summary = buildSummary(contrast.length, measuredCount, convergence.length)

  return {
    blocking: false,
    measured: { contrast, offPalette: offPal, offSpacing, offRadius, briefDrift },
    convergence,
    summary,
    counts: { measured: measuredCount, convergence: convergence.length },
  }
}

function buildSummary(contrastFails: number, measured: number, convergence: number): string {
  if (measured === 0) {
    return 'Œil Design : cohérence visuelle OK — aucun écart mesuré. (Le goût final reste à Raf.)'
  }
  const parts: string[] = []
  if (contrastFails > 0) parts.push(`${contrastFails} contraste(s) sous WCAG AA (mesuré)`)
  const others = measured - contrastFails
  if (others > 0) parts.push(`${others} écart(s) tokens/brief`)
  return `Œil Design : ${parts.join(' · ')}. ${convergence} question(s) de convergence — rien n'est bloqué, Raf tranche.`
}
