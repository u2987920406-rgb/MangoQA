# Lot 2 (ADR-001) — Fermer le trou d'honnêteté

> Clos le **2026-08-08**. Faille traitée : **J4-a**.
> Critère d'achèvement fixé par l'ADR : *« un cerveau incapable de tenir le contrat ne
> peut plus produire de feu vert · le rapport distingue "a jugé et n'a rien trouvé" de
> "n'a pas pu juger" · le code de sortie le distingue aussi · testé par la sonde qui a
> révélé le défaut. »* — **les quatre sont atteints.**

---

## Le défaut, en une ligne

Le produit distinguait déjà « n'a pas **LU** » de « a lu et n'a rien trouvé » (J2, la
couverture). Il lui manquait **« n'a pas JUGÉ » contre « a jugé et n'a rien trouvé »**.

Un cerveau qui répond hors contrat, ou qui ne répond pas, faisait tomber les six branches
en `skip`. `buildVerdict` n'y voyait aucun `fail` bloquant → **feu vert**. La couverture
s'affichait **complète** — et elle disait vrai, les fichiers avaient bien été envoyés,
ils n'avaient simplement jamais été jugés. La CLI sortait en **code 0**. En CI, ça passait.

---

## La mesure du avant / après, en conditions réelles

Même commande, même cerveau injoignable (`OLLAMA_URL` sur un port mort,
`QA_LOCAL_ONLY=on` pour couper le repli), même dossier (`src/`, 41 fichiers) :

| | Avant le lot 2 | Après |
|---|---|---|
| Affichage | `🟢 FEU VERT` | `⚪ NON VÉRIFIÉ — ni vert, ni rouge` |
| Code de sortie | **0** | **4** |
| Ce que le rapport disait des branches | « aucun élément à auditer » | « le cerveau n'a pas répondu », branche par branche |
| Temps avant de le savoir | un audit complet | **5,2 s** (préflight) |

Le comportement « avant » est rejouable à volonté : `--sans-preflight` sur un cerveau
mort reproduit exactement le régime du défaut, et rend désormais **4**, jamais **0**.

---

## Les deux volets, et pourquoi aucun ne remplace l'autre

### Volet 1 — le préflight (`src/preflight.ts`)

Un aller-retour minimal avant de lire le moindre fichier : *ce cerveau sait-il produire
un objet JSON lisible ?* Échec → `CerveauInutilisableError`, **aucun audit lancé**, code
`2` (erreur d'usage : l'environnement est à corriger, ce n'est pas un défaut du code
audité). Câblé dans les trois surfaces — API `auditProject`, CLI, MCP — alors qu'il
n'existait que dans le harnais d'éval.

**Il valide la réponse avec `parseFirstJson`, le lecteur de la production.** Un préflight
qui validerait par expression régulière testerait autre chose que ce qui tourne : il
pourrait déclarer bon un cerveau que `auditWithLLM` refuse ensuite — pire qu'absent.

Et il est volontairement **peu exigeant sur le contenu** : `{"ok":true}` noyé dans du
texte passe. Ce qui est testé est la capacité à produire du JSON lisible, pas
l'obéissance au mot près — recaler un cerveau capable d'auditer pour un caprice de forme
serait un faux positif à l'entrée.

### Volet 2 — les abstentions (`types.ts`, `verdict.ts`, `audit.ts`)

Le préflight ne couvre pas la **dégradation en cours de run** : un cerveau peut répondre
au test puis dérailler sur un vrai prompt. Chaque `skip` porte donc désormais sa cause :

| Cause | Famille | Ce que ça veut dire |
|---|---|---|
| `hors-perimetre` | jugement | `relevant()` n'a rien retenu — non-événement |
| `juge-sans-avis` | jugement | le juge a répondu `skip` **dans** le contrat |
| `reponse-illisible` | **panne** | a répondu, hors contrat JSON |
| `cerveau-injoignable` | **panne** | n'a pas répondu |
| `cause-inconnue` | **panne** | `skip` sans motif déclaré |

Seules les **pannes** sur une branche **bloquante** empêchent le Feu Vert. Un juge qui
décline poliment n'est pas une panne : les confondre ferait sonner l'alarme à chaque
audit, donc plus jamais.

**`estPanne(undefined) === true`.** C'est la décision qui porte le lot : comme
`coverage.complete`, l'optimisme n'est **jamais** la valeur par défaut. Un producteur de
`skip` qui oublierait de se déclarer fait *bruire* l'alarme au lieu de l'éteindre.

---

## Ce qui n'a PAS bougé — et pourquoi c'était la contrainte du lot

**Le contrat figé.** `verdict` reste `'green' | 'red'`. Introduire un troisième état
aurait cassé le lecteur de MangoOS, et surtout **violé le fail-open** : une panne de
Mango QA ne doit jamais bloquer la production de quelqu'un d'autre. `abstentions` est un
champ **additif** ; un lecteur qui l'ignore retrouve exactement le comportement d'avant.

Ce qui change est **la présentation et le code de sortie** — les surfaces où l'auditeur
*affirme* quelque chose. Le fail-open protège le travail de l'utilisateur, pas le droit
de certifier ce qu'on n'a pas vérifié.

Et la mention est **recopiée en clair** dans le résumé de chaque branche
(`[NON JUGÉ — …]`), exactement comme la lecture partielle : pour qu'un affichage non mis
à jour soit incapable de présenter une panne comme un « rien à signaler ».

### Un ROUGE reste rouge

Un défaut **trouvé** est un fait ; le silence d'une branche voisine ne l'annule pas. Seul
le **vert** se dégrade — c'est le seul des deux qui affirme une absence. L'ordre des
codes de sortie porte cette doctrine : `ROUGE` (1) → `NON_VERIFIE` (4) → `PARTIEL` (3).

### `NON_VERIFIE` n'est pas désactivable

`--exiger-couverture` est un choix parce qu'une lecture partielle est un **mode dégradé
légitime** qu'on peut assumer. Une absence de jugement n'est pas un audit dégradé, c'est
un non-audit. Aucun drapeau ne le ramène à 0.

---

## Le lot s'est fait auditer par le produit, et a été recalé deux fois

`mangoqa . --diff` sur le diff du lot lui-même, cerveau Opus 5. **Deux feux rouges
d'architecture, tous deux fondés** :

1. **La règle de dégradation triplée.** *« vert + jugement incomplet → NON VÉRIFIÉ »*
   avait été recopiée à l'identique dans `cli.ts`, `mcp.ts` et `eval/audit-projet.ts`.
   La branche a cité **ma propre doctrine** contre moi — le commentaire de `CAUSES_PANNE`
   qui dit qu'une liste dupliquée finit toujours par diverger. Corrigé : `estNonVerifie()`
   vit dans `verdict.ts`, une fois, et les quatre appelants l'utilisent.

2. **Une fuite d'état entre appels MCP** (défaut **préexistant**, hors lot 2). Le `cap`
   transite par `process.env`. Dans une CLI, un process = un audit : sans conséquence.
   Dans le serveur MCP, **long-vivant**, un seul appel passant `cap` imposait
   silencieusement sa couverture réduite à tous les appels suivants. Borné par un
   `try/finally` ; le correctif de fond (`cap` porté par `AuditOptions`) est consigné
   dans `FAILLES.md`, il n'appartient pas à ce lot.

> Ce n'est pas une anecdote : c'est la première fois que l'auditeur trouve un défaut réel
> **dans le code qui le rend honnête**, et que la trouvaille est vérifiée juste. Après
> correction, la même commande rend `🟢 FEU VERT`, code 0, **19,2 s**.

---

## Ce que la sonde prouve, et ce qu'elle ne prouve pas

`tests/unit/test-abstention.ts` — 17 tests, zéro réseau, quatre étages : le finding
(`llm.ts`), le verdict (`verdict.ts`), le rapport (`audit.ts`), le code de sortie
(`cli.ts`). Les branches de la sonde appellent le **vrai** `auditWithLLM` avec un cerveau
injecté : le chemin de parsing exercé est celui de la production, pas une imitation.

Deux assertions comptent plus que les autres :

- le rapport **ne contient pas** la chaîne `FEU VERT` quand rien n'a été jugé ;
- la couverture peut être **complète** pendant que le jugement est **vide** — les deux
  mesures sont bien distinctes, et c'est ce qui rendait la sonde d'origine trompeuse.

**Limite honnête.** Le volet 2 a été vérifié en réel avec un cerveau **injoignable**
(`cerveau-injoignable`), jamais avec un modèle installé qui répond **hors contrat**
(`reponse-illisible`) : aucun modèle de ce profil n'est disponible sur la machine. Cette
seconde cause est couverte à la couture de production par la sonde, pas par une exécution
de bout en bout contre un vrai modèle incompatible. À rejouer le jour où un tel modèle
passe sous la main.

---

## Fait au passage, hors périmètre du lot (consigné, pas codé)

- `projectHasTests` émet `ENOENT … scandir '<dossier>/src'` quand le dossier audité **est**
  déjà un `src/`. Bruit sur stderr, aucun effet sur le verdict. → `FAILLES.md`.
- Sur ce dépôt, `git` refuse d'opérer (`dubious ownership` : les copies de `D:\IA` ont été
  créées par la session automatique, sous un autre SID). Les mesures `--diff` ont été
  faites avec la confiance portée par l'environnement du seul process de mesure —
  **la configuration git de Raf n'a pas été modifiée**.

---

## Verdict du lot 2

> **Atteint.** Un cerveau incapable de tenir le contrat ne peut plus produire de feu vert,
> sur aucune des trois surfaces. Le rapport et le code de sortie distinguent « a jugé et
> n'a rien trouvé » de « n'a pas pu juger ». La sonde qui a révélé le défaut est gelée en
> test.
>
> Et comme en J0, J1 et J2, l'exercice a rapporté plus que sa case cochée : deux défauts
> réels trouvés par le produit sur son propre diff, dont une fuite d'état entre appels MCP
> qui n'avait rien à voir avec ce lot.

**Suite ADR-001 : lot 3 — conventions du dépôt (axe *Standards*).**
