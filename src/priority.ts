// Mango QA — score de priorité pour l'échantillonnage des fichiers audités (#10,
// revue globale 2026-07-03).
//
// Les branches LLM (OWASP, architecture, tests) ne voient qu'un sous-ensemble
// borné du projet (MAX_FILES fichiers × FILE_PAYLOAD_CAP caractères au total en
// prompt). Plutôt qu'une troncature "premier arrivé, premier servi" (ordre de
// découverte disque ou ordre du delta `changedFiles`), on TRIE les candidats par
// probabilité de contenir une faille avant de les sélectionner : points d'entrée
// HTTP, auth, secrets/config, fichiers serveur — ce sont les cibles réelles d'un
// audit sécurité/architecture. Fonction pure, sur le CHEMIN seul (pas de lecture
// disque) — assez bon marché pour trier des centaines de candidats avant de ne
// lire le contenu que des élus.
const PATTERNS: Array<{ score: number; re: RegExp }> = [
  // Auth : la surface la plus sensible (login, session, jwt, permissions).
  { score: 100, re: /(^|[\\/])(auth|login|session|jwt|permission|oauth)/i },
  // Points d'entrée HTTP : routes/handlers/controllers/middlewares/API.
  { score: 90, re: /(^|[\\/])(routes?|handlers?|controllers?|middlewares?|api)([\\/]|\.[jt]sx?$)/i },
  // Secrets / variables d'environnement / config serveur.
  { score: 80, re: /(\.env|secrets?|credentials?|\bconfig\b)/i },
  // Points d'entrée serveur (bootstrap du process).
  { score: 70, re: /(^|[\\/])(server|index|main|app)\.[jt]sx?$/i },
]

/** Score de priorité d'un chemin relatif — plus haut = audité en priorité.
 *  0 = aucun signal particulier (fichier "ordinaire" : composant, style, etc.).
 *  Le tri par ce score DOIT être stable (Array.prototype.sort l'est depuis
 *  ES2019/V8) pour préserver l'ordre de découverte/delta à priorité égale. */
export function priorityScore(relPath: string): number {
  const norm = relPath.replace(/\\/g, '/')
  let best = 0
  for (const { score, re } of PATTERNS) if (score > best && re.test(norm)) best = score
  return best
}

/** Trie une liste de chemins par priorité décroissante (stable). Ne modifie pas
 *  le tableau reçu — nouvelle liste, la source garde son ordre d'origine. */
export function sortByPriority(paths: string[]): string[] {
  return [...paths].sort((a, b) => priorityScore(b) - priorityScore(a))
}
