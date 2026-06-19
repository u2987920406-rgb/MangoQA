// Mango QA — Visage 3 (Œil Design) : moteur de CONTRASTE WCAG.
//
// La part RIGIDE de l'Œil : un FAIT mesurable, pas une opinion. Un LLM ne peut
// pas calculer fiablement un ratio de contraste ; ici c'est de l'arithmétique
// pure et déterministe (formules officielles WCAG 2.1). Aucune I/O, aucun LLM.

export interface Rgb {
  r: number
  g: number
  b: number
}

/** Parse `#rgb` / `#rrggbb` (avec ou sans #) → Rgb 0..255, ou null si invalide. */
export function parseHex(hex: string): Rgb | null {
  const h = hex.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{3}$/.test(h)) {
    return {
      r: parseInt(h[0] + h[0], 16),
      g: parseInt(h[1] + h[1], 16),
      b: parseInt(h[2] + h[2], 16),
    }
  }
  if (/^[0-9a-fA-F]{6}$/.test(h)) {
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    }
  }
  return null
}

/** Linéarise un canal sRGB 0..255 → 0..1 (formule WCAG). */
function channel(c255: number): number {
  const c = c255 / 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/** Luminance relative d'une couleur (0 = noir, 1 = blanc). */
export function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b)
}

/** Ratio de contraste entre deux couleurs (1:1 à 21:1). Ordre indifférent. */
export function contrastRatio(a: string, b: string): number | null {
  const ra = parseHex(a)
  const rb = parseHex(b)
  if (!ra || !rb) return null
  const la = relativeLuminance(ra)
  const lb = relativeLuminance(rb)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
}

/** Un texte est « grand » au sens WCAG : ≥ 24px, ou ≥ 18.66px gras. */
export function isLargeText(fontPx?: number, bold?: boolean): boolean {
  if (fontPx === undefined) return false
  return fontPx >= 24 || (bold === true && fontPx >= 18.66)
}

export type WcagLevel = 'AAA' | 'AA' | 'fail'

/** Niveau WCAG atteint par un ratio, selon la taille du texte. */
export function wcagLevel(ratio: number, large: boolean): WcagLevel {
  if (large) {
    if (ratio >= 4.5) return 'AAA'
    if (ratio >= 3) return 'AA'
    return 'fail'
  }
  if (ratio >= 7) return 'AAA'
  if (ratio >= 4.5) return 'AA'
  return 'fail'
}
