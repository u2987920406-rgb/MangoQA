// Branche ⚡ Performance — Web Vitals & anti-patterns React.
import { auditWithLLM } from '../llm.js'
import type { Branch, ProjectFile } from '../types.js'

// (2026-08-04, mesure J0 — eval/rapports/J0-2026-08-04-17-47-21.md) `.ts` AJOUTÉ.
// Incident mesuré : le cas PERF-03 (import de lodash ENTIER + moment pour une seule
// fonction chacun, dans `src/utils/format.ts`) n'était JAMAIS retenu — verdict
// « non pertinent » en 0,0 s. Ce filtre ne voyait que les fichiers de COMPOSANT ;
// or dans un projet Vite+TS, les utils, hooks, stores et clients d'API sont en `.ts`.
// Autrement dit : seuls les composants étaient audités, jamais la logique.
const CODE = ['.jsx', '.tsx', '.js', '.ts']

export const performance: Branch = {
  id: 'performance',
  label: 'Performance',
  emoji: '⚡',
  blocking: true,
  relevant: (files: ProjectFile[]) => files.filter(f => CODE.some(e => f.path.endsWith(e))),
  audit: ctx =>
    auditWithLLM(
      {
        id: 'performance',
        // (2026-08-04, même mesure) Le POIDS DU BUNDLE a été ajouté à la spécialité.
        // Corriger le filtre seul n'aurait PAS suffi pour PERF-03 : la liste ci-dessous
        // ne décrivait que des anti-patterns de RENDU React (keys, useEffect, useMemo…) —
        // aucune mention du coût d'un import. Un fichier `.ts` d'utilitaires serait donc
        // arrivé au modèle sans qu'aucun critère ne s'y applique. Les deux défauts —
        // filtre trop étroit ET critère absent — devaient être corrigés ensemble.
        specialty:
          'Spécialité : PERFORMANCE (Web Vitals + anti-patterns React STATIQUES + POIDS DU BUNDLE). Tu traques : clés manquantes/instables dans une liste (.map sans key ou key=index sur liste mutable) ; dépendances de useEffect manquantes ou tableau oublié (boucle/refetch) ; travail coûteux dans le rendu (tri/filtre/calcul lourd recalculé à chaque render sans useMemo) ; fonctions/objets recréés inline passés en props à des composants mémoïsés ; image très lourde sans dimensionnement ; rendu d\'une très grande liste sans pagination ni virtualisation. POIDS DU BUNDLE : import d\'une librairie ENTIÈRE pour une ou deux fonctions (`import _ from "lodash"` au lieu de `lodash-es`/import ciblé), librairie lourde et datée là où une API native suffit (moment vs Intl.DateTimeFormat), dépendance volumineuse tirée dans le chemin client. Reste sur l\'analyse STATIQUE du code (pas d\'exécution). Un "fail" = un anti-pattern CONCRET et coûteux visible dans le code.',
      },
      ctx,
    ),
}
