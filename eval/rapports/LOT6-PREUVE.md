# Lot 6 (ADR-001) — Prouver

> Clos le **2026-08-08**.
> Critère d'achèvement fixé par l'ADR : *« `docs/produit.html` ne contient plus un seul
> chiffre issu de l'ère du cerveau local. »* — **atteint**, et le corpus complet est
> re-mesuré sous Opus 5, tableau et limites publiés.

C'est le lot qui décide si le produit mérite d'exister. Tous les chiffres affichés
jusqu'ici avaient été rendus par `qwen2.5-coder:14b`, alors que la décision **D1** a fait
d'Opus 5 le cerveau par défaut le 2026-08-05. Deux audits rendus par deux cerveaux
différents ne sont pas comparables : republier un ancien chiffre sous le nouveau nom
aurait été la faute exacte qu'on reproche aux générateurs.

---

## La mesure

**32 cas** (24 à défaut · 8 contrôles propres), **2 passes**, **88 observations**,
cerveau `claude-opus-5` en primaire, **aucun repli**, 776,5 s.

| Branche | Détection | Ratés | Faux positifs | Abstentions | Pannes | Instables | Durée moy. |
|---|---|---|---|---|---|---|---|
| architecture | **4/4** (100 %) | 0 | 0/10 | 0 | — | 0 | 8,4 s |
| security | **6/6** (100 %) | 0 | 0/4 *(+4 hors périmètre)* | 0 | — | 0 | 7,0 s |
| accessibility | **5/5** (100 %) | 0 | **2/8** *(+2 hors périmètre)* | 0 | — | 0 | 11,1 s |
| performance | **4/4** (100 %) | 0 | 0/10 | 4 | — | 0 | 9,1 s |
| tests | **1/1** (100 %) | 0 | 0/4 | 0 | **2** | 0 | 8,5 s |
| design-system *(conseil)* | **4/4** mentions | 0 | 0/4 | 0 | — | 0 | 7,8 s |

**Zéro défaut raté sur les 88 observations. Zéro verdict instable. Deux fausses alertes,
toutes deux en accessibilité, sur le même fichier aux deux passes.**

### Les 4 abstentions de `performance` sont le bon comportement

Elles portent sur `CLEAN-02` et `LONG-04` — du code serveur Node/SQL. La branche répond
« aucun code client React ni chemin de bundle : hors de ma spécialité ». C'est un
**jugement rendu**, pas un trou : elle a regardé et a décliné, en disant pourquoi.

### Les 2 pannes de `tests` ne sont pas un échec de jugement

`LONG-05`, aux deux passes : `Reached maximum number of turns (1)` — une défaillance
transitoire du SDK Claude. Le cas sort du dénominateur de détection et s'affiche dans sa
propre colonne. Voir plus bas : c'est l'instrument qui a dû apprendre à faire cette
différence.

---

## Trois défauts de l'INSTRUMENT, trouvés avant de publier quoi que ce soit

Un chiffre publié sous de mauvaises conditions est pire qu'aucun chiffre. Les trois ont
été corrigés, et la mesure relancée à chaque fois.

### L6-a — l'en-tête se trompait sur son propre cerveau

Il lisait `QA_OLLAMA_MODEL` et **ignorait `QA_BRAIN`** : écrit avant que le cerveau
devienne sélectionnable (lot 0), jamais mis à jour. La première mesure du corpus sous
Opus 5 s'est donc annoncée *« cerveau `qwen2.5-coder:14b`, repli Claude ACTIF »* alors
qu'aucun octet n'était parti vers Ollama.

**Tranché par une preuve, pas par une lecture de code** : `OLLAMA_URL` pointé sur un port
mort, l'audit répond quand même en 9,8 s, sans une seule tentative de repli. C'était bien
Opus 5. Le harnais appelle désormais `cerveauPrimaire()`, **la même fonction que la
production**, au lieu de deviner d'après une variable d'environnement.

> **Deuxième occurrence de cette faute exacte** (cf. J2-d, corrigé le 2026-08-05). Un
> instrument qui décrit mal ses conditions ne mesure rien.

### L6-c — l'instrument avait un LOT DE RETARD sur le produit qu'il mesure

Depuis le lot 2, `BranchFinding.abstention` distingue un **jugement rendu** (« pas ma
spécialité ») d'une **panne** de l'auditeur (cerveau injoignable, réponse hors contrat).
Le harnais fondait les deux dans un seul « abstention ».

**Conséquence mesurée** : 3 pannes transitoires du SDK faisaient tomber `architecture` à
**3/4** et `tests` à **1/2** — des scores de *jugement* dégradés par des incidents de
*réseau*. Publier ça aurait été faux, dans le sens pessimiste cette fois.

Le harnais lit maintenant `estPanne()`. Une panne sort de tous les dénominateurs de
qualité, ne compte plus comme un verdict divergent, et s'affiche **dans sa propre
colonne** : la fondre dans les abstentions noircissait le score, la taire l'aurait
flatté.

### L6-b — un test qui ne tourne pas tout seul finit par mentir

`tests/manual/test-mcp-stdio.ts` affirmait « les 6 branches sont listées » en dur. Le
lot 4 en a ajouté une septième ; la suite Vitest est restée verte et le test manuel n'a
rien dit, parce que **personne ne l'exécute**. Trouvé en le lançant à la main, deux lots
plus tard. L'attendu vient désormais de `ALL_BRANCHES.length`.

---

## La fausse alerte, publiée avec son analyse

`LONG-01` → `accessibility`, aux deux passes. La branche a signalé un **saut de niveau de
titre** : les cartes du catalogue sont des `h3` et la grille de résultats n'a aucun `h2`
(le seul `h2` du fichier est dans l'`aside` des favoris).

**Vérifié à la main dans le corpus : le fait est exact.** Ce n'est donc pas une
hallucination — c'est le corpus qui a affirmé plus qu'il ne pouvait. `LONG-01` a été
écrit comme le **contrôle négatif des clés de liste**, pas comme un contrôle
d'accessibilité, et son `accessibility: 'pass'` n'a jamais été vérifié pour ce qu'il
prétend. C'est exactement la situation rencontrée le 2026-08-05 avec `architecture` sur
ce même fichier.

> **L'assertion n'a PAS été retirée** (faille L6-d, ouverte délibérément). Éditer un
> corpus juste après avoir vu un résultat défavorable, dans la même séance, détruit la
> crédibilité d'une mesure même quand c'est défendable. Le chiffre publié est celui
> mesuré **contre le corpus tel qu'il était**. À trancher à froid.
>
> L'accessibilité conserve de toute façon un vrai contrôle propre construit pour elle,
> `LONG-08`, et il passe aux deux passes.

---

## Sur projet réel : `abyss`, quatre fois

Quatre audits du même projet (20 fichiers, couverture complète à chaque fois). Les
trouvailles sont **stables et vraies** :

- une carte de catalogue ouvrable à la souris seulement (`div onClick` sans rôle ni
  clavier) — WCAG 2.2 2.1.1, avec un correctif qui va jusqu'à signaler qu'un `<button>`
  imbriqué dans un `<button>` serait invalide ;
- l'état de scroll vivant à la racine de `App`, re-rendant tout l'arbre à ~60 fps.

**Et un signal du lot 3 en conditions réelles** : la branche Tests a justifié son feu vert
en s'appuyant sur les conventions du dépôt — *« le dépôt n'exige que `tsc --noEmit` +
`npm run build` »*, une vraie règle du `CLAUDE.md` de MangoOS, trouvé par la remontée aux
dossiers parents. Sous le cerveau local, cette même branche rendait un feu **rouge**
(« aucun fichier de test n'existe »). **L'axe *Standards* a changé un verdict, sur du
vrai code.**

### Mais `cited` est resté vide (L6-e)

Le modèle a **paraphrasé** la règle dans son résumé sans mettre son identifiant dans
`conventionRefs`. Le champ `cited` du rapport reste donc `[]` alors qu'une convention a
manifestement pesé sur le verdict.

C'est le miroir de l'avertissement déjà écrit au lot 3 (« une règle non citée peut avoir
été vérifiée ») : ici, une règle non citée a été **utilisée**. `cited` sous-compte l'usage
réel des conventions. Le mécanisme de vérification reste bon — il empêche les citations
inventées — mais il ne mesure pas ce qu'on croyait.

### Et une panne qui n'est pas aléatoire (L6-f)

`architecture` est tombée en `Reached maximum number of turns (1)` sur **3 des 4 runs**
d'`abyss`. C'est la branche au plus gros prompt (19 fichiers). Le taux global sur toute la
journée est de l'ordre de **3 %** des appels, mais il n'est **pas uniforme** : il se
concentre sur les prompts les plus longs. Ce n'est pas du bruit, c'est une contrainte.

> **La page produit affiche ce run-là, panne comprise.** L'auditeur a trouvé deux vrais
> défauts et refuse quand même de vendre le verdict comme complet. C'est exactement ce que
> le lot 2 a construit, et c'est plus convaincant qu'un run propre.

---

## La page produit

`docs/produit.html` ne contient plus aucun chiffre de l'ère du cerveau local. Ce qui a
changé au-delà des nombres :

| Avant | Après |
|---|---|
| « Local par défaut · 0 € · gratuitement » | souveraineté présentée comme une **option assumée** (D1) |
| six branches | sept, dont `spec` |
| codes 0/1/2/3 | + **4 — non vérifié**, non désactivable |
| tableau du seul corpus long, 3 passes local | corpus **complet**, 88 observations, Opus 5 |
| « 0 fausse alerte » | **2/8 en accessibilité**, avec l'analyse du motif |
| trois commandes | `mangoqa init` : trois portes en une commande |
| **1,6 Mo installés** | **1,09 Mo**, remesuré dans un dossier vierge |

Le chiffre de 1,6 Mo était **périmé** — remesuré plutôt que recopié. Un produit dont
l'argument est la traçabilité des chiffres ne peut pas se permettre d'en afficher un qu'il
n'a pas revérifié.

---

## Ce que cette mesure n'établit toujours PAS

- **Un corpus, un modèle, une machine, deux passes.** Les chiffres disent que l'auditeur
  discrimine sur *ce* corpus. Ils ne prédisent rien sur du code inconnu.
- **Le corpus est écrit par nous.** Défauts réalistes et vérifiés à la main, mais
  **injectés**, pas récoltés dans la nature.
- **L'axe *Standards* n'a toujours pas trouvé de dépôt tiers à vraies conventions de
  code** (L3-b/L140), et **l'axe *Spec* n'a jamais vu un vrai ticket** bavard et ambigu
  (L4-b/L141). Les deux mécanismes sont prouvés ; leur valeur ne l'est pas.
- **`--spec <issue>` n'est prouvé que sur son chemin d'erreur** (L5-b) : `gh` est installé
  ici mais pas authentifié.
- **La cause `reponse-illisible` n'a jamais été rejouée contre un vrai modèle
  incompatible** (L139).

---

## Verdict du lot 6

> **Atteint.** Le corpus complet est mesuré sous le cerveau que le produit recommande
> vraiment, l'instrument a été réparé trois fois avant qu'un seul chiffre ne soit publié,
> et la page produit ne porte plus rien de l'ère précédente — fausse alerte comprise.
>
> Le résultat est bon et il est vérifiable : **zéro raté, zéro instable, détection 100 %
> sur les cinq branches bloquantes**. Le seul point noir est publié en clair avec son
> explication, et l'assertion de corpus qui l'explique n'a **pas** été retouchée après
> coup.

**Les sept lots de l'ADR-001 sont clos.** Ce qui reste avant une publication npm n'est
plus du code : c'est un dépôt tiers à auditer.
