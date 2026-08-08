# Contribuer à Mango QA

Mango QA est un auditeur de code qui rend un verdict **et déclare le périmètre sur lequel
ce verdict porte**. Tout ce qui suit découle de là : un outil qui demande de ne pas croire
les logiciels sur parole ne peut pas se permettre d'être approximatif sur ce qu'il affirme.

Ces règles ne sont pas des préférences de style. Chacune est née d'un défaut réel, trouvé
en exécution, qui a coûté du temps — les références (`J1-a`, `J4-a`, `L6-c`…) renvoient à
`FAILLES.md`, où l'incident d'origine est daté et décrit.

---

## Les cinq invariants

Une évolution qui viole l'un d'eux est refusée, quel que soit le gain apparent.

1. **Fail-open, toujours.** Une panne de l'auditeur ne bloque jamais le travail de
   l'utilisateur. Une branche qui échoue devient un `skip` déclaré, jamais une exception
   qui remonte.
2. **Indépendance.** L'auditeur ne reçoit d'ordres de personne — ni du générateur, ni de
   l'agent qui l'appelle. Un outil MCP qui permettrait de dire « ignore ce constat »
   détruirait le produit.
3. **Un verdict cite toujours sa source.** Fichier, ligne, règle nommée (OWASP, WCAG),
   correctif applicable.
4. **`design-system` n'est jamais bloquant.** Le goût conseille, il n'interdit pas.
5. **Aucune revendication non mesurée.** Tout chiffre affiché est traçable à une mesure
   datée, et les limites se publient avec les résultats.

---

## Les règles de code

### Rien d'optimiste n'est jamais une valeur par défaut

C'est **la** règle du dépôt. Un état non mesuré ne doit jamais se lire comme un état sain.

- `coverage.complete` n'est jamais vrai par défaut : « non mesuré » ≠ « tout lu » (`J1-a`).
- `estPanne(undefined)` rend **`true`** : une abstention sans cause déclarée est traitée
  comme une panne, jamais comme un jugement (`J4-a`).
- Une citation qui ne se résout pas est **rejetée**, pas ignorée (`lot 3`).
- Un dossier sans fichier auditable sort en **code 4**, pas en 0 (`P-01`).

Corollaire pratique : quand vous hésitez sur la valeur par défaut d'un booléen, choisissez
celle qui **fait bruire l'alarme**. Un faux positif se voit et se corrige ; une omission
silencieuse ne se voit jamais.

### Une règle vit à un seul endroit

Toute règle recopiée finit par diverger. Ce dépôt l'a vérifié **deux fois de suite**, sur
deux fichiers différents, et les deux fois c'est le produit qui l'a trouvé en s'auditant
lui-même (`L3-a`).

- `estNonVerifie()` vit dans `verdict.ts` — les trois surfaces l'appellent.
- `verifierRefs()` est partagé entre les conventions et la spec.
- Le nombre de branches vient de `ALL_BRANCHES.length`, jamais d'un littéral (`L6-b`).

Si vous vous surprenez à écrire « je duplique pour ne pas toucher à l'existant », arrêtez :
c'est exactement le geste qui a produit les deux divergences.

### Ne jamais écraser le travail de quelqu'un d'autre

Tout ce qui écrit sur le disque de l'utilisateur **fusionne ou refuse**. Un `.mcp.json` à
trois serveurs, un `pre-push` déjà en place, ce sont des heures de réglage. Un fichier
illisible fait **refuser**, jamais écraser : un JSON mal formé est peut-être un fichier
précieux.

Et toute commande qui écrit doit **dire où elle écrit**, et permettre de choisir le
dossier (`L5-a`).

### La configuration passe par le contrat, pas par l'environnement

`process.env` est un état global partagé. Dans une CLI, un process = un audit, donc c'est
sans conséquence ; dans le serveur MCP, **long-vivant**, un seul appel contamine tous les
suivants (`L2-a`). Les réglages d'audit voyagent dans `AuditOptions` → `AuditContext`.
L'environnement reste un **repli** rétrocompatible, jamais la source.

### Les modules purs se testent sans disque ni réseau

La logique de décision (`verdict.ts`, `conventions.ts`, `spec.ts`, `integration.ts`, le
parsing de `cli.ts`) n'a aucune dépendance d'I/O. Les dépendances sont **injectées** :
`fs`, `now`, `ask`, `preflightFn`, `branches`. C'est ce qui permet à la suite de tourner en
55 s sans un seul appel de modèle.

### Ce qui n'est pas du TypeScript se vérifie quand même

Un hook shell dont on ne teste que le *texte* peut avoir une faute de syntaxe et n'échouer
que chez l'utilisateur, au premier `git push`. On vérifie donc `sh -n` et le comportement
réel de l'échappatoire. Même chose pour le protocole MCP : `tests/manual/test-mcp-stdio.ts`
lance un vrai serveur sur un vrai transport.

---

## Les tests

### Un test gèle un COMPORTEMENT, pas une implémentation

Les tests les plus utiles de ce dépôt gèlent des **refus** : un hook étranger qui survit,
un JSON illisible qu'on ne remplace pas, une citation inventée qu'on rejette. Écrivez
d'abord ceux-là.

### Un chiffre en dur dans un test est un mensonge à retardement

Surtout dans `tests/manual/`, qui n'est pas exécuté par `npm test`. Un test manuel a
affirmé « les 6 branches » pendant deux lots après l'ajout de la septième (`L6-b`).
Dérivez l'attendu de la source.

### Avant de pousser

```bash
npm run typecheck      # tsc --noEmit, doit être vert
npm test               # vitest, doit être vert
npm run build          # doit être vert
```

Et l'auditeur sur son propre changement :

```bash
npx tsx src/cli.ts . --diff
```

C'est le meilleur relecteur du dépôt. Il a recalé ses propres auteurs quatre fois, à
raison à chaque fois.

---

## Mesurer

### On ne publie pas un chiffre qu'on n'a pas revérifié

« 1,6 Mo installés » est resté affiché après être devenu faux. Un chiffre repris d'un
rapport ancien doit être **remesuré**, pas recopié.

### L'instrument est soumis à la même règle que le produit

Le harnais d'évaluation a menti sur son propre cerveau, et a confondu panne et abstention
alors que le produit savait faire la différence depuis un lot entier (`L6-a`, `L6-c`).
Quand vous doutez d'un chiffre, **prouvez la condition** au lieu de relire le code : c'est
en pointant Ollama sur un port mort qu'on a su quel cerveau jugeait vraiment.

### On ne corrige pas un corpus après avoir vu un résultat défavorable

Si une mesure est mauvaise à cause d'une étiquette contestable, on **vérifie le fait à la
main**, on publie le chiffre tel quel, et on tranche à froid — dans une autre séance
(`L6-d`). Réparer la fixture est légitime ; retirer une assertion pour faire remonter un
score ne l'est pas.

---

## Ce qu'on ne fait PAS

Cette liste est la protection contre la dérive. Chaque entrée est une tentation réelle,
refusée par écrit — le détail et les raisons sont dans `docs/adr/ADR-001-cap-produit.md`.

| Tentation | Pourquoi refusée |
|---|---|
| Bot de commentaires sur les pull requests | Mango QA est une **barrière**, pas un conseiller |
| Nouveaux langages avant que le différenciateur soit prouvé | De l'étendue avant la profondeur donne un outil moyen partout |
| Interface graphique, tableau de bord | Aucun besoin établi n'en dépend |
| Réécrire l'existant « au propre » | Une capacité nouvelle rejoint une structure existante, ou n'entre pas |
| Ajouter une branche d'audit sans nécessité mesurée | Sept suffisent tant qu'aucune mesure ne dit le contraire |

---

## La langue

Le code, les commentaires, les messages d'erreur et la documentation sont **en français**.
Les identifiants techniques imposés par l'écosystème (`status`, `pass`, `fail`, noms de
champs du contrat figé) restent en anglais.

Un commentaire explique **pourquoi**, jamais **quoi**. Si un commentaire paraphrase la
ligne suivante, supprimez-le ; s'il raconte l'incident qui a rendu cette ligne nécessaire,
gardez-le — c'est ce qui empêche quelqu'un de « simplifier » une protection dans six mois.
