// Branche ♿ Accessibilité — WCAG 2.2.
import { auditWithLLM } from '../llm.js'
import type { Branch, ProjectFile } from '../types.js'

const UI = ['.jsx', '.tsx', '.html']

export const accessibility: Branch = {
  id: 'accessibility',
  label: 'Accessibilité',
  emoji: '♿',
  blocking: true,
  relevant: (files: ProjectFile[]) => files.filter(f => UI.some(e => f.path.endsWith(e))),
  audit: ctx =>
    auditWithLLM(
      {
        id: 'accessibility',
        specialty:
          'Spécialité : ACCESSIBILITÉ (WCAG 2.2). Tu vérifies : tout <input>/<select>/<textarea> a un <label> associé (ou aria-label) ; les <img> ont un alt pertinent ; les éléments cliquables sont des <button>/<a> et non des <div onClick> sans rôle clavier ; la hiérarchie des titres est cohérente (un seul h1, pas de saut) ; les boutons-icônes ont un nom accessible ; <html lang> présent pour une page. Cite la règle WCAG (ex: 1.1.1, 1.3.1, 2.1.1, 4.1.2). Un "fail" = une barrière d\'accès CONCRÈTE dans le code fourni.',
      },
      ctx,
    ),
}
