// Branche ⚡ Performance — Web Vitals & anti-patterns React.
import { auditWithLLM } from '../llm.js'
import type { Branch, ProjectFile } from '../types.js'

const REACT = ['.jsx', '.tsx', '.js']

export const performance: Branch = {
  id: 'performance',
  label: 'Performance',
  emoji: '⚡',
  blocking: true,
  relevant: (files: ProjectFile[]) => files.filter(f => REACT.some(e => f.path.endsWith(e))),
  audit: ctx =>
    auditWithLLM(
      {
        id: 'performance',
        specialty:
          'Spécialité : PERFORMANCE (Web Vitals + anti-patterns React STATIQUES). Tu traques : clés manquantes/instables dans une liste (.map sans key ou key=index sur liste mutable) ; dépendances de useEffect manquantes ou tableau oublié (boucle/refetch) ; travail coûteux dans le rendu (tri/filtre/calcul lourd recalculé à chaque render sans useMemo) ; fonctions/objets recréés inline passés en props à des composants mémoïsés ; image très lourde sans dimensionnement. Reste sur l\'analyse STATIQUE du code (pas d\'exécution). Un "fail" = un anti-pattern CONCRET et coûteux visible dans le code.',
      },
      ctx,
    ),
}
