# Lot 3 (ADR-001) — Les conventions du dépôt (axe *Standards*)

> Clos le **2026-08-08**.
> Critère d'achèvement fixé par l'ADR : *« une trouvaille référence un fichier et une
> ligne du dépôt · un projet sans conventions documentées le déclare au lieu
> d'inventer. »* — **les deux sont atteints.**

---

## Le problème

Mango QA jugeait un projet contre **six spécialités figées dans son propre code**. C'est
ce qu'il sait de la qualité en général — ce n'est pas ce que *ce* dépôt a décidé. Un
projet qui écrit « jamais de `default export` » ou « toute route passe par le middleware
d'auth » a énoncé une règle vérifiable ; un auditeur qui ne la lit pas juge à côté.

Et le symétrique est pire : à un modèle à qui on ne parle **jamais** de conventions, il
en invente. Il juge contre les habitudes moyennes d'internet et les présente comme les
règles de la maison. Un reproche fondé sur une règle que personne n'a écrite est un faux
positif que l'utilisateur ne peut même pas contester.

---

## Ce qui a été construit

### 1. Le collecteur (`src/conventions.ts`) — déterministe, zéro LLM

Il ne *comprend* pas les règles, il les **localise**. Fichiers reconnus : `CLAUDE.md`,
`AGENTS.md`, `CONTRIBUTING.md`, `CONVENTIONS.md`, `STYLEGUIDE.md`, `.cursorrules`,
`.windsurfrules`, `.editorconfig`, `.github/copilot-instructions.md`, `.cursor/rules/*`.

Trois décisions qui portent le reste :

- **Comparaison contre le vrai listing du dossier**, en minuscules, plutôt qu'une série
  d'`existsSync` sur une liste en dur. Sur un système de fichiers sensible à la casse,
  `Claude.md` serait invisible et le projet passerait pour non documenté — le mensonge
  même que ce lot doit supprimer.
- **Deux formes de règle retenues, et deux seulement** : une **puce de liste** (la forme
  canonique d'une convention) et une **phrase normative** hors liste (`doit`, `jamais`,
  `must`, `never`…). Le reste — titres, prose, exemples — n'est pas une règle : le
  prendre gonflerait le prompt de contexte que le modèle lirait comme des obligations.
  Les blocs de code sont ignorés : une puce dans un exemple ``` illustre une règle, elle
  n'en est pas une, et la citer enverrait le lecteur vérifier sur un extrait de doc.
- **`.editorconfig`** donne les règles les plus objectives de toutes : `indent_style =
  space` se constate, il ne s'interprète pas.

Chaque règle sort avec son **identifiant `fichier:ligne`**. C'est ce qui rend la
citation vérifiable en aval, donc la trouvaille **réfutable**.

### 2. La remontée au dépôt — un trou vu avant qu'il ne coûte

Le premier jet ne scannait que le dossier audité. Or `mangoqa ./src` est un usage
courant — je l'ai moi-même fait pendant les mesures du lot 2. Le `CLAUDE.md` de la
racine n'aurait pas été trouvé, et Mango QA aurait déclaré **« aucune convention
documentée »** sur un dépôt qui en a écrit trente.

Ç'aurait été une absence *affirmée sans avoir été vérifiée* — la famille exacte de
mensonge que les lots 2 et 3 existent pour supprimer, réintroduite par une paresse de
parcours. Le scan remonte donc jusqu'à **4 parents**, et **s'arrête à la racine du
dépôt** (le dossier qui porte `.git`) : au-delà, on lirait les règles d'un projet voisin
ou du dossier personnel de l'utilisateur, présentées comme celles de son projet.

Les identifiants restent vérifiables depuis le dossier audité : `../../CLAUDE.md:42`
s'ouvre tel quel.

### 3. La citation vérifiée — le cœur du lot

Le modèle reçoit les règles avec leurs identifiants et l'ordre de citer celui de toute
règle qu'il invoque, dans un champ `conventionRefs`. **Chaque citation est ensuite
vérifiée** contre les règles réellement extraites.

Un identifiant qui ne s'y trouve pas signe l'un de deux problèmes : une règle inventée,
ou une ligne mal recopiée. Dans les deux cas la citation ne prouve rien, donc elle ne
compte pas — et **elle reste visible** dans `rejetees`, affichée par la CLI et par MCP.

> Effacer une citation inventée reviendrait à corriger la copie du modèle en silence.
> C'est le symptôme (faille **J1-b**, 2026-08-04 : le modèle exigeait d'ajouter une clé
> React déjà présente ligne 308) qu'il affirme un fait que la source contredit. Ce
> symptôme mérite d'être vu, pas nettoyé.

Tolérance de **forme** uniquement : `[CLAUDE.md:42]` avec ses crochets est accepté — le
modèle recopie ce qu'on lui a montré, ce n'est pas une invention. Le fond ne se négocie
pas.

### 4. La déclaration au rapport

Troisième membre de la même famille que `coverage` (ce qui a été **lu**) et `jugement`
(ce qui a été **jugé**) : `conventions` dit **contre quoi** on a jugé. Affichée AVEC le
verdict, sur les trois surfaces, et `documentees` est **requis** au schéma MCP — un
assistant ne peut pas obtenir un verdict sans savoir s'il existait des règles.

> ⚠️ **Piège de lecture nommé dans le code et dans les deux surfaces** : `cited` n'est
> **pas** « les règles vérifiées ». Une règle non citée a très bien pu être vérifiée et
> respectée. Le champ dit ce qui a été **fourni** au jugement et ce qui a été
> **invoqué** — rien de plus. Prétendre l'inverse referait, sur les conventions,
> l'erreur que J1-a et J4-a ont coûté cher à corriger.

---

## Mesures en conditions réelles, cerveau Opus 5

### Le collecteur, sur les dépôts disponibles

| Cible | Résultat |
|---|---|
| `D:\IA\MangoOS` | 34 règles, `CLAUDE.md` |
| `D:\IA\MangoOS\server\src` | 34 règles, **`../../CLAUDE.md`** — la remontée fonctionne |
| `D:\IA\MangoQA` | **absent : true** — ce dépôt ne documente rien, et le dit |

### Critère n°2, en réel

`mangoqa . --diff` sur Mango QA affiche `CONVENTIONS : aucune documentée dans ce dépôt —
jugé sur les seules spécialités.` Côté MCP, le texte va plus loin : *« ne le présente pas
comme une conformité aux règles du projet »*. Un assistant qui relaie le verdict ne peut
pas le transformer en « conforme à vos conventions ».

### Le résultat le plus intéressant : 34 règles fournies, **zéro citée, zéro inventée**

Sur `server/src` de MangoOS, la branche architecture a rendu un feu rouge fondé — un
monolithe de route — **sans invoquer aucune des 34 règles**. C'est le bon comportement,
et il tient à un fait qu'il faut nommer : le `CLAUDE.md` de MangoOS est un fichier
d'**instructions d'agent** (poser un cron heartbeat, lire `statut.md` au démarrage), pas
un fichier de conventions de code. Il n'y avait presque rien à citer.

> **Zéro citation abusive sur 34 règles hors sujet est le résultat qui compte le plus
> ici.** La consigne « ne cite pas une règle que le code fourni ne contredit pas » tient
> sous une charge de règles non pertinentes — c'est-à-dire dans le cas le plus propice à
> l'invention.

### Limite honnête, à écrire noir sur blanc

**Aucun dépôt disponible sur cette machine ne documente de vraies conventions de code.**
Le critère n°1 — une trouvaille qui référence un fichier et une ligne — est donc prouvé
**de bout en bout sur un dépôt temporaire réel** (fichiers sur disque, scan réel, rendu
réel, citation vérifiée) avec un **cerveau injecté**, jamais avec un vrai modèle sur un
vrai dépôt à conventions de code. Le mécanisme est prouvé ; sa **valeur** ne l'est pas.

C'est la mesure qui manque, et elle ne s'obtiendra pas en tournant en rond dans cet
écosystème : il faut un dépôt tiers qui écrive ses règles de code. À faire au lot 6, avec
la re-mesure du corpus.

---

## Le lot s'est fait auditer par le produit — et recaler, encore

`mangoqa . --diff`, cerveau Opus 5. **Deux feux rouges, tous deux fondés :**

1. **La copie du rendu avait divergé.** `eval/audit-projet.ts` portait sa propre version
   du rapport — il était le brouillon de la CLI avant qu'elle existe. J'y avais ajouté la
   section CONVENTIONS dans `cli.ts` et `mcp.ts`… et pas là. La branche l'a vu :
   *« la copie a déjà divergé : elle n'affiche pas la section CONVENTIONS »*.

   > **C'est la même faute qu'au lot 2, sur un autre fichier, deux lots de suite.** Au
   > lot 2 c'était la règle de dégradation recopiée dans trois surfaces. Un auditeur qui
   > attrape deux fois la même classe de défaut chez son propre auteur n'illustre pas
   > une préférence de style : il mesure une tendance. Corrigé — `audit-projet.ts`
   > importe `rendreRapport` et ne garde que son en-tête de mesure et son journal.

2. **La faille L2-a, enregistrée au lot 2, remontée telle quelle** : le cap de lecture
   câblé par une variable d'environnement globale, *« ce qui rend deux audits concurrents
   mutuellement corrupteurs dans le serveur MCP long-vivant »*.

**Décision de périmètre, et la ligne qui la justifie :** L2-a a été **fermée sur le
fond**, alors qu'elle n'appartient pas au lot 3. Une **faille enregistrée se corrige** ;
une **fonctionnalité** attend son lot. C'est la frontière que le § 5 de l'ADR protège —
il refuse la dérive, pas la réparation. `cap` est désormais un champ du contrat
(`AuditOptions` → `AuditContext`), l'environnement n'est plus qu'un repli
rétrocompatible, et le `try/finally` posé au lot 2 comme borne provisoire a disparu avec
sa cause.

**Après correction : `🟢 FEU VERT`, code 0, 23,8 s.** L'architecture note d'elle-même
*« source unique explicite pour le rendu et la règle de non-vérification »*.

---

## Vérification

`tsc --noEmit` propre · **291 tests / 20 fichiers, 0 échec**, dont **27 neufs** :
`tests/unit/test-conventions.ts` (25) et deux gels de L2-a dans `test-llm-coverage.ts`.

Les tests gèlent notamment ce qu'il ne faut **pas** faire : un `README.md` n'est pas un
fichier de conventions (sinon toute prose de présentation deviendrait un règlement), une
puce dans un bloc de code n'est pas une règle, un fichier lu sans règle explicite n'est
pas un dépôt non documenté, et la remontée s'arrête bien au `.git`.

---

## Verdict du lot 3

> **Atteint.** Mango QA lit les règles que le dépôt a écrites, juge contre elles, et
> chaque invocation cite un fichier et une ligne qu'on peut ouvrir. Un dépôt qui ne
> documente rien s'entend le dire, sur les trois surfaces, plutôt que de se voir
> reprocher des règles que personne n'a écrites.
>
> Et comme aux lots précédents, l'exercice a rapporté plus que sa case cochée : une
> faille de parcours vue avant qu'elle ne coûte (le sous-dossier), la fermeture de fond
> de L2-a, et la deuxième occurrence de la même classe de défaut chez son auteur —
> attrapée par le produit, pas par moi.

**Suite ADR-001 : lot 4 — l'axe *Spec* (`--spec <fichier>` : le code fait-il ce qui était
demandé, et rien de plus ?).**
