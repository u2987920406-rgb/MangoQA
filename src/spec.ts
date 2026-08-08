// Lot 4 (ADR-001) — l'axe *Spec* : le code fait-il ce qui était demandé ?
//
// Les cinq autres axes jugent le code **en lui-même** : est-il sûr, accessible, rapide,
// testé, bien structuré, conforme aux règles maison. Aucun ne sait répondre à la seule
// question que se pose vraiment celui qui a commandé le travail : **est-ce que c'est ce
// que j'avais demandé ?**
//
// Un code peut être irréprochable sur les six spécialités et ne pas faire le travail.
// C'est même le mode de panne le plus courant des générateurs d'apps : ça compile, c'est
// joli, c'est propre — et il manque la moitié de la demande. Personne ne le dit, parce
// que personne n'a lu la demande.
//
// Ce module la lit. **Zéro LLM, entièrement déterministe** — même patron que
// `conventions.ts` : il ne comprend pas les exigences, il les **localise**, avec leur
// numéro de ligne, pour que le jugement d'après soit citable et donc réfutable.
//
// ⚠️ SYMÉTRIE À NE JAMAIS PERDRE : une exigence non satisfaite est un défaut du
// travail ; un **débordement de périmètre** (du code que personne n'a demandé) n'en est
// pas forcément un. Les deux se signalent, un seul bloque. Confondre les deux ferait
// d'un auditeur un censeur.
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { FsLike } from './project-files.js'
import { realFs } from './project-files.js'

/** Une exigence de la spec, localisée. */
export interface Exigence {
  /** `spec:<ligne>` — l'identifiant que le modèle doit citer, et qu'on vérifie. */
  id: string
  /** Numéro de ligne dans le fichier de spec, 1-indexé. */
  line: number
  /** Le texte de l'exigence, nettoyé de sa puce et borné. */
  text: string
}

export interface SpecScan {
  /** Chemin du fichier de spec tel que l'utilisateur l'a donné. */
  file: string
  /** Les exigences extraites, dans l'ordre des lignes. */
  exigences: Exigence[]
  /** Exigences écartées par le cap — comptées, jamais tues. */
  dropped: number
  /** Le fichier existe mais aucune exigence n'a pu en être extraite. */
  vide: boolean
}

/** Levée quand `--spec` désigne quelque chose d'inutilisable.
 *
 *  Une spec introuvable ou vide n'est PAS traitée comme « pas de spec » : l'utilisateur
 *  a explicitement demandé qu'on juge contre un document. Le remplacer en silence par
 *  un audit sans spec lui rendrait un feu vert qui ne répond pas à sa question. */
export class SpecInutilisableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpecInutilisableError'
  }
}

export const MAX_SPEC_CHARS = 40_000
export const MAX_EXIGENCE_CHARS = 240
export const DEFAULT_MAX_EXIGENCES = 40

function maxExigences(): number {
  const raw = parseInt((process.env.QA_SPEC_CAP ?? '').trim(), 10)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_EXIGENCES
}

/** Une puce de liste, numérotée ou non — la forme canonique d'une exigence. */
const PUCE = /^\s{0,6}(?:[-*+]|\d{1,3}[.)])\s+(.*)$/
/** Case à cocher : `- [ ] faire X` / `- [x] fait`. Très fréquent dans une issue. */
const CASE_A_COCHER = /^\[([ xX])\]\s*(.*)$/

/** Marqueurs d'une demande. Plus larges que ceux des conventions : une spec est écrite
 *  à l'infinitif ou au futur (« afficher la liste », « l'utilisateur pourra… »), pas
 *  seulement en obligations. FR et EN — les deux se croisent dans un même ticket. */
const DEMANDE =
  /\b(doit|doivent|devra|devront|faut|faudra|permettre|permet|afficher|ajouter|créer|supporter|gérer|pouvoir|pourra|besoin|attendu|exige|requis|implémenter|must|should|shall|need|needs|add|display|support|allow|implement|provide)\b/i

function nettoyer(brut: string): string {
  const plat = brut
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/(?<!\w)[*_]([^*_]+)[*_](?!\w)/g, '$1')
    .replace(/^#{1,6}\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plat.length > MAX_EXIGENCE_CHARS ? `${plat.slice(0, MAX_EXIGENCE_CHARS)}…` : plat
}

/** Extrait les exigences d'un texte de spec, avec leur ligne réelle.
 *
 *  Trois formes retenues : la **case à cocher** (déjà cochée ou non — voir plus bas), la
 *  **puce de liste**, et la **phrase de demande** hors liste. Titres, prose de contexte
 *  et blocs de code sont écartés : un exemple de code dans une spec MONTRE le résultat
 *  attendu, il ne le formule pas, et le citer enverrait le lecteur sur un extrait.
 *
 *  Les cases DÉJÀ COCHÉES sont conservées, délibérément. Une exigence marquée faite est
 *  précisément celle qu'il faut vérifier : l'auteur affirme l'avoir livrée, et c'est
 *  cette affirmation-là que l'audit est censé mettre à l'épreuve. La retirer reviendrait
 *  à croire sur parole exactement là où le produit existe pour ne pas croire sur parole. */
export function extraireExigences(contenu: string): Exigence[] {
  const out: Exigence[] = []
  let dansCode = false
  const lignes = contenu.split(/\r?\n/)
  for (let i = 0; i < lignes.length; i++) {
    const ligne = lignes[i]
    if (/^\s{0,3}(```|~~~)/.test(ligne)) {
      dansCode = !dansCode
      continue
    }
    if (dansCode) continue

    const puce = PUCE.exec(ligne)
    let brut = puce ? puce[1] : ligne
    const coche = CASE_A_COCHER.exec(brut.trim())
    if (coche) brut = coche[2]

    if (!puce && !DEMANDE.test(brut)) continue
    if (!puce && /^\s{0,3}#{1,6}\s/.test(ligne)) continue

    const texte = nettoyer(brut)
    if (texte.length < 8) continue
    if (/^\[[^\]]+\]\([^)]*\)$/.test(texte)) continue // puce de lien seul

    out.push({ id: `spec:${i + 1}`, line: i + 1, text: texte })
  }
  return out
}

/** Une valeur de `--spec` qui désigne une ISSUE plutôt qu'un fichier : une URL
 *  GitHub/GitLab, ou la forme courte `#42`. */
const ISSUE = /^(#\d+|https?:\/\/\S+\/(issues|-\/issues)\/\d+\/?)$/i

/** Récupère le corps d'une issue via le CLI `gh`, **déjà installé et authentifié chez
 *  l'utilisateur**.
 *
 *  (2026-08-08, lot 5 — ferme la faille L4-a) Aucun code d'authentification maison :
 *  pas de jeton à stocker, pas de secret qui traîne dans une variable d'environnement,
 *  pas de surface d'attaque ajoutée à un outil dont l'argument est la confiance. On
 *  emprunte l'authentification que le développeur a déjà consentie à son terminal, et
 *  on ne la voit jamais passer.
 *
 *  L'absence de `gh` est déclarée avec sa piste de résolution — jamais un
 *  `ENOENT: spawn gh` brut, qui ressemble à un bug de Mango QA. */
function lireIssue(ref: string): string {
  const args = ref.startsWith('#')
    ? ['issue', 'view', ref.slice(1), '--json', 'title,body', '--template', '{{.title}}\n\n{{.body}}']
    : ['issue', 'view', ref, '--json', 'title,body', '--template', '{{.title}}\n\n{{.body}}']
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') {
      throw new SpecInutilisableError(
        `Impossible de lire l'issue ${ref} : le CLI « gh » n'est pas installé.\n` +
          "Mango QA n'implémente délibérément aucune authentification propre — il emprunte " +
          "celle que vous avez déjà donnée à votre terminal.\n" +
          'Deux issues : installez gh (https://cli.github.com) et faites `gh auth login`, ' +
          "ou passez --spec avec un FICHIER (l'issue collée dans un .md fait très bien l'affaire).",
      )
    }
    const stderr = (err as { stderr?: Buffer | string })?.stderr
    const detail = (typeof stderr === 'string' ? stderr : stderr?.toString('utf8'))?.trim()
    throw new SpecInutilisableError(
      `Impossible de lire l'issue ${ref}${detail ? ` : ${detail.split('\n')[0]}` : ''}\n` +
        'Vérifiez `gh auth status`, et que vous êtes bien dans le dépôt qui porte cette issue.',
    )
  }
}

/** Lit la spec désignée par `--spec` : un FICHIER, ou une ISSUE (`#42`, ou une URL).
 *
 *  Lève plutôt que de rendre un scan vide : voir `SpecInutilisableError`. */
export function scanSpec(specPath: string, fsx: FsLike = realFs): SpecScan {
  if (ISSUE.test(specPath.trim())) {
    const brut = lireIssue(specPath.trim())
    const toutes = extraireExigences(brut.length > MAX_SPEC_CHARS ? brut.slice(0, MAX_SPEC_CHARS) : brut)
    const capIssue = maxExigences()
    const retenues = toutes.slice(0, capIssue)
    if (retenues.length === 0) {
      throw new SpecInutilisableError(
        `Aucune exigence lisible dans l'issue ${specPath}.\n` +
          'Une issue exploitable énumère ce qui est attendu — des puces, des cases à cocher, ' +
          'ou des phrases de demande. Une issue de pure discussion ne peut pas être confrontée au code.',
      )
    }
    // L'identifiant reste `spec:<ligne>` : la ligne est celle du TEXTE DE L'ISSUE, pas
    // d'un fichier du disque. Le rapport cite le texte entre guillemets, donc le lecteur
    // retrouve l'exigence dans l'issue sans avoir besoin d'un numéro de ligne local.
    return { file: specPath, exigences: retenues, dropped: toutes.length - retenues.length, vide: false }
  }

  const abs = path.resolve(specPath)
  let contenu: string
  try {
    if (!fsx.existsSync(abs) || !fsx.isFile(abs)) {
      throw new SpecInutilisableError(
        `Spec introuvable : ${specPath}\n` +
          "Donnez un fichier lisible (une description de tâche, un ticket exporté, un cahier des charges), " +
          'une issue (`#42` ou son URL), ' +
          'ou retirez --spec pour auditer sans spec — l\'audit le déclarera alors explicitement.',
      )
    }
    contenu = fsx.readFileSync(abs)
  } catch (err) {
    if (err instanceof SpecInutilisableError) throw err
    throw new SpecInutilisableError(`Spec illisible : ${specPath} (${err instanceof Error ? err.message : String(err)})`)
  }

  if (contenu.length > MAX_SPEC_CHARS) contenu = contenu.slice(0, MAX_SPEC_CHARS)
  const toutes = extraireExigences(contenu)
  const cap = maxExigences()
  const exigences = toutes.slice(0, cap)

  if (exigences.length === 0) {
    throw new SpecInutilisableError(
      `Aucune exigence lisible dans ${specPath}.\n` +
        'Une spec exploitable énumère ce qui est attendu — des puces, des cases à cocher, ' +
        'ou des phrases de demande. Un texte de pure prose ne peut pas être confronté au code ' +
        "ligne par ligne, et prétendre le contraire produirait des reproches invérifiables.",
    )
  }

  return { file: specPath.replace(/\\/g, '/'), exigences, dropped: toutes.length - exigences.length, vide: false }
}

/** Index des exigences par identifiant — pour vérifier une citation en O(1). */
export function indexerExigences(exigences: Exigence[]): Map<string, Exigence> {
  return new Map(exigences.map(e => [e.id, e]))
}

/** Le prompt de la branche Spec. Construit ici, à côté de l'extraction, pour que la
 *  forme des identifiants montrée au modèle ne puisse pas diverger de celle qu'on
 *  vérifie ensuite.
 *
 *  Il porte la **distinction structurante du lot** : ce qui manque bloque, ce qui
 *  déborde se signale. Un auditeur qui traite « tu as fait plus que demandé » comme une
 *  faute au même titre que « tu n'as pas fait ce que j'ai demandé » n'aide personne — il
 *  transforme une remarque utile en obstacle. */
export function specSpecialty(scan: SpecScan): string {
  const liste = scan.exigences.map(e => `[${e.id}] ${e.text}`).join('\n')
  return (
    'Spécialité : CONFORMITÉ À LA DEMANDE. Tu ne juges NI la qualité du code, NI sa sécurité, ' +
    "NI son style — cinq autres auditeurs s'en chargent. Tu réponds à une seule question : " +
    '**le code livré fait-il ce qui était demandé ?**\n\n' +
    `EXIGENCES DEMANDÉES (fichier ${scan.file}) :\n${liste}\n\n` +
    'Deux choses à chercher, et elles ne pèsent PAS pareil :\n' +
    "1. EXIGENCE NON SATISFAITE — une demande de la liste dont tu ne trouves aucune trace " +
    'dans le code fourni. C\'est le seul motif de "fail".\n' +
    "2. DÉBORDEMENT DE PÉRIMÈTRE — du code qui fait quelque chose que personne n'a demandé. " +
    'Signale-le dans ton résumé, préfixé par « Débordement : », mais ne mets JAMAIS "fail" ' +
    "pour ça : faire plus que demandé peut être légitime, ce n'est pas un défaut du travail.\n\n" +
    'RÈGLES DE PRUDENCE, qui priment sur ton envie de trouver quelque chose :\n' +
    "- Tu ne vois qu'une partie du code. Une exigence dont l'implémentation pourrait vivre " +
    'dans un fichier que tu ne reçois pas ne compte PAS comme non satisfaite.\n' +
    "- N'invente aucune exigence : si ce n'est pas dans la liste ci-dessus, ça n'a pas été demandé.\n" +
    "- Pour chaque exigence que tu déclares non satisfaite, tu DOIS mettre son identifiant exact " +
    '(forme [spec:12]) dans "specRefs", et CITER SON TEXTE ENTRE GUILLEMETS dans ton résumé. ' +
    'Une exigence invoquée sans être citée est invérifiable ; une citation inventée est rejetée.'
  )
}
