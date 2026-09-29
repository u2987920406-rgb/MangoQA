// Sonde de cerveau d'audit (D3, audit 2026-09-28 — defaut B1).
//
// LE DEFAUT VISE. La seule sonde de vivacite de MangoQA testait le PROCESS (un
// heartbeat de fichier, mangoqa.ts:22-36). MangoQA pouvait donc etre "actif" et
// INCAPABLE D'AUDITER quoi que ce soit, indefiniment : constate le 2026-09-24, les
// trois branches bloquantes rendaient `skip` avec le meme message ("Your organization
// has disabled Claude subscription access") et rien ne l'avait signale.
//
// CE QUE FAIT CETTE SONDE. Un appel de controle REEL au cerveau d'audit, au demarrage,
// avec une question dont la reponse est connue. Elle distingue trois etats :
//   - `ok`            : le cerveau repond -> on peut auditer.
//   - `panne`         : l'appel a LEVE sur les deux maillons -> rien ne peut etre juge,
//                       le harnais doit le CRIER (c'est le cas qui manquait a B1).
//   - `reponse_invalide` : le cerveau repond mais sa reponse n'est pas exploitable,
//                       ce qui reste un probleme mais different d'une indisponibilite.
//
// Ce qu'elle n'est PAS : un test du transport. Le but n'est pas de valider le reseau
// en general, mais de repondre a UNE question : "si un signal arrive maintenant, un
// verdict sera-t-il rendu ?"
//
// Injectabilite : `ask` est injectable pour que le test soit deterministe et sans
// reseau (meme discipline que auditWithLLM). Le module ne leve JAMAIS vers l'appelant.
import { askLLM } from './llm.js'

export type EtatSonde = 'ok' | 'panne' | 'reponse_invalide'

export interface ResultatSonde {
  etat: EtatSonde
  /** Maillon qui a repondu : 'primaire' (Claude/Sonnet) ou 'repli' (Ollama). */
  cerveau?: 'primaire' | 'repli'
  /** Message court, exploitable dans un log ou une alerte. */
  detail: string
  /** Le cerveau a-t-il repondu quelque chose d'exploitable ? */
  joignable: boolean
  dureeMs: number
}

/** Question de controle : la reponse attendue est connue a l'avance, ce qui permet de
 *  distinguer "repond" de "repond n'importe quoi". Volontairement minuscule (un appel
 *  de sonde ne doit pas consommer de quota serieusement). */
export const QUESTION_SONDE = 'Reponds uniquement par le mot OK, sans ponctuation ni explication.'
const ATTENDU = /ok/i

/**
 * Interroge le cerveau d'audit et rend un etat exploitable. Ne leve jamais.
 *
 * @param ask    injectable (tests) — defaut : le vrai askLLM (Claude primaire, Ollama repli).
 * @param timeoutMs garde-fou : une sonde qui pend est une sonde qui ne sert a rien.
 */
export async function sonderCerveauAudit(
  ask: (system: string, user: string) => Promise<string> = askLLM,
  timeoutMs = 30_000,
): Promise<ResultatSonde> {
  const debut = Date.now()
  const system = 'Tu es un auditeur QA. Reponds exactement ce qui est demande.'
  let reponse: string
  let cerveau: 'primaire' | 'repli' | undefined
  try {
    reponse = await avecDelai(ask(system, QUESTION_SONDE), timeoutMs)
    // askLLM encapsule la chaine primaire->repli ; on ne peut pas lui demander qui a
    // repondu. On le deduit prudemment : si le primaire avait echoue, askLLM aurait
    // journalise. On reste donc honnete et on n'invente pas le maillon quand il est
    // indeterminable — c'est `undefined`, pas une supposition.
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return {
      etat: 'panne',
      detail: `Le cerveau d'audit ne repond pas — aucun verdict ne peut etre rendu. Cause : ${detail}`,
      joignable: false,
      dureeMs: Date.now() - debut,
    }
  }
  const propre = reponse.trim()
  if (!propre) {
    return {
      etat: 'reponse_invalide',
      cerveau,
      detail: 'Le cerveau repond mais rend une reponse VIDE — les audits seraient illisibles.',
      joignable: false,
      dureeMs: Date.now() - debut,
    }
  }
  if (!ATTENDU.test(propre)) {
    // Reponse non conforme : le cerveau vit mais ne suit pas la consigne. Ce n'est pas
    // forcement bloquant (une reponse bavarde peut rester exploitable par le parseur
    // JSON), donc on le remonte sans le declarer en panne.
    return {
      etat: 'reponse_invalide',
      cerveau,
      detail: `Le cerveau repond mais pas la consigne attendue (recu : « ${propre.slice(0, 80)} »).`,
      joignable: true,
      dureeMs: Date.now() - debut,
    }
  }
  return {
    etat: 'ok',
    cerveau,
    detail: 'Le cerveau d\'audit repond — un verdict pourra etre rendu.',
    joignable: true,
    dureeMs: Date.now() - debut,
  }
}

/** Course entre une promesse et un delai. Le timer est TOUJOURS libere (sinon le
 *  process ne sortirait jamais, un classique des sondes mal ecrites). */
function avecDelai<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`sonde expiree apres ${ms} ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

/** Formatage pret a journaliser, avec un marqueur visuel non ambigu. */
export function formaterSonde(r: ResultatSonde): string {
  const tete = r.etat === 'ok' ? '✅ SONDE CERVEAU' : r.etat === 'panne' ? '🚨 SONDE CERVEAU' : '⚠️ SONDE CERVEAU'
  const maillon = r.cerveau ? ` (${r.cerveau})` : ''
  return `${tete}${maillon} — ${r.etat} en ${r.dureeMs} ms : ${r.detail}`
}
