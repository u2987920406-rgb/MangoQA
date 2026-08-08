# Lot 5 (ADR-001) — L'intégration : de zéro à un verdict en une commande

> Clos le **2026-08-08**.
> Critère d'achèvement fixé par l'ADR : *« un utilisateur passe de zéro à un premier
> verdict en une commande. »* — **atteint**, et le lot ferme au passage la faille L4-a.

---

## Pourquoi ce lot est le moins spectaculaire et l'un des plus décisifs

La décision **D4** nomme l'étalon : `mattpocock/skills`. Son avantage n'est pas
technique — il est **déjà dans l'éditeur**. Un auditeur meilleur mais pénible à brancher
perd contre un auditeur moyen déjà présent. Tout ce qui précède (couverture déclarée,
jugement déclaré, conventions, spec) ne vaut rien si personne ne franchit l'installation.

---

## Trois portes, parce qu'on ne branche pas un auditeur au même moment

| Porte | Quand | Commande |
|---|---|---|
| **`.mcp.json`** | pendant qu'on code — l'assistant appelle l'auditeur | `mangoqa init` |
| **hook `pre-push`** | au moment de pousser — la barrière tombe seule | `mangoqa init --hook` |
| **action de CI** | à plusieurs, sur la forge | `mangoqa init --ci` |

Le dossier cible est facultatif (`mangoqa init ./mon-projet`), et **rien n'est jamais
écrasé**.

---

## La règle qui gouverne tout le module : on n'écrase jamais le travail d'un autre

Un `.mcp.json` qui contient déjà trois serveurs, un `pre-push` qui lance déjà des tests —
ce sont des heures de réglage. **Un outil qui les remplace en silence pour s'installer
plus vite est un outil qu'on désinstalle.** Toutes les fonctions du module fusionnent ou
refusent ; aucune n'écrase.

| Situation | Comportement |
|---|---|
| `.mcp.json` avec d'autres serveurs | **fusionné** — les autres survivent, les clés inconnues de premier niveau aussi |
| entrée `mangoqa` déjà là, différente | **refusé** — c'est un réglage volontaire (chemin local, modèle imposé) |
| `.mcp.json` illisible | **refusé** — un JSON mal formé est peut-être un fichier précieux ; le remplacer détruirait une configuration pour rendre service |
| `pre-push` d'un autre outil | **refusé**, avec la ligne exacte à ajouter pour cohabiter |
| notre `pre-push` périmé | **mis à jour** (reconnu par un marqueur) |
| workflow de CI déjà présent | **refusé** |

Vérifié en réel sur un dépôt portant déjà un serveur `github` et un hook `npm run
test:ci` : le serveur survit, le hook est intact, le workflow est posé.

## Deux choix dans le hook qui décident s'il survit à la semaine

- **`--diff`, pas le projet entier.** Un `pre-push` doit rester de l'ordre de la dizaine
  de secondes. Auditer tout le dépôt à chaque poussée ferait désinstaller le hook, et un
  hook désinstallé ne protège rien.
- **Une échappatoire explicite** (`MANGOQA_SKIP=1`). Sans elle, l'utilisateur pressé
  passe par `--no-verify`, qui désarme **tous** les hooks du dépôt — y compris ceux des
  autres. Offrir la petite porte évite qu'on défonce la grande.

Le code de sortie est propagé tel quel : **`4` bloque aussi**. Cohérent avec le lot 2 —
on ne pousse pas plus sur « l'auditeur n'a pas pu juger » que sur un feu rouge.

## Et un choix dans la CI

`--exiger-couverture` est activé **là et nulle part ailleurs**. En CI, personne ne lit le
rapport : un feu vert rendu sur 30 % du code y passerait pour une vérification. C'est
exactement le mensonge que le lot 2 a supprimé de l'affichage — le laisser revenir par la
porte de la CI serait absurde. Et sans `ANTHROPIC_API_KEY`, le workflow **s'arrête**
(code 2) au lieu de rendre un audit vide.

---

## L4-a fermée : `--spec` accepte une issue

`--spec #42` ou `--spec https://github.com/org/repo/issues/42` passent désormais par le
**CLI `gh` déjà installé et authentifié** chez l'utilisateur.

> **Aucun code d'authentification maison.** Pas de jeton à stocker, pas de secret dans une
> variable d'environnement, pas de surface d'attaque ajoutée à un outil dont l'argument
> est la confiance. On emprunte l'authentification que le développeur a déjà consentie à
> son terminal, et on ne la voit jamais passer.

L'absence de `gh` est déclarée avec sa piste de résolution — jamais un `ENOENT: spawn gh`
brut, qui ressemble à un bug de Mango QA.

> **Limite honnête (L5-b) :** sur cette machine `gh` est installé mais **pas
> authentifié**, donc la lecture réussie d'une vraie issue n'a jamais tourné de bout en
> bout. Ce qui est vérifié, c'est la **dégradation** : `mangoqa . --spec "#999999"` rend
> code 2, aucun audit lancé, et relaie le message de `gh` lui-même avec notre piste de
> résolution. Le mécanisme est là, la preuve du chemin nominal manque.

---

## Le lot a produit son propre incident, et le correctif qui va avec

Pendant la vérification, `mangoqa init --ci --hook` lancé **depuis le dépôt de Mango QA**
en croyant équiper un autre dossier a écrit trois fichiers dans le mauvais dépôt.
`executerInstallation` n'agissait que sur `process.cwd()`, sans moyen de viser ailleurs.

Nettoyé, puis corrigé à la racine : **un argument de dossier**, et le chemin visé est
désormais **annoncé en tête de sortie**. Toutes les autres commandes de cette CLI prennent
un dossier ; celle-ci n'avait aucune raison de faire exception.

> Une commande qui écrit sur disque sans dire où le fait dans le mauvais dossier tôt ou
> tard. Ici, la victime était mon propre dépôt et le dégât nul — chez un utilisateur,
> c'est un `.mcp.json` inattendu dans un projet qui n'a rien demandé.

---

## Vérification

`tsc --noEmit` propre · `npm run build` vert · **336 tests / 22 fichiers, 0 échec**, dont
**27 neufs** (`tests/unit/test-integration.ts`). La moitié de ce fichier gèle des
**refus** : c'est là qu'est le vrai risque du lot, pas dans l'écriture des fichiers.

Et deux vérifications que les tests unitaires ne peuvent pas faire, parce qu'elles ne
portent pas sur du TypeScript :

- **le hook est du shell qui tourne vraiment** — `sh -n .git/hooks/pre-push` passe, et
  `MANGOQA_SKIP=1 sh pre-push` rend bien `0` avec son message. Un test qui n'aurait
  vérifié que le *texte* du script aurait laissé passer une faute de syntaxe shell, et le
  hook aurait échoué chez l'utilisateur au premier `git push` ;
- **le protocole MCP répond toujours** — `tests/manual/test-mcp-stdio.ts`, 16/16. Il a
  d'ailleurs révélé au passage la faille **L6-b** : il affirmait « les 6 branches » en dur
  et n'avait pas bronché quand le lot 4 en a ajouté une septième, parce qu'il vit hors de
  la suite automatique et que personne ne l'exécutait.

---

## Verdict du lot 5

> **Atteint.** `mangoqa init` branche l'auditeur sur les trois portes en une commande,
> sans jamais détruire une configuration existante, et `--spec` lit maintenant une issue
> sans que Mango QA touche à un seul secret.

**Suite ADR-001 : lot 6 — prouver** (re-mesure du corpus sous Opus 5, page produit alignée
sur les chiffres). C'est le lot qui décide si le produit mérite de sortir.
