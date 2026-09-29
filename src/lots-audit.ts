// D4 (audit 2026-09-28, B3) — faire voir le PROJET ENTIER à l'audit, pas un préfixe.
//
// LE DEFAUT VISE. `renderFiles` concatène dans l'ordre reçu et s'arrête (`break`) au
// premier fichier qui déborde du cap de 24 000 caractères. Tout ce qui suit est
// simplement INVISIBLE. Mesure de l'écart faite par l'audit : 93 % de `src/` visible
// sur shining-tactics, mais 12 % sur etang-des-roseaux et 2 % sur toeic-quest.
//
// DEUX CORRECTIONS, indissociables :
//   1. TRI par risque AVANT découpe — `sortByPriority` (priority.ts) était écrit,
//      testé, documenté pour exactement ça, et consommé nulle part sur ce chemin.
//   2. LOTS successifs au lieu d'un préfixe unique : on découpe les fichiers triés en
//      autant de lots que nécessaire, chaque lot tient dans le cap, et les constats des
//      lots sont AGRÉGÉS. Un projet de 200 ko n'est plus jugé sur 12 %.
//
// Ce que ce module NE fait PAS : décider du verdict. Il produit une série de payloads
// et agrège des constats — la décision reste dans verdict.ts (règle durcie par D3).
import type { ProjectFile } from './types.js'
import { sortByPriority } from './priority.js'
import { renderFilesDetailed } from './fs-shared.js'

export interface LotsPayload {
  /** Un payload par lot, chacun ≤ `cap` caractères. */
  lots: string[]
  /** Nombre total de fichiers réellement inclus dans au moins un lot. */
  fichiersInclus: number
  /** Fichiers jamais inclus (même après découpage) — ne doit être non nul que si
   *  `maxLots` est atteint : c'est l'aveu honnête d'une couverture encore partielle. */
  fichiersOmis: number
  /** Le cap a-t-il mordu à l'intérieur d'un fichier (contenu tronqué) ? */
  tronque: boolean
}

/** Découpe des fichiers en lots bornés, en TRIANT d'abord par risque.
 *
 *  @param files    les fichiers candidats (déjà lus)
 *  @param cap      plafond de caractères par lot (le FILE_PAYLOAD_CAP historique)
 *  @param maxLots  garde-fou de coût : borne le nombre d'appels d'audit par branche.
 *                  Au-delà, on s'arrête et on COMPTE ce qui n'a pas été vu — plutôt
 *                  que de prétendre avoir tout vu.
 */
export function decouperEnLots(files: ProjectFile[], cap: number, maxLots = 8): LotsPayload {
  // 1. TRI PAR RISQUE : les points d'entrée (auth, routes, config, bootstrap) d'abord.
  //    `sortByPriority` est stable → à score égal, l'ordre de découverte est préservé.
  const chemins = sortByPriority(files.map((f) => f.path))
  const rang = new Map(chemins.map((p, i) => [p, i]))
  const tries = [...files].sort((a, b) => (rang.get(a.path) ?? 0) - (rang.get(b.path) ?? 0))

  // 2. LOTS successifs : on remplit un lot jusqu'au cap, puis on ouvre le suivant.
  //    Un fichier plus gros que le cap à lui seul est tronqué (et signalé) : on ne
  //    peut pas faire mieux sans le couper en morceaux, ce qui nuirait à la lecture.
  const lots: string[] = []
  let courant: ProjectFile[] = []
  let inclus = 0
  let tronque = false

  const taille = (fs_: ProjectFile[]): number => renderFilesDetailed(fs_, cap).text.length

  for (const f of tries) {
    const candidat = [...courant, f]
    const tient = taille(candidat) <= cap
    if (tient) {
      courant = candidat
      continue
    }
    // Le fichier ne tient pas dans le lot courant : on ferme le lot et on ouvre le suivant.
    if (courant.length > 0) {
      lots.push(renderFilesDetailed(courant, cap).text)
      inclus += courant.length
      courant = []
      if (lots.length >= maxLots) break
    }
    // Le fichier seul dépasse-t-il le cap ? → il est tronqué, on le signale.
    const seul = renderFilesDetailed([f], cap)
    if (seul.truncated) tronque = true
    courant = [f]
    // Un fichier énorme occupe un lot à lui seul ; la boucle suivante le fermera.
    if (seul.text.length >= cap) {
      lots.push(seul.text)
      inclus += 1
      courant = []
      if (lots.length >= maxLots) break
    }
  }
  if (courant.length > 0 && lots.length < maxLots) {
    lots.push(renderFilesDetailed(courant, cap).text)
    inclus += courant.length
  }

  return {
    lots,
    fichiersInclus: inclus,
    fichiersOmis: files.length - inclus,
    tronque,
  }
}

/** Fusionne les constats rendus lot par lot en UN constat, avec la règle de sûreté :
 *  un seul `fail` suffit à faire échouer (les constats ne s'annulent pas entre lots),
 *  et un `pass` n'est rendu que si TOUS les lots ont passé. S'il reste des fichiers
 *  non vus, le constat ne peut pas être un `pass` franc : il devient une couverture
 *  partielle, que verdict.ts (D3) sait traiter comme incomplète. */
export interface ConstatLot {
  status: 'pass' | 'fail' | 'skip' | 'not_applicable'
  summary: string
  rejectionId?: string
  correctiveAction?: string
  ruleRef?: string
}

export function agregerConstats(
  constats: ConstatLot[],
  couverturePartielle: boolean,
): ConstatLot {
  if (constats.length === 0) {
    return { status: 'skip', summary: 'Aucun lot audité.' }
  }
  const echec = constats.find((c) => c.status === 'fail')
  if (echec) {
    // Le PREMIER échec porte le rejet — ordre des lots = ordre de risque, donc le
    // constat le plus prioritaire gagne (même logique que verdict.ts).
    return {
      status: 'fail',
      summary: constats.length > 1 ? `[1/${constats.length} lots] ${echec.summary}` : echec.summary,
      rejectionId: echec.rejectionId,
      correctiveAction: echec.correctiveAction,
      ruleRef: echec.ruleRef,
    }
  }
  const tousPass = constats.every((c) => c.status === 'pass')
  if (tousPass) {
    // Un projet vu partiellement ne peut pas être déclaré conforme : on le dit.
    if (couverturePartielle) {
      return {
        status: 'skip',
        summary: `Tous les lots audités sont conformes, mais le projet n'a été vu que PARTIELLEMENT — conformité non démontrée.`,
      }
    }
    return { status: 'pass', summary: constats.map((c) => c.summary).join(' ') }
  }
  // Aucun échec, mais pas l'unanimité des `pass`. DEUX cas à ne pas confondre :
  //   • tous les non-pass sont des `not_applicable` (« rien à voir ici pour ma
  //     spécialité » — le cas d'un projet statique sans logique à tester) : le constat
  //     de branche est LÉGITIME, on le propage tel quel. L'écraser en `skip` ferait
  //     passer pour une PANNE ce qui est une réponse valable, et noierait le harnais
  //     sous des alertes fausses ;
  //   • au moins un vrai `skip` (panne de transport, couverture partielle, réponse
  //     illisible) : là le doute prime, et c'est `skip` qui doit remonter.
  const muets = constats.filter((c) => c.status !== 'pass')
  const queNonApplicable = muets.every((c) => c.status === 'not_applicable')
  if (queNonApplicable) {
    return {
      status: 'not_applicable',
      summary: muets.map((c) => c.summary).join(' ') || 'Hors spécialité pour ce projet.',
    }
  }
  return {
    status: 'skip',
    summary: muets.map((c) => c.summary).join(' ') || 'Audit incomplet.',
  }
}
