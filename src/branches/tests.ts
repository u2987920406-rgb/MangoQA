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
          "Spécialité : TESTS automatiques et TDD minimum. Tu évalues si la LOGIQUE NON TRIVIALE livrée (fonctions pures, hooks, reducers, calculs, validation, transformations de données, endpoints, services) est couverte par des tests (fichiers *.test.* — Vitest). Reste PROPORTIONNÉ : un projet purement visuel/statique sans logique métier n'a pas besoin de tests — réponds skip ou pass. Un fail = une logique métier importante et risquée livrée SANS aucun test alors qu'elle est facilement testable. EXIGENCE TDD MINIMALE (règle Raf 2026-09-01) : pour toute fonctionnalité livrée qui touche un endpoint, un service, un algorithme ou un calcul, tu exiges qu'un test EXÉCUTE réellement cette fonctionnalité (pas seulement qu'un fichier test existe) — si le test n'existe pas OU qu'il ne couvre pas le comportement (ex: un endpoint qui renvoie une erreur réelle non testée, un algorithme dont les cas limites ne sont pas vérifiés), c'est un fail avec corrective_action qui NOMME le test manquant. Ne réclame jamais de tests pour du markup/style.",
        includeTestsSignal: true,
      },
      ctx,
    ),
}
