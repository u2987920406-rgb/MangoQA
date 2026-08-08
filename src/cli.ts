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
import { realpathSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { auditProject, ALL_BRANCHES, type AuditReport, type BranchResultLite } from './audit.js'
import { CERVEAUX, cerveauPrimaire, type Cerveau } from './llm.js'
import { LIBELLE_CAUSE, estNonVerifie } from './verdict.js'
import { CerveauInutilisableError } from './preflight.js'
import { SpecInutilisableError } from './spec.js'
import { fichiersModifies } from './git.js'

const VERSION = '2.1.0'

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

OPTIONS
  --diff [ref]            N'auditer que ce qui a changé.
                            sans ref  → ce qui n'est pas encore commité (avant de pousser)
                            avec ref  → ce qui a divergé depuis ce point (avant de fusionner)
                                        ex. --diff main, --diff v1.2.0, --diff a1b2c3d
  --spec <fichier>        Ce qui était DEMANDÉ (ticket, cahier des charges, description
                          de tâche). Active la branche Spec : le code fait-il ce qu'on
                          attendait ? Sans elle, l'audit le déclare et ne juge pas dessus.
  --cerveau <nom>         Cerveau d'audit : ${CERVEAUX.join(' | ')}. Défaut : ollama.
                          RECOMMANDÉ : claude (qualité de jugement nettement supérieure).
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
export function parseArgs(argv: string[]): CliOptions | { aide: string } {
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) return { aide: AIDE }
  if (argv.includes('-v') || argv.includes('--version')) return { aide: VERSION }

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
  const vu = c ? `${c.filesRendered}/${c.filesTotal} vus` : `${b.filesAudited} fichiers`
  const partiel = c && !c.complete ? ' ⚠️' : ''
  return (
    `  ${FEUX[b.finding.status] ?? '?'} ${b.emoji} ${b.label.padEnd(15)}` +
    `${((b.durationMs / 1000).toFixed(1) + 's').padStart(7)}  ${(vu + partiel).padEnd(14)}${b.finding.summary}`
  )
}

/** Le rapport lisible. La couverture précède le verdict — voir l'en-tête du fichier. */
export function rendreRapport(r: AuditReport): string {
  const l: string[] = ['']

  if (r.empty) {
    l.push(`  Aucun fichier auditable dans ${r.projectDir}.`)
    l.push('')
    return l.join('\n')
  }

  for (const b of r.branches) l.push(ligneBranche(b))
  l.push('')

  const cov = r.coverage
  const partielles = r.branches.filter(b => b.coverage && !b.coverage.complete)
  if (cov.complete) {
    l.push(`  COUVERTURE : complète — ${cov.filesRead} fichiers lus et vus en entier.`)
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
  if (estNonVerifie(r.verdict.verdict, r.jugement.complet)) return EXIT.NON_VERIFIE
  if (exigerCouverture && !r.coverage.complete) return EXIT.PARTIEL
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
    opts = parsed
  } catch (err) {
    console.error(`[mangoqa] ${err instanceof Error ? err.message : String(err)}`)
    return EXIT.USAGE
  }

  // Le cap passe par le CONTRAT d'audit (faille L2-a) ; seuls le cerveau et le modèle
  // restent des réglages de process, parce qu'ils en sont vraiment : ils décrivent la
  // machine qui juge, pas la demande d'audit.
  if (opts.cerveau !== undefined) process.env.QA_BRAIN = opts.cerveau
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
    const branches = rapport.jugement.nonJugees.filter(b => b.blocking)
    console.error(
      `[mangoqa] Feu Vert refusé : ${branches.length} branche(s) bloquante(s) n'ont pas pu juger.\n` +
        branches.map(b => `          · ${b.label} — ${LIBELLE_CAUSE[b.cause]}`).join('\n') +
        "\n          Aucun défaut n'a été trouvé, mais rien n'a été vérifié non plus.",
    )
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
