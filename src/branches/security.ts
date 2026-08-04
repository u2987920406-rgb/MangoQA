// Branche 🔒 Sécurité — OWASP.
import { auditWithLLM } from '../llm.js'
import type { Branch, ProjectFile } from '../types.js'

const SENSITIVE_PATH = /(server|api|auth|supabase|\.env|config|lib|db|client)/i
// Motifs qui rendent un fichier pertinent même hors chemin sensible.
//
// (2026-08-04, mesure J0 — eval/rapports/J0-2026-08-04-17-47-21.md) `import.meta.env`
// AJOUTÉ, ainsi que les noms de clés en MAJUSCULES et `service_role`.
// Incident mesuré : le cas SEC-01 (clé de SERVICE Supabase préfixée VITE_, donc
// inlinée dans le bundle client) n'était JAMAIS retenu par ce filtre — le fichier
// n'a jamais atteint le modèle, verdict « non pertinent » en 0,0 s.
// Cause : ce filtre ne connaissait que `process.env` (convention Node), alors que
// tout le front Vite — donc TOUTES les apps générées par MangoOS — écrit
// `import.meta.env`. Et `VITE_SUPABASE_SERVICE_ROLE_KEY` ne correspondait pas à
// `api[_-]?key` (le mot est SERVICE_ROLE_KEY, pas API_KEY).
// La spécialité du prompt ci-dessous mentionnait POURTANT déjà « préfixe VITE_ pour
// une clé secrète » : le jugement était prévu, c'est le filtre qui l'empêchait
// d'arriver. Classe de bug à retenir — un filtre trop étroit rend un bon prompt muet.
const SENSITIVE_CONTENT =
  /(api[_-]?key|secret|password|token|service_role|[A-Z0-9_]*_KEY\b|dangerouslySetInnerHTML|eval\(|innerHTML|process\.env|import\.meta\.env|cors\(|exec\(|child_process)/i

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
