# Lot 4 (ADR-001) — L'axe *Spec* : le code fait-il ce qui était demandé ?

> Clos le **2026-08-08**.
> Critère d'achèvement fixé par l'ADR : *« l'axe cite la ligne de spec entre guillemets ·
> l'absence de spec est déclarée (“aucune spec fournie”), jamais inventée. »* —
> **les deux sont atteints, et mesurés en conditions réelles.**

---

## La question qu'aucune des six branches ne savait poser

Les six spécialités jugent le code **en lui-même** : est-il sûr, accessible, rapide,
testé, bien structuré, conforme aux règles maison. Aucune ne sait répondre à la seule
question que se pose vraiment celui qui a commandé le travail : **est-ce que c'est ce que
j'avais demandé ?**

Un code peut être irréprochable sur les six et ne pas faire le travail. C'est même le
mode de panne le plus courant des générateurs d'apps : ça compile, c'est joli, c'est
propre — et il manque la moitié de la demande. Personne ne le dit, parce que personne n'a
lu la demande.

---

## Ce qui a été construit

### `src/spec.ts` — le lecteur, déterministe

Même patron que `conventions.ts` : il ne comprend pas les exigences, il les **localise**,
avec leur numéro de ligne. Trois formes retenues — **case à cocher**, **puce de liste**,
**phrase de demande** (marqueurs FR/EN plus larges que pour les conventions : une spec
s'écrit à l'infinitif ou au futur, « afficher la liste », « l'utilisateur pourra… », pas
seulement en obligations). Titres, prose de contexte et blocs de code écartés : un
exemple de code dans une spec *montre* le résultat attendu, il ne le formule pas.

**Les cases déjà cochées sont conservées, délibérément.** Une exigence marquée faite est
précisément celle qu'il faut vérifier : l'auteur affirme l'avoir livrée, et c'est cette
affirmation-là que l'audit met à l'épreuve. La retirer reviendrait à croire sur parole
exactement là où le produit existe pour ne pas croire sur parole.

### `src/branches/spec.ts` — la septième branche

**Placée en PREMIER** dans le registre, ce qui n'est pas un détail d'ordre : le premier
échec bloquant porte le Feu Rouge, et quand du code ne fait pas ce qui était demandé,
c'est le seul reproche qui compte. Rendre « contraste insuffisant » sur une fonctionnalité
qui n'existe pas ferait travailler l'utilisateur sur le mauvais problème.

**Bloquante**, et c'est la décision D2 appliquée : « il manque la moitié de ce que j'ai
demandé » est exactement ce qu'une barrière doit arrêter. Elle regarde **tous** les
fichiers du périmètre — filtrer par extension ferait déclarer non satisfaite une exigence
implémentée dans un fichier qu'on aurait soi-même écarté, le pire faux positif possible
pour cette branche puisqu'il accuse d'un manquement qui n'existe pas.

### La distinction structurante : ce qui manque bloque, ce qui déborde se signale

| | Sortie | Bloque ? |
|---|---|---|
| **Exigence non satisfaite** | `fail`, avec l'exigence citée entre guillemets | ✅ oui |
| **Débordement de périmètre** | préfixe « Débordement : » dans le résumé | ❌ jamais |

Faire plus que demandé peut être parfaitement légitime. Un auditeur qui traite « tu as
fait plus que demandé » au même titre que « tu n'as pas fait ce que j'ai demandé » ne
sert personne — il transforme une remarque utile en obstacle.

### Trois garde-fous contre le faux positif, qui se composent

1. **La prudence de couverture, dans le prompt** : *« une exigence dont l'implémentation
   pourrait vivre dans un fichier que tu ne reçois pas ne compte PAS comme non
   satisfaite »*. Sans elle, une lecture partielle produit des accusations de manquement
   pour cause d'absence de lecture — le défaut J1-a déplacé sur l'axe Spec.
2. **La citation vérifiée** (patron du lot 3) : un identifiant qui ne se résout pas à une
   exigence réelle est rejeté et reste visible.
3. **`degraderSiNonCitee`** : un « fail » qui ne cite **aucune** exigence vérifiée est
   dégradé en observation non bloquante. Un feu rouge adossé à rien de réfutable n'est
   pas un audit, c'est une opinion.

### Une spec inutilisable n'est PAS « pas de spec »

`--spec` sur un fichier introuvable ou sans exigence lisible lève
`SpecInutilisableError` → **code 2, aucun audit lancé**. L'utilisateur a explicitement
demandé qu'on juge contre un document ; lui rendre en silence un audit sans spec
répondrait à une autre question que la sienne, et son feu vert aurait l'air de valider
une conformité que personne n'a regardée.

---

## Mesure en conditions réelles — contrôle apparié, cerveau Opus 5

**Même code, même diff, deux specs.** C'est la discipline du corpus J2 appliquée à un
audit réel : sans le jumeau, on ne distingue pas « détecte » de « crie au loup ».

### A — contre la spec du **lot 4**, celui qui vient d'être implémenté

```
🟢 📋 Spec   21.7s   9/10 vus   Les cinq exigences sont visibles dans le code livré
                                (--spec dans cli.ts, exigences non satisfaites via
                                ReportSpec.citedTexts rendues « entre guillemets » en CLI
                                et MCP, débordement demandé au juge dans le prompt, et le
                                cas « aucune spec fournie » explicitement déclaré) ;
                                Débordement : le lot ajoute aussi une
                                SpecInutilisableError fatale, un cap QA_SPEC_CAP et la
                                mise en tête de priorité de la branche Spec, que la liste
                                ne demandait pas — signalé, non bloquant.
VERDICT : 🟢 FEU VERT     code 0
```

**Le débordement de périmètre fonctionne, sur du réel et sans qu'on le lui souffle** : il
a relevé seul trois ajouts que la spec ne demandait pas, et ne les a pas comptés comme
des fautes. C'est la moitié du lot que le critère d'achèvement de l'ADR ne mesure même
pas.

### B — contre la spec du **lot 5**, celui qui n'est pas fait

```
🔴 📋 Spec   37.7s   9/10 vus   Aucune trace d'une commande install-hook dans la CLI
                                livrée alors que [spec:7] demande « Il faut une commande
                                install-hook qui pose un hook git pre-push. » […]
                                Les exigences [spec:5], [spec:6] et [spec:8] ne sont pas
                                invoquées : leur implémentation pourrait vivre dans des
                                fichiers non fournis à cette lecture.

  ✗ spec:7 non satisfaite — « Il faut une commande install-hook qui pose un hook git pre-push. »

VERDICT : 🔴 FEU ROUGE — branche spec (missing-install-hook-command)     code 1
Correctif : « Dans src/cli.ts, intercepter le premier argument `install-hook` avant
l'analyse du dossier […], le documenter dans AIDE, et lui faire écrire un hook exécutable
.git/hooks/pre-push qui invoque `mangoqa . --diff` et propage son code de sortie. »
```

Trois choses valent d'être relevées, et la troisième est la plus importante :

- **La citation est textuelle**, avec son identifiant — le critère d'achèvement, littéral ;
- **le correctif est chirurgical** : il nomme le fichier, la fonction, et le comportement
  attendu du hook ;
- **il a refusé d'accuser sur `spec:5`, `spec:6` et `spec:8`**, en disant pourquoi. La
  règle de prudence de couverture tient sous pression : trois occasions d'un feu rouge
  facile, trois abstentions motivées. C'est la différence entre un auditeur et un
  bulldozer, et elle ne se voit que sur un cas où il aurait pu se tromper.

### Une démonstration non planifiée du lot 2

Le premier essai du contrôle B est tombé sur une panne transitoire du SDK Claude
(`Reached maximum number of turns`). Résultat affiché : **`⚪ NON VÉRIFIÉ`, code 4** — pas
un feu vert. Le lot 2 a fonctionné en conditions réelles, sur une panne que personne
n'avait provoquée, dans la mesure d'un autre lot.

---

## Vérification

`tsc --noEmit` propre · **309 tests / 21 fichiers, 0 échec**, dont **18 neufs**
(`tests/unit/test-spec.ts`). Les tests exercent la **vraie** branche avec un cerveau
injecté — même prompt, même lecteur de réponse, même garde-fou : `degraderSiNonCitee` est
exporté précisément pour que le harnais n'en écrive pas une copie qui divergerait (le
défaut que le produit a trouvé chez son auteur aux lots 2 et 3).

---

## Ce que ce lot ne prouve PAS

- **Un seul dépôt, deux specs, un modèle.** Le contrôle apparié écarte « il crie au loup
  sur toute spec », il ne mesure pas un taux de détection.
- **Les specs de la mesure ont été écrites par moi**, à partir du texte de l'ADR. C'est
  bien la demande réelle, mais formulée en puces courtes et nettes — pas un vrai ticket
  bavard, ambigu, à moitié périmé, qui est le régime normal en entreprise.
- **`--spec` ne lit qu'un fichier.** L'ADR mentionnait « ou une issue » : récupérer une
  issue demande réseau et authentification, hors périmètre de ce lot. Consigné, pas codé.

---

## Verdict du lot 4

> **Atteint.** Mango QA sait dire si le code fait ce qui était demandé, cite l'exigence
> manquante entre guillemets, signale ce qui déborde sans le compter comme une faute, et
> déclare explicitement quand personne ne lui a dit ce qui était attendu.
>
> Et l'axe a fait son premier vrai travail sur son propre auteur : il a relevé trois
> ajouts hors périmètre dans la livraison qui l'a créé.

**Suite ADR-001 : lot 5 — intégration** (installation en une commande, action de CI
prête à coller). Il a désormais une spec écrite, et un feu rouge qui l'attend.
