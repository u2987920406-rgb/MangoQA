// Branche 📋 Spec — le code fait-il ce qui était demandé ?
//
// (2026-08-08, ADR-001 lot 4) La septième branche, et la seule qui ne juge pas le code
// mais le TRAVAIL. Les six autres savent dire qu'un code est sûr, accessible, rapide,
// testé, bien structuré, conforme aux règles maison. Aucune ne sait dire qu'il ne fait
// pas ce qu'on avait demandé — le mode de panne le plus courant des générateurs d'apps.
//
// Elle ne s'allume QUE si une spec a été fournie (`--spec`). Sans spec, elle s'abstient
// avec la cause `hors-perimetre` : il n'y a rien à comparer, et inventer une demande
// serait pire que ne rien dire.
//
// BLOQUANTE, et c'est délibéré : « il manque la moitié de ce que j'ai demandé » est
// exactement ce qu'une barrière doit arrêter (décision D2 de l'ADR — Mango QA est une
// barrière, pas un conseiller). Le débordement de périmètre, lui, ne bloque jamais : il
// est signalé dans le résumé. Faire plus que demandé peut être légitime.
import { auditWithLLM } from '../llm.js'
import { specSpecialty } from '../spec.js'
import type { Branch, BranchFinding, ProjectFile } from '../types.js'

/** Garde-fou de dernier recours : un « fail » qui ne cite AUCUNE exigence vérifiée
 *  n'est adossé à rien de réfutable — c'est une opinion, pas un audit. On le dégrade en
 *  observation plutôt que de laisser un feu rouge reposer sur une demande que personne
 *  ne peut retrouver dans le fichier de spec.
 *
 *  Exporté pour que les tests exercent CE code et pas une imitation : une copie de cette
 *  règle dans le harnais divergerait, et c'est exactement le défaut que le produit a
 *  trouvé chez son propre auteur deux lots de suite. */
export function degraderSiNonCitee(finding: BranchFinding): BranchFinding {
  if (finding.status !== 'fail' || finding.spec?.citees.length) return finding
  return {
    ...finding,
    status: 'pass',
    summary: `Observation non bloquante (aucune exigence citée) : ${finding.summary}`,
    rejectionId: undefined,
    correctiveAction: undefined,
    ruleRef: undefined,
  }
}

export const spec: Branch = {
  id: 'spec',
  label: 'Spec',
  emoji: '📋',
  blocking: true,
  // Tous les fichiers du périmètre : une exigence peut être satisfaite n'importe où.
  // Filtrer par extension ou par chemin ferait déclarer « non satisfaite » une demande
  // implémentée dans un fichier qu'on aurait soi-même écarté — le pire faux positif
  // possible pour cette branche, puisqu'il accuse d'un manquement qui n'existe pas.
  relevant: (files: ProjectFile[]) => files,
  audit: async ctx => {
    if (!ctx.spec) {
      return {
        status: 'skip',
        summary: 'Aucune spec fournie — rien à comparer.',
        abstention: { cause: 'hors-perimetre' },
      }
    }
    const finding: BranchFinding = await auditWithLLM(
      { id: 'spec', specialty: specSpecialty(ctx.spec) },
      ctx,
    )
    return degraderSiNonCitee(finding)
  },
}
