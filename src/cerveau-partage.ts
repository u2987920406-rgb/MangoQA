// B16 (audit 2026-09-28) — le cerveau de l'auditeur et le registre partage.
//
// LE DEFAUT VISE. MangoOS choisit ses cerveaux dans `server/data/brain-registry.json`
// (Atelier) ; MangoQA choisissait le sien dans `QA_OLLAMA_MODEL` / `QA_MODEL`, sans
// AUCUN lien. Consequence : changer de cerveau dans l'Atelier ne changeait rien a
// l'auditeur — et RIEN ne le signalait. C'est la version inter-depots du probleme des
// « 3 registres ».
//
// CE QUE CE MODULE FAIT, et pourquoi dans cet ordre :
//   1. Il lit le role `auditeur` du registre partage (chemin surchargeable par
//      `MANGOAI_BRAIN_REGISTRY` ; sinon le depot frere ~/projets/mangoai).
//   2. Un choix EXPLICITE dans l'environnement de MangoQA reste prioritaire — on ne
//      reecrit jamais un choix de l'exploitant dans son dos.
//   3. Mais une divergence est SIGNALEE. C'est le coeur du correctif : le defaut
//      n'etait pas la divergence, c'etait le SILENCE.
//   4. Sans choix explicite, MangoQA suit le registre : c'est desormais le sens
//      attendu (« je change le cerveau auditeur dans l'Atelier, l'audit suit »).
//
// Ne leve JAMAIS : un registre absent ou illisible n'est pas une panne d'audit.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ICI = path.dirname(fileURLToPath(import.meta.url))

/** Chemin du registre partage. Surcharge par env, sinon le depot frere. */
export function cheminRegistre(env: NodeJS.ProcessEnv = process.env): string {
  const force = (env.MANGOAI_BRAIN_REGISTRY ?? '').trim()
  if (force) return force
  // Candidats dans l'ordre : le depot frere `mangoai`, puis en remontant depuis le
  // depot COURANT (robuste a un checkout ailleurs). On ne devine jamais un chemin
  // absolu en dur : un chemin faux serait un mensonge silencieux — exactement B16.
  // ICI = <depot>/src → '..','..' remonte a la racine `projets/`, ou vit le depot frere.
  const relatifs = [
    path.resolve(ICI, '..', '..', 'mangoai', 'server', 'data', 'brain-registry.json'),
    path.resolve(ICI, '..', '..', '..', 'mangoai', 'server', 'data', 'brain-registry.json'),
  ]
  return relatifs.find((p) => fs.existsSync(p)) ?? relatifs[0]!
}

export interface CerveauPartage {
  provider: string
  model: string
  /** Ou on l'a lu — utile pour dire d'ou vient la verite. */
  source: string
}

/** Role dont MangoQA est l'implementation cote audit. */
export const ROLE_AUDITEUR = 'auditeur'

/** Lit le cerveau du role `auditeur` dans le registre partage. `null` si illisible. */
export function lireCerveauAuditeur(env: NodeJS.ProcessEnv = process.env): CerveauPartage | null {
  try {
    const p = cheminRegistre(env)
    if (!fs.existsSync(p)) return null
    const brut = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
    const role = brut?.[ROLE_AUDITEUR] as { provider?: unknown; model?: unknown } | undefined
    const provider = typeof role?.provider === 'string' ? role.provider : ''
    const model = typeof role?.model === 'string' ? role.model : ''
    if (!provider && !model) return null
    return { provider, model, source: p }
  } catch {
    return null
  }
}

export interface ResolutionCerveau {
  /** Le modele que QA_OLLAMA_MODEL doit valoir (voie Ollama de l'audit). */
  modeleOllama: string | null
  /** Vrai quand l'exploitant a fixe la valeur lui-meme : on ne la remplace pas. */
  choixExplicite: boolean
  /** Message de divergence a journaliser, ou `null` si tout concorde. */
  divergence: string | null
  partage: CerveauPartage | null
}

/**
 * Resout le cerveau de la voie Ollama de MangoQA a partir du registre partage.
 * Ne modifie RIEN : renvoie la decision, l'appelant l'applique et la signale.
 */
export function resoudreCerveauAudit(env: NodeJS.ProcessEnv = process.env): ResolutionCerveau {
  const partage = lireCerveauAuditeur(env)
  const explicite = (env.QA_OLLAMA_MODEL ?? '').trim()
  if (!partage) {
    return { modeleOllama: explicite || null, choixExplicite: !!explicite, divergence: null, partage: null }
  }
  // Le registre porte le modele nu (`deepseek-v4.1-flash`) ; la voie Ollama de MangoQA
  // attend le meme nom. On ne prefixe jamais « provider/ » ici.
  const attendu = partage.model.trim()
  if (!explicite) {
    return { modeleOllama: attendu || null, choixExplicite: false, divergence: null, partage }
  }
  if (explicite === attendu) {
    return { modeleOllama: explicite, choixExplicite: true, divergence: null, partage }
  }
  return {
    modeleOllama: explicite,
    choixExplicite: true,
    divergence:
      `cerveau de l'auditeur DESALIGNE du registre partage : MangoQA utilise « ${explicite} » ` +
      `(QA_OLLAMA_MODEL) alors que l'Atelier declare « ${attendu || '(aucun modele)'} » ` +
      `pour le role « ${ROLE_AUDITEUR} » (${partage.source}). ` +
      `Changer le cerveau dans l'Atelier ne change PAS l'audit tant que ce desaccord dure.`,
    partage,
  }
}

/** Applique la resolution a l'environnement du process (a appeler au demarrage).
 *  Renvoie le message a journaliser, ou `null`. Ne leve jamais. */
export function alignerCerveauAudit(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const r = resoudreCerveauAudit(env)
    if (r.divergence) return `[mango-qa] ⚠️ ${r.divergence}`
    if (!r.choixExplicite && r.modeleOllama) {
      // Suit le registre : on materialise le choix pour que les modules qui lisent
      // l'environnement au chargement (ollama-client.ts) voient la meme verite.
      env.QA_OLLAMA_MODEL = r.modeleOllama
      return `[mango-qa] cerveau d'audit (voie Ollama) aligne sur le registre partage : « ${r.modeleOllama} »`
    }
    return null
  } catch {
    return null
  }
}
