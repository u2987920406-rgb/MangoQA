// Préflight du cerveau d'audit — « ce cerveau sait-il rendre un verdict ? »
//
// (2026-08-05, ADR-001 lot 2 / faille J4-a) Volet 1 de la fermeture du trou
// d'honnêteté. Le défaut mesuré : un modèle qui RÉPOND mais ne tient pas le contrat
// JSON (trop petit, non-instruct) fait tomber les six branches en `skip`, et Mango QA
// rendait **feu vert, couverture complète, code 0** — sur du code contenant un vrai
// défaut. En CI, ça passait.
//
// Le volet 2 (remontée des abstentions, `verdict.ts`) suffirait à ne plus mentir.
// Ce volet-ci existe pour une autre raison : **ne pas faire perdre des minutes**.
// Sans lui, découvrir qu'un cerveau est inutilisable coûte un audit complet — six
// appels de plusieurs minutes chacun sur cerveau local — pour n'apprendre à la fin
// que rien n'a été jugé. Un aller-retour de quelques centaines de millisecondes le dit
// avant.
//
// Les deux volets sont nécessaires et aucun ne remplace l'autre : le préflight ne
// couvre pas la dégradation EN COURS de run (un cerveau qui répond au test puis
// déraille), les abstentions ne couvrent pas le coût d'un échec tardif.
//
// ⚠️ Ce module valide la réponse avec `parseFirstJson` — LE MÊME lecteur que la
// production. Un préflight qui validerait par une expression régulière testerait
// autre chose que ce qui tourne : il pourrait déclarer bon un cerveau que
// `auditWithLLM` refuse ensuite, ce qui rendrait le préflight pire qu'absent.
import { askLLM, cerveauPrimaire, parseFirstJson, type Cerveau } from './llm.js'

/** Prompt minimal : on ne mesure pas la QUALITÉ du jugement (c'est le rôle du corpus
 *  d'évaluation), seulement la capacité à répondre par un objet JSON exploitable —
 *  la condition sans laquelle aucune branche ne peut rendre de verdict. */
const SYSTEME = 'Tu réponds UNIQUEMENT par un objet JSON valide, sans aucun texte autour.'
const DEMANDE = 'Réponds exactement ceci et rien d\'autre : {"ok":true}'

export interface ResultatPreflight {
  ok: boolean
  /** Le cerveau réellement interrogé, tel que la production le choisira. */
  cerveau: Cerveau
  /** Phrase courte, actionnable, destinée à l'utilisateur. Vide si `ok`. */
  probleme: string
  dureeMs: number
}

/** Interroge le cerveau primaire et dit s'il peut servir d'auditeur.
 *
 *  Ne lève JAMAIS : un préflight qui plante serait une deuxième panne à diagnostiquer
 *  par-dessus la première. L'échec est une VALEUR, que l'appelant traduit dans sa
 *  propre monnaie (code de sortie pour la CLI, erreur d'outil pour MCP). */
export async function preflightCerveau(
  deps: { ask?: (system: string, user: string) => Promise<string>; now?: () => number } = {},
): Promise<ResultatPreflight> {
  const ask = deps.ask ?? askLLM
  const now = deps.now ?? (() => Date.now())
  const cerveau = cerveauPrimaire()
  const t0 = now()
  try {
    const raw = await ask(SYSTEME, DEMANDE)
    const parsed = parseFirstJson<{ ok?: unknown }>(raw)
    if (parsed === null) {
      return {
        ok: false,
        cerveau,
        probleme:
          "le cerveau a répondu, mais hors du contrat JSON — il ne pourra rendre aucun verdict. " +
          'Un modèle trop petit ou non-instruct donne exactement ce symptôme.',
        dureeMs: now() - t0,
      }
    }
    // Le contenu est volontairement peu exigeant : ce qui est testé est la capacité à
    // produire un objet JSON lisible, pas l'obéissance au mot près. Exiger `ok === true`
    // recalerait des cerveaux parfaitement capables d'auditer pour un caprice de forme.
    return { ok: true, cerveau, probleme: '', dureeMs: now() - t0 }
  } catch (err) {
    return {
      ok: false,
      cerveau,
      probleme: `le cerveau n'a pas répondu (${err instanceof Error ? err.message : String(err)})`,
      dureeMs: now() - t0,
    }
  }
}

/** Message d'échec complet, avec la piste de résolution propre au cerveau choisi.
 *  Centralisé ici pour que la CLI, MCP et l'API disent la même chose — un diagnostic
 *  qui varie selon la porte d'entrée est un diagnostic qu'on ne peut pas suivre. */
export function messagePreflight(r: ResultatPreflight): string {
  const piste =
    r.cerveau === 'ollama'
      ? "Vérifie que le daemon Ollama tourne (`ollama serve`), que QA_OLLAMA_MODEL désigne un modèle installé (`ollama list`), et privilégie un modèle *instruct* d'au moins 7B."
      : 'Vérifie que @anthropic-ai/claude-agent-sdk est installé et que la session Claude Code est active, puis QA_MODEL.'
  return (
    `Cerveau « ${r.cerveau} » inutilisable : ${r.probleme}\n` +
    `${piste}\n` +
    "Aucun audit n'a été lancé : un rapport rendu par un cerveau qui ne juge pas vaut moins que pas de rapport du tout."
  )
}

/** Levée par `auditProject` quand le préflight échoue. Type distinct pour que les
 *  appelants ne confondent PAS « environnement inutilisable » (à corriger par
 *  l'utilisateur) avec « défaut trouvé dans le code » (le produit du travail). */
export class CerveauInutilisableError extends Error {
  constructor(public readonly resultat: ResultatPreflight) {
    super(messagePreflight(resultat))
    this.name = 'CerveauInutilisableError'
  }
}
