#!/usr/bin/env node
// J3 — CLI de Mango QA : auditer un dossier depuis un terminal, sans MangoOS.
//
//     mangoqa <dossier> [options]
//
// Pourquoi une CLI, et pas seulement l'API `auditProject()` : le client visé est le
// solo maker (cf. MangoOS/docs/refonte/06). Il ne câble pas une API dans un script,
// il tape une commande et lit un verdict. C'est aussi la seule forme utilisable en CI.
//
// RÈGLE D'AFFICHAGE, héritée de J2 et non négociable : la COUVERTURE s'imprime AVEC le
// verdict, jamais en note de bas de page. Un verdict sans son périmètre ne veut rien
// dire — c'est très exactement le défaut que J2 a corrigé, et un affichage paresseux
// suffirait à le réintroduire côté présentation.
import 'dotenv/config'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  CHEMIN_WORKFLOW,
  CHEMINS,
  contenuWorkflowCi,
  fusionnerMcpConfig,
  planifierHook,
  type ResultatInstallation,
} from './integration.js'
import { auditProject, ALL_BRANCHES, type AuditReport, type BranchResultLite } from './audit.js'
import { CERVEAUX, cerveauPrimaire, type Cerveau } from './llm.js'
import { LIBELLE_CAUSE, estNonVerifie } from './verdict.js'
import { CerveauInutilisableError } from './preflight.js'
import { SpecInutilisableError } from './spec.js'
import { fichiersModifies } from './git.js'
import { EXTENSIONS_AUDITEES } from './project-files.js'
import { VERSION } from './version.js'

// (2026-08-08) La version était écrite en dur ici ET dans `mcp.ts` — troisième
// duplication de règle du dépôt. Deux copies d'un numéro de version, c'est la garantie
// qu'une CLI annoncera autre chose que le serveur MCP un jour. Ré-exportée pour les
// appelants qui l'importaient d'ici.
export { VERSION }

/** Codes de sortie — le contrat de la CLI en CI. Stables, documentés, testés. */
export const EXIT = {
  /** Feu Vert. */
  VERT: 0,
  /** Feu Rouge : une branche bloquante a échoué. */
  ROUGE: 1,
  /** Erreur d'usage ou dossier inutilisable. JAMAIS un défaut d'audit. */
  USAGE: 2,
  /** Feu Vert mais lecture PARTIELLE, et `--exiger-couverture` demandé.
   *  Distinct de ROUGE : aucun défaut n'a été trouvé, on refuse seulement de
   *  traiter « rien vu » comme « rien à signaler ». */
  PARTIEL: 3,
  /** Au moins une branche BLOQUANTE n'a pas pu JUGER (cerveau hors contrat ou
   *  injoignable). Il n'y a pas de verdict à rendre — ni vert, ni rouge.
   *
   *  (2026-08-05, J4-a) Non désactivable, contrairement à `PARTIEL` : une lecture
   *  partielle est un mode dégradé légitime qu'on peut assumer, une absence de
   *  jugement n'est pas un audit. Sortir 0 ici, c'est certifier ce qu'on n'a pas
   *  vérifié — et en CI, ça passe sans que personne ne le voie. */
  NON_VERIFIE: 4,
} as const

const AIDE = `🥭 mangoqa ${VERSION} — audite un dossier de code et rend un verdict.

USAGE
  mangoqa <dossier> [options]
  mangoqa init [dossier] [--ci] [--hook]   Brancher Mango QA (voir INSTALLATION)
  mangoqa install-hook [dossier]           Poser le hook git pre-push, seul

INSTALLATION   (dossier facultatif — défaut : le dossier courant)
  mangoqa init            écrit .mcp.json → ton assistant (Claude Code, Cursor)
                          peut appeler l'auditeur pendant que tu codes
  mangoqa init --hook     + hook pre-push : la barrière tombe à chaque poussée
  mangoqa init --ci       + .github/workflows/mangoqa.yml, prêt à coller
  Rien n'est jamais écrasé : un fichier existant est fusionné, ou laissé intact.

OPTIONS
  --diff [ref]            N'auditer que ce qui a changé.
                            sans ref  → ce qui n'est pas encore commité (avant de pousser)
                            avec ref  → ce qui a divergé depuis ce point (avant de fusionner)
                                        ex. --diff main, --diff v1.2.0, --diff a1b2c3d
  --spec <source>         Ce qui était DEMANDÉ : un fichier, ou une issue (\`#42\` ou son
                          URL, lue via le CLI \`gh\` déjà authentifié chez vous). Active la
                          branche Spec : le code fait-il ce qu'on attendait ? Sans elle,
                          l'audit le déclare et ne juge pas dessus.
  --cerveau <nom>         Cerveau d'audit : ${CERVEAUX.join(' | ')}. Défaut : claude
                          (qualité de jugement nettement supérieure, mesurée).
                          \`--cerveau ollama\` ou QA_LOCAL_ONLY=on : rien ne quitte
                          votre machine, au prix d'un jugement moins sûr.
  --modele <id>           Modèle du cerveau claude. Défaut : claude-opus-5.
  --only <a,b>            N'exécuter que ces branches (${ALL_BRANCHES.map(b => b.id).join(', ')})
  --concurrency <n>       Branches en parallèle (défaut 1 : verdicts au fil de l'eau).
                          Cerveau local mono-GPU : garder 1. Cerveau cloud : 6.
  --cap <n>               Caractères de code max par prompt (défaut 100000).
  --json [fichier]        Rapport machine sur stdout, ou dans <fichier>.
  --exiger-couverture     Sortir en ${EXIT.PARTIEL} si le verdict porte sur une lecture partielle.
  --sans-preflight        Ne pas vérifier le cerveau avant l'audit (déconseillé :
                          une panne ne se découvre alors qu'après plusieurs minutes).
  --sans-conventions      Ne pas lire les règles du dépôt (CLAUDE.md, CONTRIBUTING.md,
                          AGENTS.md, .editorconfig, .cursorrules…) ni juger contre elles.
  --silencieux            Pas d'affichage progressif (le rapport final seulement).
  -h, --help              Cette aide.
  -v, --version           Version.

CODES DE SORTIE
  ${EXIT.VERT}  Feu Vert          ${EXIT.ROUGE}  Feu Rouge
  ${EXIT.USAGE}  Erreur d'usage    ${EXIT.PARTIEL}  Feu Vert sur lecture partielle (--exiger-couverture)
  ${EXIT.NON_VERIFIE}  NON VÉRIFIÉ — une branche bloquante n'a pas pu juger (toujours actif)

EXEMPLES
  mangoqa ./mon-projet
  mangoqa ./mon-projet --only security,tests
  mangoqa . --json rapport.json --exiger-couverture
`

const FEUX: Record<string, string> = { pass: '🟢', fail: '🔴', skip: '⚪' }

/** Options de ligne de commande, déjà validées. */
export interface CliOptions {
  dossier: string
  only?: string[]
  concurrency: number
  cap?: number
  cerveau?: Cerveau
  modele?: string
  /** `--diff` demandé. `ref` absent = travail non commité. */
  diff?: { ref?: string }
  /** Fichier décrivant ce qui était demandé (`--spec`). */
  spec?: string
  json: boolean
  jsonFichier?: string
  exigerCouverture: boolean
  sansPreflight: boolean
  sansConventions: boolean
  silencieux: boolean
}

/** Analyse `argv` (sans `node` ni le script). Lève une `Error` sur usage invalide —
 *  l'appelant la traduit en code ${EXIT.USAGE}. Pure : testable sans process. */
/** Une sous-commande d'installation, reconnue AVANT toute analyse de dossier.
 *  (Correctif exact proposé par la branche Spec le 2026-08-08 sur son propre diff.) */
export interface CommandeInstallation {
  commande: 'init'
  /** Écrire `.mcp.json`. Faux pour `install-hook`, qui ne fait qu'une chose. */
  mcp: boolean
  ci: boolean
  hook: boolean
  /** Dépôt à équiper. Défaut : le dossier courant.
   *
   *  (2026-08-08) Ajouté après un vrai incident pendant la vérification du lot : sans
   *  cet argument, `init` n'agissait que sur `process.cwd()` — j'ai lancé la commande
   *  depuis le dépôt de Mango QA en croyant équiper un autre dossier, et elle a écrit
   *  trois fichiers dans le mauvais dépôt. Une commande qui écrit sur disque doit dire
   *  OÙ elle écrit et permettre de le choisir : toutes les autres commandes de cette
   *  CLI prennent un dossier, celle-ci n'avait aucune raison de faire exception. */
  dossier?: string
}

export function parseArgs(argv: string[]): CliOptions | CommandeInstallation | { aide: string } {
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) return { aide: AIDE }
  if (argv.includes('-v') || argv.includes('--version')) return { aide: VERSION }

  // Les sous-commandes se lisent EN TÊTE, avant que `install-hook` puisse être pris
  // pour un nom de dossier. C'est le seul endroit où l'ordre des arguments compte.
  if (argv[0] === 'init' || argv[0] === 'install-hook') {
    const reste = argv.slice(1)
    const drapeaux = reste.filter(a => a.startsWith('-'))
    const inconnu = drapeaux.find(a => !['--ci', '--hook'].includes(a))
    if (inconnu) throw new Error(`Option inconnue pour ${argv[0]} : ${inconnu}. Attendues : --ci, --hook.`)
    const cibles = reste.filter(a => !a.startsWith('-'))
    if (cibles.length > 1) throw new Error(`Un seul dossier à la fois (reçu "${cibles.join('", "')}").`)
    const dossier = cibles[0]
    return argv[0] === 'install-hook'
      ? { commande: 'init', mcp: false, ci: false, hook: true, ...(dossier ? { dossier } : {}) }
      : {
          commande: 'init',
          mcp: true,
          ci: drapeaux.includes('--ci'),
          hook: drapeaux.includes('--hook'),
          ...(dossier ? { dossier } : {}),
        }
  }

  let dossier: string | undefined
  const opts: CliOptions = {
    dossier: '',
    concurrency: 1,
    json: false,
    exigerCouverture: false,
    sansPreflight: false,
    sansConventions: false,
    silencieux: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const valeur = (): string => {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) throw new Error(`L'option ${a} attend une valeur.`)
      i++
      return v
    }
    switch (a) {
      case '--only': {
        const ids = valeur().split(',').map(s => s.trim()).filter(Boolean)
        const connus = new Set(ALL_BRANCHES.map(b => b.id))
        const inconnus = ids.filter(id => !connus.has(id))
        if (inconnus.length) {
          throw new Error(`Branche(s) inconnue(s) : ${inconnus.join(', ')}. Connues : ${[...connus].join(', ')}.`)
        }
        opts.only = ids
        break
      }
      case '--concurrency': {
        const n = Number.parseInt(valeur(), 10)
        if (!Number.isFinite(n) || n < 1) throw new Error('--concurrency attend un entier >= 1.')
        opts.concurrency = n
        break
      }
      case '--cap': {
        const n = Number.parseInt(valeur(), 10)
        if (!Number.isFinite(n) || n < 1) throw new Error('--cap attend un entier >= 1.')
        opts.cap = n
        break
      }
      case '--cerveau': {
        const v = valeur().trim().toLowerCase()
        if (!(CERVEAUX as readonly string[]).includes(v)) {
          throw new Error(`Cerveau inconnu : ${v}. Connus : ${CERVEAUX.join(', ')}.`)
        }
        opts.cerveau = v as Cerveau
        break
      }
      case '--modele':
        opts.modele = valeur()
        break
      case '--spec':
        opts.spec = valeur()
        break
      case '--diff':
        // Référence FACULTATIVE, comme `--json`. Un argument qui commence par `-`
        // est une option, pas une référence git.
        opts.diff = argv[i + 1] && !argv[i + 1].startsWith('-') ? { ref: argv[++i] } : {}
        break
      case '--json':
        opts.json = true
        // Valeur FACULTATIVE : `--json` seul écrit sur stdout.
        if (argv[i + 1] && !argv[i + 1].startsWith('-')) opts.jsonFichier = argv[++i]
        break
      case '--exiger-couverture':
        opts.exigerCouverture = true
        break
      case '--sans-preflight':
        opts.sansPreflight = true
        break
      case '--sans-conventions':
        opts.sansConventions = true
        break
      case '--silencieux':
        opts.silencieux = true
        break
      default:
        if (a.startsWith('-')) throw new Error(`Option inconnue : ${a}. \`mangoqa --help\` pour l'aide.`)
        if (dossier !== undefined) throw new Error(`Un seul dossier à la fois (reçu "${dossier}" puis "${a}").`)
        dossier = a
    }
  }

  if (dossier === undefined) throw new Error('Aucun dossier indiqué. `mangoqa <dossier>`.')

  // Contradiction refusée plutôt qu'arbitrée en silence : `QA_LOCAL_ONLY` promet
  // qu'aucun octet ne sort de la machine, `--cerveau claude` envoie le code à un
  // service distant. Choisir l'un des deux à la place de l'utilisateur trahirait
  // soit sa demande, soit sa promesse de confidentialité — donc on s'arrête.
  const strict = /^(on|1|true|yes)$/i.test((process.env.QA_LOCAL_ONLY ?? '').trim())
  if (strict && opts.cerveau === 'claude') {
    throw new Error(
      'QA_LOCAL_ONLY=on interdit tout appel distant, mais --cerveau claude en exige un. ' +
        'Choisissez : retirez QA_LOCAL_ONLY, ou utilisez --cerveau ollama.',
    )
  }

  opts.dossier = dossier
  return opts
}

const pct = (n: number, d: number): string => (d > 0 ? `${Math.round((n / d) * 100)} %` : '—')

/** Une ligne de branche, format commun à l'affichage progressif et au rapport final. */
function ligneBranche(b: BranchResultLite): string {
  const c = b.coverage
  // (2026-08-08, persona P1) Une branche qui s'est abstenue sans appeler le modèle
  // affichait quand même « 2 fichiers » — ce qui se lit comme « j'ai regardé 2 fichiers ».
  // Elle n'en a regardé aucun. Sur un produit dont la thèse est de ne pas laisser croire
  // qu'on a examiné ce qu'on n'a pas examiné, c'était une verrue.
  const rienRegarde = b.finding.status === 'skip' && c === undefined
  const vu = c ? `${c.filesRendered}/${c.filesTotal} vus` : rienRegarde ? '—' : `${b.filesAudited} fichiers`
  const partiel = c && !c.complete ? ' ⚠️' : ''
  return (
    `  ${FEUX[b.finding.status] ?? '?'} ${b.emoji} ${b.label.padEnd(15)}` +
    `${((b.durationMs / 1000).toFixed(1) + 's').padStart(7)}  ${(vu + partiel).padEnd(14)}${b.finding.summary}`
  )
}

/** Le rapport lisible. La couverture précède le verdict — voir l'en-tête du fichier. */
export function rendreRapport(r: AuditReport): string {
  const l: string[] = ['']

  // (2026-08-08, persona P5 — faille P-01) Un audit VIDE n'est pas un audit réussi.
  // Un développeur Django a pointé Mango QA sur son projet : « aucun fichier auditable »,
  // code de sortie **0**, alors que le fichier contenait une injection SQL flagrante. En
  // CI, ça passe pour toujours. C'est la famille J4-a d'un cran plus haut — le produit
  // savait dire « je n'ai pas lu » et « je n'ai pas jugé », mais pas « je n'ai rien eu à
  // regarder ». On dit maintenant les trois, et surtout POURQUOI.
  if (r.empty) {
    l.push('  AUCUN FICHIER AUDITABLE — rien n\'a été vérifié dans ce dossier.')
    l.push(`    ${r.projectDir}`)
    l.push('')
    l.push(`    Mango QA lit aujourd'hui : ${EXTENSIONS_AUDITEES.join(' ')}`)
    l.push('    Les autres langages (Python, Go, Rust, PHP…) ne sont PAS encore audités —')
    l.push("    ce n'est pas un feu vert sur votre code, c'est une absence de lecture.")
    l.push('')
    l.push('    Si vous attendiez un audit ici : vérifiez le chemin, ou consultez')
    l.push("    l'état du support multi-langage avant de brancher Mango QA en CI.")
    l.push('')
    return l.join('\n')
  }

  for (const b of r.branches) l.push(ligneBranche(b))
  l.push('')

  const cov = r.coverage
  const partielles = r.branches.filter(b => b.coverage && !b.coverage.complete)
  if (cov.complete) {
    const s = cov.filesRead > 1 ? 's' : ''
    l.push(`  COUVERTURE : complète — ${cov.filesRead} fichier${s} lu${s} et vu${s} en entier.`)
  } else {
    l.push('  COUVERTURE — INCOMPLÈTE')
    l.push(`    Fichiers découverts : ${cov.filesDiscovered}   lus : ${cov.filesRead} (${pct(cov.filesRead, cov.filesDiscovered)})`)
    if (cov.filesDropped.length) l.push(`    ⚠️ Jamais lus : ${cov.filesDropped.join(', ')}`)
    if (cov.filesTruncated.length) l.push(`    ⚠️ Coupés à la lecture : ${cov.filesTruncated.join(', ')}`)
    for (const b of partielles) {
      const c = b.coverage!
      l.push(
        `    ⚠️ ${b.id} : ${c.filesRendered}/${c.filesTotal} fichiers envoyés au modèle (${pct(c.charsRendered, c.charsTotal)} du code)` +
          (c.omitted.length ? `\n       non vus : ${c.omitted.join(', ')}` : ''),
      )
    }
    l.push('    → Le verdict ci-dessous ne porte PAS sur tout le code.')
  }
  l.push('')

  // SPEC — la quatrième déclaration : contre quelle DEMANDE on a jugé. Son cas
  // « absente » compte autant : un feu vert rendu sans spec ne dit rien sur la seule
  // question que se pose celui qui a commandé le travail.
  const sp = r.spec
  if (sp.file === null) {
    l.push("  SPEC : aucune fournie — l'audit ne dit PAS si le code fait ce qui était demandé.")
  } else {
    l.push(`  SPEC : ${sp.exigencesProvided} exigence(s) lue(s) dans ${sp.file}`)
    if (sp.exigencesDropped > 0) {
      l.push(`    ⚠️ ${sp.exigencesDropped} exigence(s) au-delà du cap, non fournies au jugement.`)
    }
    // L'exigence est citée ENTRE GUILLEMETS, pas seulement référencée : « spec:12 non
    // satisfaite » obligerait le lecteur à ouvrir le fichier pour savoir de quoi on parle.
    for (const e of sp.citedTexts) l.push(`    ✗ ${e.id} non satisfaite — « ${e.text} »`)
    if (sp.rejected.length) {
      l.push(`    ⚠️ Citation(s) REJETÉE(S) — aucune exigence réelle : ${sp.rejected.join(', ')}`)
    }
  }
  l.push('')

  // CONVENTIONS — la troisième déclaration : contre QUOI on a jugé. Toujours affichée,
  // y compris (et surtout) quand le dépôt n'en documente aucune : c'est ce qui empêche
  // de lire un feu vert comme « conforme à vos règles » alors qu'aucune n'existe.
  const conv = r.conventions
  if (conv) {
    if (conv.absent) {
      l.push("  CONVENTIONS : aucune documentée dans ce dépôt — jugé sur les seules spécialités.")
    } else {
      const cite = conv.cited.length ? ` · ${conv.cited.length} invoquée(s) : ${conv.cited.join(', ')}` : ''
      l.push(`  CONVENTIONS : ${conv.rulesProvided} règle(s) lue(s) dans ${conv.files.join(', ')}${cite}`)
      if (conv.rulesDropped > 0) {
        l.push(`    ⚠️ ${conv.rulesDropped} règle(s) au-delà du cap, non fournies au jugement.`)
      }
      // Une citation inventée n'est pas nettoyée en silence : c'est le symptôme (J1-b)
      // d'un modèle qui affirme un fait que la source contredit, et il doit se voir.
      if (conv.rejected.length) {
        l.push(`    ⚠️ Citation(s) REJETÉE(S) — ne correspond à aucune règle réelle : ${conv.rejected.join(', ')}`)
      }
    }
    l.push('')
  }

  // JUGEMENT — au même rang que la couverture, et pour la même raison. La couverture
  // dit ce qui a été LU, celui-ci dit ce qui a été JUGÉ. Sur la sonde du 2026-08-05,
  // la couverture affichait « complète » (elle disait vrai : les fichiers avaient bien
  // été envoyés) alors qu'aucune branche n'avait rendu de verdict.
  const jug = r.jugement
  if (!jug.complet || jug.nonJugees.length > 0) {
    l.push(jug.complet ? '  JUGEMENT — incomplet (branches de conseil seulement)' : '  JUGEMENT — INCOMPLET')
    for (const b of jug.nonJugees) {
      l.push(`    ⚠️ ${b.label}${b.blocking ? '' : ' (conseil)'} : ${LIBELLE_CAUSE[b.cause]}`)
    }
    if (!jug.complet) l.push("    → Une branche BLOQUANTE n'a pas jugé : aucun verdict n'est défendable.")
    l.push('')
  }

  const v = r.verdict
  const reserve = cov.complete ? '' : '  ⚠️ SUR LECTURE PARTIELLE'
  // Le contrat figé n'a que deux états et `verdict` reste `green` — c'est ce qui
  // préserve le fail-open vers MangoOS. Mais l'AFFICHER « FEU VERT » alors que rien
  // n'a été jugé serait le mensonge que ce lot supprime : ici, on ne le dit pas.
  //
  // La règle elle-même vit dans `verdict.ts` : la recopier ici, dans MCP et dans le
  // harnais d'éval garantirait qu'une des trois copies l'oublie un jour.
  const nonVerifie = estNonVerifie(v.verdict, jug.complet)
  const ligneVerdict = nonVerifie
    ? "⚪ NON VÉRIFIÉ — ni vert, ni rouge : l'auditeur n'a pas pu juger"
    : v.verdict === 'green'
      ? '🟢 FEU VERT'
      : '🔴 FEU ROUGE'
  const reserveJugement = !nonVerifie && !jug.complet ? '  ⚠️ JUGEMENT INCOMPLET' : ''
  l.push(
    `  VERDICT : ${ligneVerdict}` +
      `${v.rejection ? ` — branche ${v.rejection.branch} (${v.rejection.rejection_id})` : ''}${reserve}${reserveJugement}`,
  )
  if (v.rejection) {
    l.push(`  Correctif : « ${v.rejection.corrective_action} »`)
    if (v.rejection.rule_ref) l.push(`  Règle : ${v.rejection.rule_ref}`)
  }
  l.push(`  Durée : ${(r.durationMs / 1000).toFixed(1)}s`)
  // Les conditions ferment le rapport comme elles ouvrent un rapport de mesure : un
  // verdict qu'on archive sans savoir QUAND ni PAR QUOI il a été rendu n'est pas une
  // preuve (persona P4).
  l.push(
    `  Rendu le ${r.conditions.date.slice(0, 16).replace('T', ' ')} par ${r.conditions.cerveau}` +
      ` · ${r.conditions.modele} · mangoqa ${r.conditions.version}`,
  )
  l.push('')
  return l.join('\n')
}

/** Code de sortie à partir du rapport et des options. Pure — testée sans process.
 *
 *  L'ORDRE porte la doctrine, il n'est pas arbitraire :
 *  1. ROUGE d'abord — un défaut trouvé est un fait, aucune panne voisine ne l'annule ;
 *  2. NON_VERIFIE ensuite — un vert sans jugement n'est pas un vert (J4-a) ;
 *  3. PARTIEL enfin — un vert jugé mais sur une lecture partielle, si l'appelant
 *     a demandé qu'on le lui refuse. */
export function codeSortie(r: AuditReport, exigerCouverture: boolean): number {
  if (r.verdict.verdict === 'red') return EXIT.ROUGE
  // Un dossier dont RIEN n'était auditable n'a pas été vérifié — il ne peut pas rendre
  // le même code qu'un feu vert. (persona P5 : un projet Python sortait en 0, donc
  // passait en CI, alors qu'aucun fichier n'avait jamais été lu.)
  if (r.empty) return EXIT.NON_VERIFIE
  if (estNonVerifie(r.verdict.verdict, r.jugement.complet)) return EXIT.NON_VERIFIE
  if (exigerCouverture && !r.coverage.complete) return EXIT.PARTIEL
  return EXIT.VERT
}

/** Exécute `mangoqa init` / `install-hook`. Rendu séparé de l'audit : ces commandes ne
 *  lisent aucun code, n'appellent aucun modèle, et ne peuvent rendre ni vert ni rouge. */
export function executerInstallation(cmd: CommandeInstallation, dirParDefaut = process.cwd()): number {
  const dir = path.resolve(cmd.dossier ?? dirParDefaut)
  // Le dossier visé est ANNONCÉ. Une commande qui écrit sur disque sans dire où le fait
  // dans le mauvais dossier tôt ou tard — c'est arrivé pendant la vérification de ce lot.
  const lignes: string[] = ['', `🥭 mangoqa — branchement sur ${dir}`, '']
  let refus = false

  const poser = (
    fichier: string,
    plan: { contenu: string; etat: ResultatInstallation['etat']; detail: string },
    etiquette: string,
  ): void => {
    if (plan.etat !== 'refuse' && plan.etat !== 'inchange') {
      mkdirSync(path.dirname(fichier), { recursive: true })
      writeFileSync(fichier, plan.contenu, 'utf8')
      // Sur un système POSIX, un hook non exécutable est un hook que git ignore EN
      // SILENCE — l'utilisateur croirait la barrière posée alors qu'elle ne l'est pas.
      if (fichier.endsWith(`hooks${path.sep}pre-push`)) {
        try {
          chmodSync(fichier, 0o755)
        } catch {
          /* Windows : sans objet */
        }
      }
    }
    const icone = { ecrit: '✅', fusionne: '✅', inchange: '·', refuse: '⚠️' }[plan.etat]
    lignes.push(`  ${icone} ${etiquette.padEnd(22)} ${path.relative(dir, fichier) || fichier}`)
    lignes.push(`     ${plan.detail}`)
    if (plan.etat === 'refuse') refus = true
  }

  const lire = (p: string): string | null => (existsSync(p) ? readFileSync(p, 'utf8') : null)

  if (cmd.mcp) {
    const f = CHEMINS.mcp(dir)
    poser(f, fusionnerMcpConfig(lire(f)), 'Assistant (MCP)')
  }
  if (cmd.hook) {
    const f = CHEMINS.hook(dir)
    if (!existsSync(path.join(dir, '.git'))) {
      lignes.push('  ⚠️ Hook pre-push          — ce dossier n\'est pas un dépôt git, rien à installer.')
      refus = true
    } else {
      poser(f, planifierHook(lire(f)), 'Hook pre-push')
    }
  }
  if (cmd.ci) {
    const f = CHEMINS.ci(dir)
    const existant = lire(f)
    poser(
      f,
      existant === null
        ? { contenu: contenuWorkflowCi(), etat: 'ecrit', detail: 'workflow prêt à committer' }
        : { contenu: existant, etat: 'refuse', detail: `${CHEMIN_WORKFLOW} existe déjà — je ne le remplace pas.` },
      'Action de CI',
    )
  }

  lignes.push('')
  lignes.push('  Essayer tout de suite :  mangoqa .')
  if (cmd.ci) lignes.push('  La CI a besoin du secret ANTHROPIC_API_KEY sur le dépôt.')
  lignes.push('')
  console.log(lignes.join('\n'))
  // Un refus n'est PAS un échec d'installation : les autres portes sont posées, et on a
  // expliqué quoi faire pour celle qu'on n'a pas touchée. Sortir en erreur casserait un
  // `mangoqa init && mangoqa .` parfaitement légitime — le message suffit à alerter.
  void refus
  return EXIT.VERT
}

export async function main(argv: string[]): Promise<number> {
  let opts: CliOptions
  try {
    const parsed = parseArgs(argv)
    if ('aide' in parsed) {
      console.log(parsed.aide)
      return EXIT.VERT
    }
    if ('commande' in parsed) return executerInstallation(parsed)
    opts = parsed
  } catch (err) {
    console.error(`[mangoqa] ${err instanceof Error ? err.message : String(err)}`)
    return EXIT.USAGE
  }

  // Le cap passe par le CONTRAT d'audit (faille L2-a) ; seuls le cerveau et le modèle
  // restent des réglages de process, parce qu'ils en sont vraiment : ils décrivent la
  // machine qui juge, pas la demande d'audit.
  if (opts.cerveau !== undefined) process.env.QA_BRAIN = opts.cerveau

  // (2026-08-08, persona P2 — faille P-04) La bibliothèque garde `ollama` par défaut
  // pour ne pas changer sous les pieds de l'intégration MangoOS. Mais la décision **D1**
  // de l'ADR fait de Claude le défaut PRODUIT, et `llm.ts` l'écrit noir sur blanc :
  // « la CLI et la documentation, elles, recommandent claude ». Elle ne l'appliquait pas.
  //
  // Conséquence vécue : Salomé installe le hook dans son dépôt, où aucun `.env` ne fixe
  // `QA_BRAIN`. L'audit part sur un modèle local — **344 s** au lieu de 20, et un feu
  // rouge rendu par le cerveau que le produit déconseille. Un pre-push de six minutes
  // se fait désinstaller le jour même.
  //
  // ⚠️ Sauf en mode souverain : `QA_LOCAL_ONLY=on` promet qu'aucun octet ne sort de la
  // machine. Basculer silencieusement sur Claude ici trahirait cette promesse — c'est
  // le seul endroit où ce défaut ne s'applique pas.
  const souverain = /^(on|1|true|yes)$/i.test((process.env.QA_LOCAL_ONLY ?? '').trim())
  if (!process.env.QA_BRAIN && !souverain) process.env.QA_BRAIN = 'claude'
  if (opts.modele !== undefined) process.env.QA_MODEL = opts.modele

  // `--json` sur stdout doit rester du JSON PUR : tout le reste part sur stderr, sinon
  // un `mangoqa . --json | jq` casse sur la première ligne de progression.
  const jsonPur = opts.json && !opts.jsonFichier
  const trace = (s: string): void => {
    if (jsonPur) console.error(s)
    else console.log(s)
  }

  let rapport: AuditReport
  try {
    // Le cerveau est annoncé : deux audits rendus par deux cerveaux différents ne
    // sont pas comparables, et un rapport qui tait lequel a jugé est inexploitable.
    const cerveau = cerveauPrimaire()
    const detail = cerveau === 'claude' ? process.env.QA_MODEL ?? 'claude-opus-5' : process.env.QA_OLLAMA_MODEL ?? '(défaut)'
    trace(`\n🥭 mangoqa — audit de ${opts.dossier}`)
    trace(`   cerveau : ${cerveau} · ${detail}`)

    // PORTÉE — annoncée avant le verdict, au même titre que le cerveau. « Feu vert »
    // sur trois fichiers modifiés et « feu vert » sur tout un projet ne veulent pas
    // dire la même chose ; le rapport doit dire lequel des deux il rend.
    let changedFiles: string[] | undefined
    if (opts.diff) {
      changedFiles = fichiersModifies(opts.dossier, opts.diff.ref)
      const depuis = opts.diff.ref ? `depuis ${opts.diff.ref}` : 'non commité(s)'
      trace(`   portée  : ${changedFiles.length} fichier(s) ${depuis}`)
      if (changedFiles.length === 0) {
        // Distinct d'un dossier vide : ici il n'y a rien À auditer, ce n'est ni un
        // succès de vérification ni une erreur. On le dit, et on sort en vert.
        trace('\n  Aucun fichier source modifié — rien à auditer.\n')
        return EXIT.VERT
      }
    } else {
      trace('   portée  : projet entier')
    }
    trace(opts.spec ? `   spec    : ${opts.spec}` : '   spec    : aucune — conformité à la demande NON jugée')

    rapport = await auditProject(opts.dossier, {
      concurrency: opts.concurrency,
      preflight: !opts.sansPreflight,
      conventions: !opts.sansConventions,
      ...(opts.cap !== undefined ? { cap: opts.cap } : {}),
      ...(opts.spec !== undefined ? { spec: opts.spec } : {}),
      ...(opts.only ? { only: opts.only } : {}),
      ...(changedFiles ? { changedFiles } : {}),
      onBranch: opts.silencieux ? undefined : b => trace(ligneBranche(b)),
    })
  } catch (err) {
    // auditProject ne throw QUE si l'environnement est inutilisable — dossier
    // introuvable, ou cerveau incapable de rendre un verdict (fail-open partout
    // ailleurs). Les deux sont des erreurs d'USAGE, corrigeables par l'utilisateur,
    // jamais un défaut trouvé dans son code : d'où le code 2 et pas un feu rouge.
    if (err instanceof CerveauInutilisableError || err instanceof SpecInutilisableError) {
      console.error(`[mangoqa] ⛔ ${err.message}`)
      return EXIT.USAGE
    }
    console.error(`[mangoqa] ${err instanceof Error ? err.message : String(err)}`)
    return EXIT.USAGE
  }

  if (opts.json) {
    const brut = JSON.stringify(rapport, null, 2)
    if (opts.jsonFichier) {
      writeFileSync(opts.jsonFichier, brut, 'utf8')
      trace(`[mangoqa] rapport JSON : ${opts.jsonFichier}`)
    } else {
      console.log(brut)
    }
  }

  if (!opts.json || opts.jsonFichier) console.log(rendreRapport(rapport))

  const code = codeSortie(rapport, opts.exigerCouverture)
  if (code === EXIT.PARTIEL) {
    console.error(
      '[mangoqa] Feu Vert refusé : --exiger-couverture est actif et la lecture est partielle.\n' +
        '          Aucun défaut trouvé — mais sur une partie du code seulement.',
    )
  }
  if (code === EXIT.NON_VERIFIE) {
    // Deux chemins mènent ici, et les confondre donnerait un message absurde
    // (« 0 branche bloquante n'a pas pu juger ») : soit rien n'était auditable, soit
    // des branches n'ont pas pu juger ce qui l'était.
    if (rapport.empty) {
      console.error(
        "[mangoqa] Code 4 : aucun fichier auditable — ce n'est PAS un feu vert.\n" +
          `          Extensions lues : ${EXTENSIONS_AUDITEES.join(' ')}\n` +
          '          Rendre 0 ici laisserait une CI passer indéfiniment sur du code jamais lu.',
      )
    } else {
      const branches = rapport.jugement.nonJugees.filter(b => b.blocking)
      console.error(
        `[mangoqa] Feu Vert refusé : ${branches.length} branche(s) bloquante(s) n'ont pas pu juger.\n` +
          branches.map(b => `          · ${b.label} — ${LIBELLE_CAUSE[b.cause]}`).join('\n') +
          "\n          Aucun défaut n'a été trouvé, mais rien n'a été vérifié non plus.",
      )
    }
  }
  return code
}

/** Ce module est-il le POINT D'ENTRÉE, ou juste importé (tests, API) ?
 *
 *  (2026-08-05, J3 packaging) L'ancien test — `/cli\.(ts|js)$/` sur `process.argv[1]` —
 *  aurait cassé À L'INSTALLATION, sans rien casser en développement. `npm i -g` place un
 *  lien `node_modules/.bin/mangoqa` (et un shim `.cmd` sous Windows) : `argv[1]` vaut
 *  alors « mangoqa », qui ne finit pas par `cli.js`. La commande se serait terminée en
 *  silence, code 0, sans auditer quoi que ce soit — le pire mode de panne pour un
 *  outil dont la promesse est de ne pas se taire.
 *
 *  Comparer l'URL du module au chemin RÉEL de l'entrée (realpath : Node résout déjà le
 *  lien du bin) marche dans les trois cas : `tsx src/cli.ts`, `node dist/cli.js`, et le
 *  binaire installé. Et reste faux à l'import, ce qui garde la CLI testable. */
function estPointDEntree(): boolean {
  const entree = process.argv[1]
  if (!entree) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(entree)).href
  } catch {
    return false
  }
}

if (estPointDEntree()) {
  main(process.argv.slice(2))
    .then(code => process.exit(code))
    .catch(err => {
      console.error(`[mangoqa] erreur inattendue : ${err instanceof Error ? err.message : String(err)}`)
      process.exit(EXIT.USAGE)
    })
}
