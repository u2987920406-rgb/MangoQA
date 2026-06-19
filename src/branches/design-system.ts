// Branche 🎨 Design System — CONSEIL uniquement (ne bloque JAMAIS).
import { auditWithLLM } from '../llm.js'
import type { Branch, ProjectFile } from '../types.js'

const STYLE = ['.css', '.jsx', '.tsx', '.html']

export const designSystem: Branch = {
  id: 'design-system',
  label: 'Design System',
  emoji: '🎨',
  blocking: false,
  relevant: (files: ProjectFile[]) => files.filter(f => STYLE.some(e => f.path.endsWith(e))),
  audit: ctx =>
    auditWithLLM(
      {
        id: 'design-system',
        adviceOnly: true,
        specialty:
          'Spécialité : COHÉRENCE du design system. Tu observes la cohérence des tokens (palette de couleurs réutilisée vs valeurs magiques éparpillées, échelle d\'espacement régulière 4/8px, rayons de bordure cohérents, hiérarchie typographique stable). Tu donnes des CONSEILS d\'amélioration esthétique et de cohérence — tu ne bloques jamais la production. Résume tes suggestions en une phrase actionnable dans summary.',
      },
      ctx,
    ),
}
