// Branche 🧪 Tests — présence et qualité des tests sur la logique non triviale.
import { auditWithLLM } from '../llm.js'
import type { Branch, ProjectFile } from '../types.js'

const CODE = ['.ts', '.tsx', '.js', '.jsx']

export const tests: Branch = {
  id: 'tests',
  label: 'Tests',
  emoji: '🧪',
  blocking: true,
  relevant: (files: ProjectFile[]) =>
    files.filter(
      f => CODE.some(e => f.path.endsWith(e)) || f.path.endsWith('package.json'),
    ),
  audit: ctx =>
    auditWithLLM(
      {
        id: 'tests',
        specialty:
          "Spécialité : TESTS automatiques. Tu évalues si la LOGIQUE NON TRIVIALE livrée (fonctions pures, hooks, reducers, calculs, validation, transformations de données) est couverte par des tests (fichiers *.test.* — Vitest). Reste PROPORTIONNÉ : un projet purement visuel/statique sans logique métier n'a pas besoin de tests → \"skip\" ou \"pass\". Un \"fail\" = une logique métier importante et risquée livrée SANS aucun test alors qu'elle est facilement testable (ex: algorithme de calcul, parsing, règles de gestion). Ne réclame jamais de tests pour du markup/style.",
      },
      ctx,
    ),
}
