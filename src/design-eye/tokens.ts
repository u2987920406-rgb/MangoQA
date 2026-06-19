// Mango QA — Visage 3 (Œil Design) : adhérence aux TOKENS.
//
// Part RIGIDE, déterministe : une couleur employée appartient-elle à la palette
// déclarée ? un espacement / rayon tombe-t-il sur l'échelle ? Ce sont des faits,
// pas des goûts. Le moteur MESURE l'écart ; il ne décide jamais s'il est grave —
// c'est l'Œil (eye.ts) qui présente, et Raf qui tranche.
import { parseHex, type Rgb } from './contrast.js'

/** Normalise un hex (#abc → #aabbcc, minuscules) pour comparer des couleurs. */
export function normalizeHex(hex: string): string | null {
  const rgb: Rgb | null = parseHex(hex)
  if (!rgb) return null
  const to2 = (n: number): string => n.toString(16).padStart(2, '0')
  return `#${to2(rgb.r)}${to2(rgb.g)}${to2(rgb.b)}`
}

/** Couleurs employées hors palette déclarée (comparaison robuste au format). */
export function offPalette(used: string[], palette: string[]): string[] {
  const allowed = new Set<string>()
  for (const c of palette) {
    const n = normalizeHex(c)
    if (n) allowed.add(n)
  }
  // Si aucune palette déclarée, rien à reprocher (on ne mesure pas un écart à rien).
  if (allowed.size === 0) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const c of used) {
    const n = normalizeHex(c)
    if (!n || seen.has(n)) continue
    seen.add(n)
    if (!allowed.has(n)) out.push(n)
  }
  return out
}

/** Valeurs numériques (px) hors échelle, à une tolérance près. `scale` vide → rien. */
export function offScale(used: number[], scale: number[], tolerance = 0): number[] {
  if (scale.length === 0) return []
  const out: number[] = []
  const seen = new Set<number>()
  for (const v of used) {
    if (seen.has(v)) continue
    seen.add(v)
    const onScale = scale.some(s => Math.abs(s - v) <= tolerance)
    if (!onScale) out.push(v)
  }
  return out
}

/** Échelle d'espacement régulière (multiples d'un pas, ex. 4px) ? Renvoie les
 * valeurs qui ne sont pas des multiples — utile quand aucune échelle n'est
 * déclarée mais qu'on attend une régularité (défaut 4px, tolérance 0). */
export function offStep(used: number[], step = 4): number[] {
  if (step <= 0) return []
  const out: number[] = []
  const seen = new Set<number>()
  for (const v of used) {
    if (seen.has(v)) continue
    seen.add(v)
    if (v % step !== 0) out.push(v)
  }
  return out
}
