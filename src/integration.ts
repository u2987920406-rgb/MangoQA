// Lot 5 (ADR-001) — l'intégration : de zéro à un premier verdict en une commande.
//
// Décision D4 : l'étalon à égaler est `mattpocock/skills`, et son avantage n'est pas
// technique — il est **installé en une ligne**. Un auditeur meilleur mais pénible à
// brancher perd contre un auditeur moyen déjà présent dans l'éditeur. Ce module est
// donc le plus modeste du produit, et l'un des plus décisifs.
//
// TROIS PORTES, parce qu'un dev indé n'en emprunte pas la même selon le moment :
//   • `.mcp.json`     — pendant qu'il code, son assistant appelle l'auditeur
//   • hook `pre-push` — au moment où il pousse, la barrière tombe toute seule
//   • action de CI    — quand il travaille à plusieurs, sur la forge
//
// ⚠️ RÈGLE ABSOLUE DE CE FICHIER : **on n'écrase jamais le travail de quelqu'un
// d'autre.** Un `.mcp.json` qui contient déjà trois serveurs, un `pre-push` qui lance
// déjà des tests — ce sont des heures de réglage. Un outil qui les remplace en silence
// pour s'installer plus vite est un outil qu'on désinstalle. Toutes les fonctions ici
// FUSIONNENT ou REFUSENT ; aucune n'écrase.
import path from 'node:path'

/** Ce qu'une installation a réellement fait. Rendu à l'appelant pour affichage. */
export interface ResultatInstallation {
  /** Chemin écrit, relatif ou absolu selon ce qu'a demandé l'appelant. */
  fichier: string
  /** `ecrit` = créé · `fusionne` = complété sans rien perdre · `inchange` = déjà bon
   *  · `refuse` = un contenu étranger occupe la place, on n'y touche pas. */
  etat: 'ecrit' | 'fusionne' | 'inchange' | 'refuse'
  /** Explication destinée à l'utilisateur. Toujours renseignée si `refuse`. */
  detail: string
}

// ── 1. `.mcp.json` — l'assistant appelle l'auditeur ──────────────────────────

/** L'entrée que Mango QA revendique dans un `.mcp.json`. */
export const ENTREE_MCP = {
  command: 'npx',
  args: ['-y', 'mango-qa', 'mangoqa-mcp'],
} as const

/** Fusionne notre serveur dans un `.mcp.json` existant, sans rien perdre.
 *
 *  `existant` = le contenu du fichier, ou `null` s'il n'existe pas. Fonction PURE :
 *  toute la logique délicate (JSON illisible, clé déjà prise, autres serveurs présents)
 *  se teste sans toucher au disque.
 *
 *  Un JSON illisible fait REFUSER, jamais écraser : un fichier qu'on n'arrive pas à
 *  parser est peut-être un fichier précieux mal formé, et le remplacer par le nôtre
 *  détruirait la configuration de quelqu'un pour lui rendre service. */
export function fusionnerMcpConfig(existant: string | null): { contenu: string; etat: ResultatInstallation['etat']; detail: string } {
  const nôtre = JSON.parse(JSON.stringify(ENTREE_MCP)) as Record<string, unknown>

  if (existant === null || existant.trim() === '') {
    return {
      contenu: `${JSON.stringify({ mcpServers: { mangoqa: nôtre } }, null, 2)}\n`,
      etat: 'ecrit',
      detail: 'fichier créé',
    }
  }

  let racine: Record<string, unknown>
  try {
    const parsed = JSON.parse(existant) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('pas un objet')
    racine = parsed as Record<string, unknown>
  } catch {
    return {
      contenu: existant,
      etat: 'refuse',
      detail:
        "le fichier existant n'est pas un JSON d'objet lisible. Je n'y touche pas — " +
        'corrigez-le, ou ajoutez l\'entrée à la main (voir `mangoqa init --montrer`).',
    }
  }

  const serveurs = (racine.mcpServers ?? {}) as Record<string, unknown>
  if (typeof serveurs !== 'object' || serveurs === null || Array.isArray(serveurs)) {
    return { contenu: existant, etat: 'refuse', detail: '`mcpServers` existe mais n\'est pas un objet.' }
  }

  const deja = serveurs.mangoqa
  if (deja !== undefined) {
    // Déjà là et identique → rien à faire. Déjà là et DIFFÉRENT → c'est un réglage
    // volontaire (un chemin local, un modèle imposé) : on le laisse.
    const identique = JSON.stringify(deja) === JSON.stringify(nôtre)
    return {
      contenu: existant,
      etat: identique ? 'inchange' : 'refuse',
      detail: identique
        ? 'déjà configuré à l\'identique'
        : 'une entrée « mangoqa » existe déjà avec une autre configuration — je la laisse telle quelle.',
    }
  }

  const fusionne = { ...racine, mcpServers: { ...serveurs, mangoqa: nôtre } }
  return {
    contenu: `${JSON.stringify(fusionne, null, 2)}\n`,
    etat: 'fusionne',
    detail: `ajouté à côté de ${Object.keys(serveurs).length} serveur(s) déjà présent(s)`,
  }
}

// ── 2. Le hook `pre-push` — la barrière tombe toute seule ────────────────────

/** Marqueur qui nous permet de reconnaître NOTRE hook lors d'une réinstallation.
 *  Sans lui, on ne saurait pas distinguer notre propre fichier de celui d'un autre
 *  outil, et on ne pourrait jamais mettre le nôtre à jour sans risquer d'écraser. */
export const MARQUEUR_HOOK = '# mango-qa:pre-push'

/** Le hook. `sh` et non `node` : c'est ce que git exécute sur les trois systèmes.
 *
 *  Deux choix qui comptent :
 *  • **`--diff` et pas le projet entier** — un `pre-push` doit rester de l'ordre de la
 *    dizaine de secondes. Auditer tout le dépôt à chaque poussée ferait désinstaller le
 *    hook dans la semaine, et un hook désinstallé ne protège rien.
 *  • **le code de sortie est propagé tel quel** — donc `4` (non vérifié) bloque aussi.
 *    C'est cohérent avec le lot 2 : on ne pousse pas plus sur « l'auditeur n'a pas pu
 *    juger » que sur un feu rouge. La variable `MANGOQA_SKIP=1` reste la porte de
 *    sortie explicite, parce qu'un outil sans échappatoire se fait contourner par un
 *    `--no-verify` qui, lui, désarme TOUS les hooks du dépôt. */
export function contenuHookPrePush(): string {
  return [
    '#!/bin/sh',
    MARQUEUR_HOOK,
    '# Barrière Mango QA — audite ce qui a divergé, et refuse la poussée sur feu rouge.',
    '# Retirer ce hook : supprimer .git/hooks/pre-push',
    '# Sauter une fois  : MANGOQA_SKIP=1 git push',
    '',
    'if [ "$MANGOQA_SKIP" = "1" ]; then',
    '  echo "[mango-qa] saut demandé (MANGOQA_SKIP=1)."',
    '  exit 0',
    'fi',
    '',
    'echo "[mango-qa] audit de ce qui va être poussé…"',
    'npx --no-install mangoqa . --diff origin/HEAD || npx -y mango-qa . --diff origin/HEAD',
    'code=$?',
    '',
    'if [ $code -ne 0 ]; then',
    '  echo ""',
    '  echo "[mango-qa] poussée refusée (code $code)."',
    '  echo "           1 = feu rouge · 3 = lecture partielle · 4 = l\'auditeur n\'a pas pu juger"',
    '  echo "           Forcer malgré tout : MANGOQA_SKIP=1 git push"',
    'fi',
    'exit $code',
    '',
  ].join('\n')
}

/** Ce contenu est-il un hook que NOUS avons posé ? */
export function estNotreHook(contenu: string): boolean {
  return contenu.includes(MARQUEUR_HOOK)
}

/** Décide quoi faire d'un `pre-push` déjà présent. Pure — testable sans disque. */
export function planifierHook(existant: string | null): { contenu: string; etat: ResultatInstallation['etat']; detail: string } {
  const voulu = contenuHookPrePush()
  if (existant === null || existant.trim() === '') return { contenu: voulu, etat: 'ecrit', detail: 'hook créé' }
  if (existant === voulu) return { contenu: existant, etat: 'inchange', detail: 'déjà à jour' }
  if (estNotreHook(existant)) return { contenu: voulu, etat: 'fusionne', detail: 'hook Mango QA mis à jour' }
  // Le hook de quelqu'un d'autre. On ne le touche pas, et on dit comment faire
  // cohabiter — un outil qui écrase un hook existant se fait retirer le jour même.
  return {
    contenu: existant,
    etat: 'refuse',
    detail:
      'un hook pre-push existe déjà et ne vient pas de Mango QA. Je ne le remplace pas.\n' +
      '           Pour les faire cohabiter, ajoutez cette ligne à la fin du vôtre :\n' +
      '             npx mangoqa . --diff origin/HEAD || exit $?',
  }
}

// ── 3. L'action de CI — prête à coller ───────────────────────────────────────

export const CHEMIN_WORKFLOW = '.github/workflows/mangoqa.yml'

/** Le workflow GitHub Actions.
 *
 *  `--exiger-couverture` est activé ici et nulle part ailleurs : en CI, personne ne lit
 *  le rapport. Un feu vert rendu sur 30 % du code y passerait pour une vérification, et
 *  c'est précisément le mensonge que le lot 2 a supprimé de l'affichage — le laisser
 *  revenir par la porte de la CI serait absurde.
 *
 *  Le cerveau est `claude` avec la clé du dépôt : une CI n'a pas d'abonnement Claude
 *  Code interactif. Sans clé, le workflow le dit et s'arrête plutôt que de rendre un
 *  audit vide. */
export function contenuWorkflowCi(): string {
  return `# Mango QA — l'auditeur indépendant, en barrière de CI.
#
# Ce fichier est prêt à coller. Un seul prérequis : le secret ANTHROPIC_API_KEY.
#
# Codes de sortie interprétés par la CI :
#   0 feu vert · 1 feu rouge · 2 environnement inutilisable
#   3 feu vert sur lecture partielle · 4 l'auditeur n'a pas pu juger
name: Mango QA

on:
  pull_request:
  push:
    branches: [main, master]

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          # L'audit porte sur ce qui a CHANGÉ : il faut donc l'historique, pas
          # seulement le dernier commit.
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Auditer le changement
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          QA_BRAIN: claude
        run: |
          if [ -z "$ANTHROPIC_API_KEY" ]; then
            echo "::error::Secret ANTHROPIC_API_KEY absent — aucun audit n'a été lancé."
            echo "Un rapport rendu sans cerveau vaudrait moins que pas de rapport du tout."
            exit 2
          fi
          npx -y mango-qa . \\
            --diff \${{ github.event.pull_request.base.sha || github.event.before }} \\
            --exiger-couverture \\
            --json rapport-mangoqa.json

      - name: Conserver le rapport
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: rapport-mangoqa
          path: rapport-mangoqa.json
          if-no-files-found: ignore
`
}

/** Où poser chaque fichier, à partir du dossier de travail. Regroupé ici pour que la
 *  CLI n'ait aucune connaissance des chemins d'installation. */
export const CHEMINS = {
  mcp: (dir: string): string => path.join(dir, '.mcp.json'),
  hook: (dir: string): string => path.join(dir, '.git', 'hooks', 'pre-push'),
  ci: (dir: string): string => path.join(dir, ...CHEMIN_WORKFLOW.split('/')),
}
