// Branche 🏗️ Architecture — modularité, séparation des responsabilités, dette.
import { auditWithLLM } from '../llm.js'
import type { Branch, ProjectFile } from '../types.js'

const CODE = ['.ts', '.tsx', '.js', '.jsx']

export const architecture: Branch = {
  id: 'architecture',
  label: 'Architecture',
  emoji: '🏗️',
  blocking: true,
  relevant: (files: ProjectFile[]) => files.filter(f => CODE.some(e => f.path.endsWith(e))),
  audit: ctx =>
    auditWithLLM(
      {
        id: 'architecture',
        // (2026-08-04, mesure J0 — eval/rapports/J0-2026-08-04-18-{18,20}*.md) SEUIL DE GRAVITÉ ajouté.
        //
        // Incident mesuré : le cas propre CLEAN-04 (composant React de 25 lignes qui charge
        // sa propre liste paginée, avec AbortController) a été rejeté par TROIS modèles de
        // familles différentes — Claude Haiku, gemma4, qwen2.5-coder — tous avec le même
        // motif : « mélange data-fetching et présentation ».
        //
        // Diagnostic : ce n'étaient pas les modèles qui avaient tort, c'était CE PROMPT. Il
        // listait « composant qui mélange data-fetching, état et présentation » comme symptôme
        // SANS seuil, tout en définissant un échec comme « un défaut qui rendra la maintenance
        // COÛTEUSE ». Les modèles satisfaisaient la liste de symptômes en violant la barre de
        // gravité — la liste était trop large par rapport au seuil.
        //
        // Conséquence produit si on n'y touche pas : TOUT composant React qui charge ses
        // propres données est un feu rouge, soit l'écrasante majorité du code généré. Un
        // auditeur qui rejette du code idiomatique cesse d'être lu — et un auditeur qu'on
        // n'ouvre plus ne protège plus rien.
        //
        // Correctif : le symptôme est conservé mais QUALIFIÉ, et une clause explicite dit ce
        // qui n'est PAS un échec. Nommer les non-échecs est plus efficace, sur un juge LLM,
        // que d'affiner la liste des échecs.
        specialty:
          'Spécialité : ARCHITECTURE logicielle. Tu traques les violations structurelles : fichier monolithe (> ~300 lignes, ou faisant manifestement trop de choses à la fois) ; absence de séparation des responsabilités quand elle coûte cher (logique métier non triviale — calculs, règles, transformations — mêlée au rendu) ; duplication flagrante (même bloc recopié dans 3 fichiers ou plus) ; code mort ; couplage fort évitable (un composant de présentation qui importe directement un client de base de données ou une couche serveur). ' +
          'CE QUI N\'EST PAS UN ÉCHEC — ne rejette JAMAIS pour ces raisons seules : un composant COURT (moins de ~80 lignes) qui charge ses propres données et les affiche, c\'est le patron React idiomatique et il est acceptable ; un état local géré près de son usage ; l\'absence d\'une couche d\'abstraction dont rien ne prouve encore le besoin ; une préférence de style (hook extrait, dossier séparé) sans coût de maintenance démontrable. Extraire un hook n\'est justifié que si la logique est RÉUTILISÉE ailleurs ou devenue complexe. ' +
          'Un "fail" = un défaut structurel CONCRET, localisable, dont tu peux dire en une phrase POURQUOI il rendra la maintenance coûteuse. Si tu ne peux pas nommer ce coût, réponds "pass".',
      },
      ctx,
    ),
}
