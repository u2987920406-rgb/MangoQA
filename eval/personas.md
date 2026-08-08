# Campagne personas — 10 parcours réels contre Mango QA

> Écrite dans la nuit du **2026-08-08**, à la demande de Raf : *« crée une dizaine de
> personas qui ont 10 demandes différentes, des envies et des parcours différents, et fais
> les tests avec leurs besoins. »*

## La règle de cette campagne

**Aucun parcours simulé.** Chaque persona est joué pour de vrai, avec les commandes qu'il
taperait, sur de vrais dossiers. Ce qui est consigné est ce qui s'est réellement passé —
y compris quand tout se passe bien, parce qu'un parcours qui marche est un résultat.

Et une règle de lecture, héritée du produit lui-même : **une friction non reproduite n'est
pas une friction établie**. Chaque défaut noté ci-dessous a été revu à la main.

## Ce que la campagne cherche

Les six lots précédents ont mesuré la **qualité de jugement** de l'auditeur. Ils n'ont
jamais mesuré ce qu'un inconnu vit en l'utilisant. Les personas visent l'autre moitié :

- le **premier contact** — que comprend quelqu'un qui n'a jamais lu la doc ?
- les **chemins de traverse** — dossier vide, projet Python, dépôt sans git, monorepo ;
- les **attentes fausses** — ce que le nom d'une option laisse croire ;
- la **sortie machine** — ce qu'un script ou un agent en fait sans lire le texte ;
- le **coût** — combien de temps avant le premier verdict utile.

---

## Les dix

| # | Persona | Ce qu'il veut | Surface exercée |
|---|---|---|---|
| P1 | **Yanis**, solo maker pressé | « je veux un verdict tout de suite, sans rien lire » | premier contact, `mangoqa .` nu |
| P2 | **Salomé**, dev indé qui pousse | « qu'il m'arrête avant que je pousse une bêtise » | `init --hook`, hook réel, `--diff` |
| P3 | **Marc**, lead qui protège une équipe | « je le veux en CI, et qu'il ne mente pas sur ce qu'il a vu » | `init --ci`, workflow, codes de sortie |
| P4 | **Inès**, freelance qui livre à un client | « un rapport que je peux joindre à ma facture » | `--json`, contenu du rapport machine |
| P5 | **Tarek**, backend Python | « j'ai un projet Django, dis-moi ce que tu vaux » | projet non-JS, périmètre, honnêteté du refus |
| P6 | **Camille**, chef de projet non-dev | « est-ce que le dev a fait ce que j'ai demandé ? » | `--spec`, lecture du verdict par un non-technique |
| P7 | **Ruben**, mainteneur open-source | « respecte les règles de MON dépôt, pas les tiennes » | conventions, `CONTRIBUTING.md`, citations |
| P8 | **Léa**, utilisatrice de Claude Code | « je veux que mon assistant l'appelle tout seul » | MCP, schéma de sortie, relais du verdict |
| P9 | **Otto**, sceptique | « prouve-moi que tu ne racontes pas n'importe quoi » | corpus, limites publiées, reproductibilité |
| P10 | **Nadia**, monorepo à 4 paquets | « audite juste mon paquet, pas les 3 autres » | sous-dossier, remontée des conventions, cap |

---

## Journal d'exécution

Neuf parcours joués en réel dans la nuit du 2026-08-08 (P9 est une vérification, pas un
audit). **Huit défauts trouvés, tous corrigés**, dont un P0.

### 🔴 P5 — Tarek, backend Python : le plus grave

`mangoqa ./projet-django` sur un fichier contenant une **injection SQL flagrante** :

```
Aucun fichier auditable dans …/p5-tarek.        →  code de sortie : 0
```

**Code 0 = feu vert.** Une équipe Python pouvait brancher Mango QA en CI et voir passer du
vert éternellement, sans qu'un seul fichier ait jamais été lu. Et rien n'indiquait que
`.py` n'est pas dans le périmètre : *une limite qu'on ne nomme pas se lit comme une
absence de problème.*

C'est **J4-a d'un cran plus haut**. Le produit savait dire « je n'ai pas lu » et « je n'ai
pas jugé » — pas « je n'ai rien eu à regarder ». Corrigé : code **4**, et le rapport nomme
les extensions lues. → `P-01`

### 🔴 P2 — Salomé, hook pre-push : une panne annoncée comme un verdict

Le hook a affiché **« poussée refusée (code 1) »** — feu rouge — alors que `npx` venait
simplement d'échouer en 404. Une panne d'infrastructure présentée comme un jugement sur le
code, sur le produit qui existe précisément pour empêcher ça. Il déversait en plus la
sortie brute de npm, et supposait `origin/HEAD` (absent de beaucoup de dépôts).

Réécrit : l'auditeur est **trouvé avant d'être appelé**, son absence donne un message clair
et **exit 0** (fail-open, invariant n°1). Vérifié en réel — absence → 0, environnement
cassé → 2, vrai défaut → 1. → `P-05`

Et le même parcours a révélé que **la CLI ne faisait pas ce que sa doctrine annonçait** :
hors du dépôt Mango QA, le cerveau retombait sur `ollama` alors que la décision D1 fait de
Claude le défaut produit. Salomé attendait **344 s** au lieu de 20. Un pre-push de six
minutes se fait désinstaller le jour même. → `P-04`

### 🔴 P4 — Inès, freelance : un rapport sans date n'est pas une preuve

Le JSON qu'elle voulait joindre à une livraison client n'avait **ni date, ni cerveau, ni
version**. Contradiction interne : la sortie *texte* annonce le cerveau depuis le lot 0,
la sortie *machine* — la seule qu'on archive — ne le disait pas. → `P-03`

Corrigé, puis **re-cassé et re-corrigé dans la même heure** : mon premier jet écrivait de
l'UTC sous un commentaire disant « heure locale », d'où « rendu le 03:21 » pour un audit de
05:21. Troisième passage de ce piège dans ce dépôt. → `P-08`

### 🔴 P7 — Ruben, mainteneur : le produit trouve son propre défaut

Après l'écriture du `CONTRIBUTING.md`, `mangoqa . --diff` sur son propre dépôt. La branche
Tests a signalé que le signal « aucun test » était **faux**, en nommant la cause exacte :

> *« le dépôt nomme ses tests `tests/unit/test-*.ts`, forme que la regex `TEST_FILE_RE` de
> `src/project-files.ts` ne reconnaît pas »*

Mango QA ne reconnaissait que `foo.test.ts` — **son propre dépôt passait pour dépourvu de
tests**, et les branches recevaient un signal mensonger sur la foi duquel la branche Tests
peut rendre un Feu Rouge. → `P-02`

### ✅ P10 — Nadia, monorepo : le meilleur résultat de la nuit

`mangoqa packages/api` sur un monorepo à 4 paquets, avec un `CONTRIBUTING.md` à la racine :

```
CONVENTIONS : 3 règle(s) lue(s) dans ../../CONTRIBUTING.md · 1 invoquée(s) : ../../CONTRIBUTING.md:4
VERDICT     : 🔴 FEU ROUGE — branche security (sql-injection-query-role)
Correctif   : « …requête paramétrée… et valider req.query avec un schéma zod
                (ex: z.object({ role: z.enum([...]) })) avant traitement. »
```

La remontée aux dossiers parents fonctionne, **la citation est vérifiée**
(`../../CONTRIBUTING.md:4` = « toute route Express doit valider son entrée avec zod »), et
le correctif n'est pas un OWASP générique : **il applique la convention de ce dépôt-là**.
C'est l'axe *Standards* prouvé de bout en bout, ce qui manquait au lot 3.

### ✅ P6 — Camille, cheffe de projet : la spec en langage humain

Sa demande est un e-mail (« Bonjour… Bises, Camille »), exigences noyées dans des phrases.
**6 exigences extraites**, et le verdict cite l'export CSV manquant au mot près —
*« Le client veut aussi pouvoir exporter la liste en CSV. »* — avec un correctif qui va
jusqu'au `Content-Disposition`.

Le plus important : il a **refusé d'accuser** sur le contrôle admin, *« pourrait
légitimement vivre dans un middleware non fourni »*. La règle de prudence tient sur une
spec ambiguë écrite par une non-développeuse — ce que **L141** disait ne pas savoir.

### ✅ P1 · P3 · P8 · P9

- **P1 (Yanis, premier contact)** — verdict en **20,8 s** sans rien lire, trois vrais
  défauts, correctif allant jusqu'à « révoquer et régénérer la clé compromise ». A révélé
  la verrue « 2 fichiers » sur une branche qui n'avait rien regardé. → `P-07`
- **P3 (Marc, CI)** — workflow structurellement valide (aucune tabulation, indentation
  paire, actions v4, `fetch-depth: 0`). Mais il appelle un paquet **non publié** : il
  échouerait au premier push. Averti en tête de fichier. → `P-06`
- **P8 (Léa, assistant)** — MCP 16/16, `conditions` relayées, et le texte destiné à
  l'assistant porte tous les avertissements (« ne conclus pas que le travail est
  complet »). A révélé le message « Aucune branche ne correspond à : undefined ». → `P-07`
- **P9 (Otto, sceptique)** — tout est vérifiable sans croire sur parole : 32 cas comptés
  dans le code, 5 rapports datés archivés avec leur cerveau, commande de rejeu documentée,
  **34 failles publiées dont 14 ouvertes**.

---

## Ce que la campagne a appris sur la méthode

**Cinq des huit défauts ne sont pas des bugs de logique.** Ce sont des endroits où le
produit *disait* quelque chose de faux : un code de sortie qui ment, un hook qui appelle
une panne un feu rouge, un rapport sans conditions, une CLI qui n'applique pas sa propre
doctrine, une date qui a l'air précise. Aucun test unitaire ne les aurait trouvés, parce
qu'aucun ne portait sur ce qu'un humain *comprend* en lisant la sortie.

**Deux d'entre eux ont été trouvés par le produit lui-même** en s'auditant (P7, et la
duplication de `VERSION`). Un auditeur qui attrape les fautes de son auteur fait son
travail.

**Un a été introduit puis corrigé pendant la campagne** (`P-08`, la date UTC). C'est le
meilleur argument pour cette forme de test : jouer un parcours complet, à la place de
quelqu'un, montre en dix secondes ce qu'une relecture ne voit pas.

> Et il reste ce que les personas ne peuvent pas prouver : **ce sont mes fixtures.**
> Nadia, Camille et Tarek sont des dossiers que j'ai écrits. Les mécanismes sont
> maintenant exercés sur des parcours réalistes ; la valeur sur du vrai code d'inconnu
> reste [[L142]].
