# `docs/` — le cap et la face visible de Mango QA

| Fichier | Ce que c'est |
|---|---|
| **`adr/ADR-001-cap-produit.md`** | **La référence unique.** Décisions de cap, plan d'exécution par lots, et ce qu'on ne fait PAS. En cas de contradiction avec n'importe quel autre document, c'est lui qui gagne. |
| `produit.html` | Maquette de page produit : à quoi sert Mango QA, pourquoi, pour qui, comment il s'utilise. Page autonome, ouvrable hors ligne. |

> ⚠️ **Avant d'ouvrir un chantier, lire l'ADR-001.** Une idée qui n'entre dans aucun lot
> ne se code pas — elle rejoint la liste « ce qu'on ne fait pas », ou attend l'ADR suivant.
> Les trois seules portes de révision sont au § 5.

## L'angle de vente, et pourquoi c'est celui-là

Le marché est plein d'auditeurs de code par IA. Se vendre sur la puissance du modèle
serait perdre d'avance — le modèle change tous les six mois et n'appartient à personne.

L'argument retenu est le seul qui soit **structurel** :

> **Mango QA déclare ce qu'il n'a pas lu.**

Ce n'est pas une trouvaille marketing habillée après coup. C'est le défaut n°2 de J1
(`eval/rapports/J1-DETACHER.md`), corrigé en J2 : la couverture est mesurée à trois
étages, injectée dans le prompt, portée par le rapport, par le verdict, et rendue
**champ obligatoire** du schéma de sortie MCP.

Le raisonnement commercial tient en deux phrases : un faux positif se voit et
s'ignore ; une omission ne se voit pas. C'est la seconde qui coûte cher, et c'est la
seule que personne d'autre ne traite.

## La règle qui gouverne cette page

**Tout chiffre affiché doit être traçable à une mesure datée.** Les sources sont
listées en commentaire en tête de `produit.html`. Une page produit qui avance un
chiffre invérifiable ruinerait précisément l'argument qu'elle défend.

Corollaire : la section « Ce que cette mesure n'établit pas » reste. Un outil qui
demande à son acheteur de ne pas croire les logiciels sur parole ne peut pas, dans la
même page, lui demander de le croire sur parole. Publier son propre taux d'erreur est
ce qu'aucun concurrent ne fera — c'est ce qui rend le reste crédible.

## Faire évoluer la page

Elle est volontairement en **un seul fichier sans dépendance** : ni police distante,
ni script, ni image. Elle s'ouvre hors ligne, se joint à un courriel, se dépose sur
n'importe quel hébergement statique. Garder cette propriété.

Après une nouvelle éval, remettre à jour les nombres **avant** de rediffuser — et
mettre à jour la date en tête de fichier, pas seulement les chiffres.
