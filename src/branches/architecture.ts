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
        specialty:
          'Spécialité : ARCHITECTURE logicielle. Tu traques les violations structurelles : fichier monolithe (> ~300 lignes faisant trop de choses), absence de séparation des responsabilités (logique mêlée au rendu), duplication flagrante, code mort, couplage fort évitable, composant qui mélange data-fetching, état et présentation. Un "fail" = un défaut structurel CONCRET et localisable qui rendra la maintenance coûteuse.',
      },
      ctx,
    ),
}
