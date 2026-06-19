// Branche 🔒 Sécurité — OWASP.
import { auditWithLLM } from '../llm.js'
import type { Branch, ProjectFile } from '../types.js'

const SENSITIVE_PATH = /(server|api|auth|supabase|\.env|config)/i
// Motifs qui rendent un fichier pertinent même hors chemin sensible.
const SENSITIVE_CONTENT =
  /(api[_-]?key|secret|password|token|dangerouslySetInnerHTML|eval\(|innerHTML|process\.env|cors\(|exec\(|child_process)/i

export const security: Branch = {
  id: 'security',
  label: 'Sécurité',
  emoji: '🔒',
  blocking: true,
  relevant: (files: ProjectFile[]) =>
    files.filter(f => SENSITIVE_PATH.test(f.path) || SENSITIVE_CONTENT.test(f.content)),
  audit: ctx =>
    auditWithLLM(
      {
        id: 'security',
        specialty:
          'Spécialité : SÉCURITÉ applicative (OWASP). Tu traques : secrets/clés/mots de passe en dur dans le code ou exposés côté front (préfixe VITE_ pour une clé secrète) ; XSS (dangerouslySetInnerHTML / innerHTML avec donnée non assainie) ; injection (SQL/commande construite par concaténation) ; CORS trop permissif (origin *) ; path traversal (chemin construit depuis une entrée utilisateur sans validation) ; absence de RLS sur une table publique. Cite la catégorie OWASP (ex: A01, A03, A05). Un "fail" = une vulnérabilité CONCRÈTE et exploitable visible dans le code.',
      },
      ctx,
    ),
}
