// Lot 1 (ADR-001) — PORTÉE SUR LE DIFF : n'auditer que ce qui a changé.
//
// Pourquoi ce module existe. Auditer un projet entier prend des minutes ; personne ne
// garde un hook pre-commit qui bloque deux minutes. En n'auditant que les fichiers
// modifiés, trois choses arrivent d'un coup :
//   • la durée tombe de minutes à secondes, donc l'outil se relance ;
//   • la COUVERTURE devient complète dans le cas courant — l'aveu « je n'ai vu que 5
//     fichiers sur 19 » devient la garantie « j'ai tout vu » ;
//   • avec un cerveau facturé au jeton, le coût est divisé par un ordre de grandeur.
//
// DEUX PORTÉES, qui correspondent à deux moments réels du travail :
//   sans référence  → ce qui n'est pas encore commité (avant de commiter/pousser)
//   avec référence  → tout ce qui a divergé depuis ce point (avant de fusionner)
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { estFichierSource } from './project-files.js'

/** Erreur d'USAGE — dossier hors dépôt, référence inconnue, git absent. L'appelant
 *  la traduit en code de sortie 2 : ce n'est jamais un défaut d'audit. */
export class ErreurGit extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ErreurGit'
  }
}

function git(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    const e = err as { code?: string; stderr?: string; message?: string }
    if (e.code === 'ENOENT') throw new ErreurGit("git est introuvable. --diff a besoin de git dans le PATH.")
    // Le message de git est repris ENTIER, pas seulement sa première ligne : git met
    // le diagnostic sur la 1ʳᵉ ligne et le REMÈDE sur les suivantes (« detected dubious
    // ownership » → « To add an exception, call: git config --global --add
    // safe.directory … »). Tronquer, c'est afficher le problème en cachant la solution.
    const detail = (e.stderr ?? e.message ?? '').toString().trim()
    throw new ErreurGit(`git ${args.join(' ')} a échoué :\n${detail || 'erreur inconnue'}`)
  }
}

/** Chemins relatifs au dossier audité, pour les fichiers SOURCE qui ont changé.
 *
 *  `ref` absent  → fichiers non commités (index + copie de travail + nouveaux fichiers).
 *  `ref` fourni  → fichiers ayant divergé depuis le point commun avec `ref`
 *                  (`ref...HEAD`, la sémantique d'une pull request). Accepte un commit,
 *                  une branche ou une étiquette.
 *
 *  Trois filtres, chacun pour une raison précise :
 *  • les SUPPRESSIONS sont exclues (`--diff-filter=d`) — auditer un fichier effacé n'a
 *    aucun sens, et il compterait comme « découvert mais jamais lu », donc ferait
 *    paraître la couverture incomplète sans raison ;
 *  • les fichiers hors du dossier audité sont écartés (le dépôt peut être plus large) ;
 *  • les non-sources aussi, sinon on paierait des jetons pour un `.md` qu'aucune
 *    branche ne regarde. */
export function fichiersModifies(dossier: string, ref?: string): string[] {
  const abs = path.resolve(dossier)
  const racine = git(['rev-parse', '--show-toplevel'], abs).trim()
  if (!racine) throw new ErreurGit(`${abs} n'est pas dans un dépôt git.`)

  const brut: string[] = []
  if (ref) {
    // Vérifié séparément pour rendre « référence inconnue » lisible, plutôt que de
    // laisser remonter un message de git sur une syntaxe de plage.
    try {
      git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], abs)
    } catch {
      throw new ErreurGit(`Référence git inconnue : ${ref}. Attendu : un commit, une branche ou une étiquette.`)
    }
    brut.push(...git(['diff', '--name-only', '--diff-filter=d', `${ref}...HEAD`], abs).split('\n'))
  } else {
    brut.push(...git(['diff', '--name-only', '--diff-filter=d', 'HEAD'], abs).split('\n'))
    // Un fichier tout neuf est précisément celui qu'on veut faire relire ; `git diff`
    // ne le voit pas tant qu'il n'est pas suivi.
    brut.push(...git(['ls-files', '--others', '--exclude-standard'], abs).split('\n'))
  }

  const vus = new Set<string>()
  const out: string[] = []
  for (const ligne of brut) {
    const rel = ligne.trim()
    if (!rel) continue
    // git rend des chemins relatifs à la RACINE du dépôt ; l'audit les attend relatifs
    // au dossier audité, qui peut être un sous-dossier.
    const relAuDossier = path.relative(abs, path.resolve(racine, rel)).replace(/\\/g, '/')
    if (!relAuDossier || relAuDossier.startsWith('..')) continue
    if (!estFichierSource(relAuDossier)) continue
    if (vus.has(relAuDossier)) continue
    vus.add(relAuDossier)
    out.push(relAuDossier)
  }
  return out
}
