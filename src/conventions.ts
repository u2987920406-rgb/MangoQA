// Lot 3 (ADR-001) — les CONVENTIONS DU DÉPÔT, axe *Standards*.
//
// Jusqu'ici, Mango QA jugeait un projet contre six spécialités figées dans son propre
// code. C'est ce qu'il sait de la qualité en général — ce n'est pas ce que CE dépôt a
// décidé. Un projet qui écrit « jamais de `default export` » ou « toute nouvelle route
// passe par le middleware d'auth » a énoncé une règle vérifiable, et un auditeur qui ne
// la lit pas juge à côté.
//
// Ce module lit ces règles. **Zéro LLM, entièrement déterministe** : il ne les comprend
// pas, il les localise. Chaque règle sort avec son **fichier et son numéro de ligne** —
// c'est ce qui rend la citation vérifiable en aval, et donc la trouvaille réfutable.
//
// ⚠️ LA RÈGLE QUI GOUVERNE CE FICHIER : une règle extraite doit TOUJOURS pointer une
// ligne qui existe vraiment. Tout ce qui est reformulé, fusionné ou déduit perd sa
// preuve — et une citation invérifiable est pire qu'une absence de citation, parce
// qu'elle a l'air d'en être une.
import path from 'node:path'
import type { FsLike } from './project-files.js'
import { realFs } from './project-files.js'

/** Une règle documentée du dépôt, localisée. */
export interface Convention {
  /** `<fichier>:<ligne>` — l'identifiant que le modèle doit citer, et qu'on vérifie. */
  id: string
  /** Chemin relatif au projet, séparateurs normalisés. */
  file: string
  /** Numéro de ligne, 1-indexé (ce qu'affiche un éditeur). */
  line: number
  /** Le texte de la règle, nettoyé de sa puce et borné. */
  text: string
}

export interface ConventionsScan {
  /** Fichiers de conventions réellement lus. Vide si le projet n'en documente aucun. */
  files: string[]
  /** Les règles extraites, dans l'ordre des fichiers puis des lignes. */
  rules: Convention[]
  /** Règles trouvées mais écartées par le cap — comptées, jamais tues. */
  dropped: number
  /** Fichiers de conventions trouvés mais jamais lus (cap `MAX_CONVENTION_FILES`). */
  filesDropped: string[]
  /** Vrai si AUCUN fichier de conventions n'existe. Déclaré, jamais supposé. */
  absent: boolean
}

/** Noms de fichiers de conventions reconnus, à la racine du projet.
 *
 *  Comparés en minuscules contre le VRAI listing du dossier plutôt que testés un par
 *  un avec `existsSync` : sur un système de fichiers sensible à la casse, `Claude.md`
 *  serait invisible à une liste en dur, et le projet passerait pour non documenté —
 *  c'est-à-dire exactement le mensonge que ce lot doit éviter. */
const FICHIERS_RACINE = new Set([
  'claude.md',
  'agents.md',
  'contributing.md',
  'conventions.md',
  'styleguide.md',
  'style_guide.md',
  '.cursorrules',
  '.windsurfrules',
  '.editorconfig',
])

/** Fichiers de conventions nichés dans un sous-dossier connu des outils du marché. */
const CHEMINS_NICHES = [
  '.github/copilot-instructions.md',
  '.cursor/rules', // dossier : tous les `.mdc`/`.md` dedans
]

/** Bornes. Un auditeur qui avale 4 000 lignes de CONTRIBUTING.md noie ses six
 *  spécialités sous du texte et rend un prompt plus cher pour un jugement plus flou.
 *  Ce qui dépasse est COMPTÉ et déclaré, jamais abandonné en silence. */
export const MAX_CONVENTION_FILES = 6
export const MAX_CONVENTION_FILE_CHARS = 40_000
export const MAX_RULE_CHARS = 220
export const DEFAULT_MAX_RULES = 60

function maxRules(): number {
  const raw = parseInt((process.env.QA_CONVENTIONS_CAP ?? '').trim(), 10)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_RULES
}

/** Marqueurs normatifs — ce qui distingue « la commande de build est `npm run build` »
 *  (une information) de « le build DOIT rester vert » (une règle).
 *
 *  Français et anglais : les deux se croisent dans un même dépôt, et se limiter à
 *  l'anglais raterait la moitié des règles d'un projet francophone comme celui-ci. */
const NORMATIF =
  /\b(doit|doivent|devra|ne pas|jamais|toujours|interdit|obligatoire|impératif|impérative|exige|requis|veiller à|éviter|proscrit|must|should|never|always|forbidden|required|do not|don't|avoid|ensure|prefer)\b/i

/** Une puce de liste markdown, numérotée ou non. */
const PUCE = /^\s{0,6}(?:[-*+]|\d{1,3}[.)])\s+(.*)$/

/** Nettoie un texte de règle : formatage markdown allégé, espaces normalisés, borné. */
function nettoyer(brut: string): string {
  const plat = brut
    .replace(/`([^`]*)`/g, '$1') // code inline : le contenu compte, pas les accents graves
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/(?<!\w)[*_]([^*_]+)[*_](?!\w)/g, '$1')
    .replace(/^#{1,6}\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plat.length > MAX_RULE_CHARS ? `${plat.slice(0, MAX_RULE_CHARS)}…` : plat
}

/** Extrait les règles d'un fichier markdown, avec leur ligne réelle.
 *
 *  Deux formes retenues, et deux seulement : une **puce de liste** (la forme
 *  canonique d'une convention) et une **phrase normative** hors liste. Le reste du
 *  texte — titres, prose explicative, exemples — n'est pas une règle : le prendre
 *  gonflerait le prompt de contexte que le modèle prendrait pour des obligations.
 *
 *  Les blocs de code sont ignorés : une puce dans un exemple `\`\`\`` illustre une
 *  règle, elle n'en est pas une, et la citer enverrait le lecteur sur un extrait. */
export function extraireReglesMarkdown(contenu: string, fichier: string): Convention[] {
  const out: Convention[] = []
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
    const brut = puce ? puce[1] : ligne
    // Une puce est une règle par sa FORME ; une ligne de prose doit prouver sa nature
    // par un marqueur normatif, sinon c'est de l'explication.
    if (!puce && !NORMATIF.test(brut)) continue
    if (!puce && /^\s{0,3}#{1,6}\s/.test(ligne)) continue // un titre n'est pas une règle

    const texte = nettoyer(brut)
    // Trop court = une puce de sommaire ou un fragment ; trop long a déjà été borné.
    if (texte.length < 12) continue
    if (/^\[[^\]]+\]\([^)]*\)$/.test(texte)) continue // puce de lien seul (index, sommaire)

    out.push({ id: `${fichier}:${i + 1}`, file: fichier, line: i + 1, text: texte })
  }
  return out
}

/** `.editorconfig` : chaque affectation `clé = valeur` est une règle vérifiable, et
 *  elle est la plus objective de toutes (« indent_style = tab » se constate). La
 *  section `[*.ts]` est reportée dans le texte pour que la règle reste lisible seule. */
export function extraireReglesEditorconfig(contenu: string, fichier: string): Convention[] {
  const out: Convention[] = []
  let section = '*'
  const lignes = contenu.split(/\r?\n/)
  for (let i = 0; i < lignes.length; i++) {
    const ligne = lignes[i].trim()
    if (!ligne || ligne.startsWith('#') || ligne.startsWith(';')) continue
    const sec = /^\[(.+)\]$/.exec(ligne)
    if (sec) {
      section = sec[1]
      continue
    }
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(ligne)
    if (!kv) continue
    out.push({
      id: `${fichier}:${i + 1}`,
      file: fichier,
      line: i + 1,
      text: `pour ${section} : ${kv[1]} = ${kv[2].trim()}`,
    })
  }
  return out
}

/** Nombre de dossiers PARENTS explorés au-delà du dossier audité.
 *
 *  Les conventions appartiennent au DÉPÔT, pas au dossier qu'on a pointé. Quelqu'un qui
 *  lance `mangoqa ./src` ou `mangoqa packages/api` ne renonce pas au `CLAUDE.md` de la
 *  racine — et sans cette remontée, Mango QA déclarerait « aucune convention documentée »
 *  sur un dépôt qui en a écrit trente. Ce serait un mensonge de la même famille que ceux
 *  des lots précédents : affirmer une absence qu'on n'a pas vérifiée.
 *
 *  Borné, et la remontée s'arrête à la racine du dépôt (le dossier qui porte `.git`) :
 *  au-delà, on lirait les règles d'un projet voisin, ou celles du dossier personnel. */
const MAX_PARENTS = 4

/** Les fichiers de conventions d'UN dossier, sans remontée. */
function fichiersDuDossier(dir: string, fsx: FsLike): string[] {
  const out: string[] = []
  try {
    for (const entree of fsx.readdirSync(dir)) {
      if (entree.isDirectory()) continue
      if (FICHIERS_RACINE.has(entree.name.toLowerCase())) out.push(entree.name)
    }
  } catch {
    /* dossier illisible : on continue, l'absence sera déclarée comme telle */
  }

  for (const niche of CHEMINS_NICHES) {
    const abs = path.join(dir, niche)
    try {
      if (!fsx.existsSync(abs)) continue
      if (fsx.isFile(abs)) {
        out.push(niche)
        continue
      }
      for (const entree of fsx.readdirSync(abs)) {
        if (entree.isDirectory()) continue
        if (/\.(mdc?|markdown)$/i.test(entree.name)) out.push(`${niche}/${entree.name}`)
      }
    } catch {
      /* niche illisible : ignorée, jamais fatale */
    }
  }
  return out
}

/** Localise et lit les conventions d'un projet, en remontant jusqu'à la racine du
 *  dépôt. Ne lève jamais (fail-open : un CONTRIBUTING.md illisible ne doit pas
 *  empêcher l'audit du code). */
export function scanConventions(projectDir: string, fsx: FsLike = realFs): ConventionsScan {
  const fichiers: string[] = []

  // Le dossier audité d'abord — ses règles priment naturellement dans l'ordre de
  // lecture — puis les parents. Un paquet de monorepo peut ajouter ses propres règles
  // par-dessus celles de la racine : les deux jeux sont vrais, on garde les deux.
  let courant = projectDir
  for (let niveau = 0; niveau <= MAX_PARENTS; niveau++) {
    const prefixe = niveau === 0 ? '' : '../'.repeat(niveau)
    for (const f of fichiersDuDossier(courant, fsx)) fichiers.push(`${prefixe}${f}`)

    // Racine du dépôt atteinte : au-delà, ce ne sont plus les règles de ce projet.
    let estRacineDepot = false
    try {
      estRacineDepot = fsx.existsSync(path.join(courant, '.git'))
    } catch {
      /* ignoré */
    }
    if (estRacineDepot) break

    const parent = path.dirname(courant)
    if (parent === courant) break // racine du système de fichiers
    courant = parent
  }

  // Ordre STABLE — deux audits du même dépôt doivent donner les mêmes identifiants de
  // règles, sinon comparer deux rapports dans le temps n'a plus de sens. Le plus
  // PROCHE d'abord : si le cap coupe, il doit garder les règles du dossier audité
  // plutôt que celles d'un ancêtre lointain.
  const profondeur = (f: string): number => (f.match(/\.\.\//g) ?? []).length
  fichiers.sort((a, b) => profondeur(a) - profondeur(b) || a.localeCompare(b))
  const retenus = fichiers.slice(0, MAX_CONVENTION_FILES)

  const rules: Convention[] = []
  for (const rel of retenus) {
    try {
      const abs = path.join(projectDir, rel)
      let contenu = fsx.readFileSync(abs)
      if (contenu.length > MAX_CONVENTION_FILE_CHARS) contenu = contenu.slice(0, MAX_CONVENTION_FILE_CHARS)
      const norm = rel.replace(/\\/g, '/')
      rules.push(
        ...(/\.editorconfig$/i.test(rel)
          ? extraireReglesEditorconfig(contenu, norm)
          : extraireReglesMarkdown(contenu, norm)),
      )
    } catch {
      /* fichier illisible : ignoré */
    }
  }

  const cap = maxRules()
  const gardees = rules.slice(0, cap)
  return {
    files: retenus.map(f => f.replace(/\\/g, '/')),
    rules: gardees,
    dropped: rules.length - gardees.length,
    filesDropped: fichiers.slice(MAX_CONVENTION_FILES).map(f => f.replace(/\\/g, '/')),
    // `absent` porte sur les FICHIERS, pas sur les règles : un CONTRIBUTING.md de pure
    // prose donne 0 règle sans que le projet soit « non documenté ». Confondre les deux
    // ferait dire à l'auditeur qu'il n'y avait rien à lire alors qu'il n'a rien su lire.
    absent: fichiers.length === 0,
  }
}

/** Index des règles par identifiant — pour vérifier une citation en O(1). */
export function indexer(rules: Convention[]): Map<string, Convention> {
  return new Map(rules.map(r => [r.id, r]))
}

/** Bloc de conventions INJECTÉ DANS LE PROMPT des branches.
 *
 *  Deux versions, et la seconde compte autant que la première :
 *
 *  • **Des conventions existent** → elles sont listées avec leur identifiant, et le
 *    modèle a l'ordre de citer celui de toute règle sur laquelle il s'appuie. Sans cet
 *    identifiant, une trouvaille « ça ne respecte pas vos conventions » est invérifiable.
 *
 *  • **Aucune convention n'existe** → on le DIT. C'est le critère d'achèvement du lot :
 *    sans cette phrase, un modèle à qui on ne parle pas de conventions en invente —
 *    il juge contre les habitudes moyennes d'internet et les présente comme les règles
 *    de la maison. Un reproche fondé sur une règle que personne n'a écrite est un faux
 *    positif que l'utilisateur ne peut même pas contester.
 *
 *  Couverture complète du sujet impossible : ce bloc ne prétend pas que toutes les
 *  règles ont été vérifiées, seulement qu'elles ont été FOURNIES. */
export function conventionsBlock(scan: ConventionsScan | undefined): string {
  if (!scan) return ''
  if (scan.absent || scan.rules.length === 0) {
    return (
      "\n\nCONVENTIONS DU DÉPÔT : ce projet n'en documente aucune que je puisse lire" +
      (scan.absent ? '' : ` (${scan.files.join(', ')} lu(s), aucune règle explicite trouvée)`) +
      ". N'invoque donc AUCUNE règle de style, de nommage ou d'organisation comme si " +
      "elle venait du projet : tu n'en connais aucune. Juge uniquement sur ta spécialité, " +
      'et ne reproche jamais le non-respect d\'une convention que personne n\'a écrite.'
    )
  }
  const lignes = [
    `\n\nCONVENTIONS DU DÉPÔT — ${scan.rules.length} règle(s) écrite(s) par ce projet, dans ${scan.files.join(', ')} :`,
  ]
  for (const r of scan.rules) lignes.push(`[${r.id}] ${r.text}`)
  lignes.push(
    'Ces règles font autorité sur tes habitudes : ce dépôt a le droit de décider autrement ' +
      "que l'usage courant. Si tu signales le non-respect de l'une d'elles, tu DOIS mettre son " +
      'identifiant exact (la forme [fichier:ligne] ci-dessus) dans le champ "conventionRefs" — ' +
      "une citation absente ou inventée fait rejeter la référence. N'invente jamais une règle qui " +
      "ne figure pas dans cette liste, et ne cite pas une règle que le code fourni ne contredit pas.",
  )
  return lignes.join('\n')
}
