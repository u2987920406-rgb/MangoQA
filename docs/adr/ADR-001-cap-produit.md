# ADR-001 — Cap produit de Mango QA

- **Statut :** accepté
- **Date :** 2026-08-05
- **Décideur :** Raf
- **Portée :** gouverne tout le travail sur Mango QA jusqu'à révision explicite

Ce document est **la référence unique**. En cas de contradiction entre lui et une idée
de séance, une envie, une discussion ou un README, **c'est lui qui gagne**. Toute
déviation non prévue au § 5 est un défaut de processus, pas un arbitrage.

---

## 1. Contexte

Mango QA est un auditeur de code qui rend un verdict Feu Vert / Feu Rouge et — seul sur
le marché — **déclare le périmètre sur lequel ce verdict porte**.

Trois constats ont été établis par la mesure, pas par opinion :

**Le cerveau local rendait des verdicts faux.** Sur `abyss`, branche performance :
`qwen2.5-coder:14b` a rendu « aucun anti-pattern majeur » en 345 s ; Claude Opus 5 a
trouvé en 26,6 s un défaut réel (état de scroll dans `App.jsx` re-rendant tout l'arbre
à chaque frame) avec un correctif chirurgical. Le local n'était pas seulement lent, il
donnait un **feu vert faux sur du vrai code**.

**Le créneau « local, gratuit, souverain » est occupé.** LiveReview (Hexmos) est
source-available, gratuit, tourne sur Ollama, s'intègre à GitHub/GitLab/Bitbucket/Gitea
et aux hooks git. S'y battre, c'est proposer un LiveReview en retard et payant.

**Le conseil de revue est devenu gratuit et bon.** `mattpocock/skills` (~176 k étoiles,
7,5 M téléchargements) fait de la revue de diff sur deux axes, dans Claude Code, pour
zéro euro. Mais il ne rend **délibérément aucun verdict**, ne déclare **aucune
couverture**, et ne peut **pas dire à quel point il se trompe**.

---

## 2. Décisions arrêtées

Chaque décision porte ce qui l'invaliderait. C'est la seule porte de sortie.

### D1 — Le cerveau par défaut est Claude Opus 5

Le cerveau reste sélectionnable (`QA_BRAIN`). `ollama` continue de servir qui exige
qu'aucun octet ne sorte de la machine.

**Conséquences acceptées :** « 0 € par audit » sort de l'argumentaire par défaut ;
la souveraineté devient une **option**, plus la promesse ; `QA_LOCAL_ONLY` devient un
mode contraint.

**Ce qui l'invaliderait :** un modèle local atteignant, sur le corpus étiqueté, une
détection et un taux de faux positifs comparables à Opus 5. À re-mesurer, pas à
supposer.

### D2 — Mango QA est une BARRIÈRE, pas un conseiller

Il rend un verdict et un code de sortie. Il ne produit pas un flux de commentaires sur
une pull request.

**Conséquences acceptées :** on ne concourt pas avec CodeRabbit, Greptile, Qodo ni
Pocock sur le terrain du conseil. On perd les comparatifs qui notent le nombre de
remarques par PR.

**Ce qui l'invaliderait :** la preuve que les acheteurs veulent du conseil et refusent
la barrière — mesurée sur des utilisateurs réels, pas déduite.

### D3 — Ce qu'on vend est la PREUVE, pas la détection

Montrer qu'une vérification a eu lieu, **sur quel périmètre**, avec **quel taux
d'erreur connu**. La détection seule est une commodité désormais gratuite.

**Conséquences acceptées :** la cible n'est pas « aide-moi à relire », mais CI,
livraison client, et chaînes d'agents où une machine consomme le verdict.

**Ce qui l'invaliderait :** un concurrent qui déclare sa couverture. À surveiller —
CodeRabbit a livré en juillet 2026 une fonction de traçabilité des commentaires, signe
que le sujet monte.

### D4 — L'étalon est `mattpocock/skills` : l'égaler, puis le dépasser

**À rattraper :** portée sur le diff · lecture des conventions documentées du dépôt ·
axe Spec (le code fait-il ce que le ticket demandait ?) · citation de la source de
chaque trouvaille.

**À conserver comme avance :** couverture déclarée · verdict et codes de sortie · taux
d'erreur mesuré · six spécialistes indépendants · fonctionnement hors agent.

### D5 — Aucune revendication non mesurée

Tout chiffre affiché à un utilisateur ou à un acheteur est traçable à une mesure datée.
Les limites se publient avec les résultats.

**Ce qui l'invaliderait :** rien. C'est l'axiome du produit. Un auditeur qui surpromet
n'a plus rien à vendre.

---

## 3. Plan d'exécution

Les lots se font **dans l'ordre**. Un lot n'est ouvert que lorsque le précédent est
terminé au sens de sa définition d'achèvement.

### Lot 0 — Choix du cerveau ✅ FAIT (2026-08-05)

`QA_BRAIN=claude|ollama`, `--cerveau`, `--modele`. Claude en primaire **sans repli** —
se rabattre sur un modèle plus faible rendrait un verdict de moindre qualité sans le
déclarer. Contradiction `QA_LOCAL_ONLY` + `--cerveau claude` refusée. Le rapport annonce
quel cerveau a jugé.

### Lot 1 — `--diff` : la portée du champ ✅ FAIT (2026-08-05)

`--diff` sans référence → le travail non commité (avant de pousser). `--diff <ref>` →
ce qui a divergé depuis ce point, sémantique `ref...HEAD` (avant de fusionner). Accepte
commit, branche, étiquette.

**Mesuré à la livraison**, sur le dépôt de Mango QA lui-même, cerveau Opus 5 :
4 fichiers non commités, deux branches, **28,2 s**, couverture **complète**. À comparer
aux minutes d'un audit de projet entier.

Trois filtres, chacun pour une raison : les suppressions sont exclues (un fichier
effacé compterait comme « découvert mais jamais lu » et ferait paraître la couverture
incomplète) · les fichiers hors du dossier audité aussi (le dépôt peut être plus large)
· les non-sources également (on ne paie pas de jetons pour un `.md`). Le filtre « fichier
source » est **partagé** avec le parcours disque (`estFichierSource`) : deux définitions
divergentes donneraient deux périmètres selon le mode, et une couverture déclarée sur un
périmètre variable ne veut plus rien dire.

**Reporté au lot 5, délibérément :** exposer la portée diff au serveur MCP. Utile, hors
définition d'achèvement de ce lot. Consigné ici plutôt que codé — c'est le § 5 qui
s'applique, pas une bonne idée de séance.

### Lot 2 — Fermer le trou d'honnêteté (`J4-a`) ✅ FAIT (2026-08-08)

Un cerveau qui répondait sans tenir le contrat JSON faisait tomber les six branches en
`skip`, et Mango QA rendait **feu vert, couverture complète, code 0** — sur du code
contenant un vrai défaut. Vérifié en sonde le 2026-08-05.

Les deux volets sont livrés, et aucun ne remplace l'autre : le **préflight**
(`src/preflight.ts`, câblé API + CLI + MCP) coupe court avant de dépenser un audit
entier ; la remontée des **abstentions** couvre la dégradation en cours de run, que le
préflight ne peut pas voir.

**Mesuré à la livraison**, cerveau injoignable sur `src/` (41 fichiers) : `🟢 FEU VERT`
code **0** avant, `⚪ NON VÉRIFIÉ` code **4** après — et **5,2 s** pour le savoir au lieu
d'un audit complet. Le contrat figé n'a pas bougé (`verdict` reste `green`, fail-open
préservé) : ce sont la présentation et le code de sortie qui cessent de certifier.

Chaque `skip` porte sa cause, en deux familles — jugement rendu (`hors-perimetre`,
`juge-sans-avis`) contre panne de l'auditeur (`reponse-illisible`,
`cerveau-injoignable`, `cause-inconnue`). Seule une panne sur branche **bloquante**
interdit le vert. Et `estPanne(undefined) === true` : comme `coverage.complete`,
l'optimisme n'est jamais la valeur par défaut.

`EXIT.NON_VERIFIE = 4` n'est **pas** désactivable, contrairement à `--exiger-couverture` :
une lecture partielle est un mode dégradé légitime, une absence de jugement n'est pas un
audit. Un **ROUGE reste rouge** — un défaut trouvé est un fait que le silence d'une
branche voisine n'annule pas.

Le lot s'est fait auditer par le produit et **recalé deux fois** : la règle de dégradation
recopiée dans trois surfaces (corrigé — `estNonVerifie()` vit dans `verdict.ts`), et une
fuite d'état entre appels MCP, préexistante et sans rapport avec le lot (bornée par
`try/finally`, fond consigné dans `FAILLES.md`). Détail complet :
`eval/rapports/LOT2-HONNETETE.md`.

**Limite honnête :** le volet 2 a été vérifié en réel avec un cerveau *injoignable*,
jamais avec un modèle installé répondant *hors contrat* — aucun de ce profil n'est
disponible sur la machine. Cette cause est couverte à la couture de production par la
sonde (`tests/unit/test-abstention.ts`, 17 tests), pas par un run contre un vrai modèle
incompatible.

### Lot 3 — Conventions du dépôt (axe *Standards*) ✅ FAIT (2026-08-08)

`src/conventions.ts` lit les règles écrites par le projet (`CLAUDE.md`, `AGENTS.md`,
`CONTRIBUTING.md`, `CONVENTIONS.md`, `STYLEGUIDE.md`, `.cursorrules`, `.windsurfrules`,
`.editorconfig`, `.github/copilot-instructions.md`, `.cursor/rules/*`) — **déterministe,
zéro LLM** : il ne comprend pas les règles, il les **localise**. Chaque règle sort avec
son identifiant `fichier:ligne`, ce qui rend la citation vérifiable et la trouvaille
réfutable.

Le scan **remonte jusqu'à la racine du dépôt** (4 parents max, arrêt sur `.git`) : sans
ça, `mangoqa ./src` aurait déclaré « aucune convention documentée » sur un dépôt qui en
écrit trente — une absence affirmée sans avoir été vérifiée, exactement la famille de
mensonge que les lots 2 et 3 suppriment.

**Chaque citation est vérifiée** contre les règles réellement extraites. Une citation qui
ne se résout pas est écartée du crédit de la trouvaille **et reste visible** : effacer
une règle inventée reviendrait à corriger la copie du modèle en silence, alors que c'est
le symptôme de J1-b (affirmer un fait que la source contredit).

**Mesuré à la livraison** : 34 règles lues dans `../../CLAUDE.md` depuis
`MangoOS/server/src` (la remontée fonctionne), **zéro citée et zéro inventée** sur un feu
rouge d'architecture fondé — le bon comportement, sous la charge la plus propice à
l'invention. Mango QA lui-même ne documente aucune convention et le déclare.

Le lot s'est fait auditer par le produit et **recaler deux fois** : la copie du rendu de
`eval/audit-projet.ts` avait divergé (même classe de défaut qu'au lot 2, sur un autre
fichier — corrigé par import de `rendreRapport`), et la faille **L2-a** est remontée
telle quelle. **L2-a a été fermée sur le fond** bien qu'elle n'appartienne pas à ce lot :
une faille enregistrée se corrige, une fonctionnalité attend son lot — c'est la dérive
que le § 5 refuse, pas la réparation. `cap` est passé au contrat (`AuditOptions` →
`AuditContext`), l'environnement n'est plus qu'un repli. Après correction : `🟢 FEU
VERT`, code 0, **23,8 s**. `tsc` propre, **291 tests verts** (27 neufs). Détail :
`eval/rapports/LOT3-CONVENTIONS.md`.

**Limite honnête :** aucun dépôt de cette machine ne documente de vraies conventions **de
code** — celles de MangoOS sont des instructions d'agent. Le critère « une trouvaille
référence un fichier et une ligne » est donc prouvé de bout en bout sur un dépôt
temporaire réel avec un cerveau injecté, jamais avec un vrai modèle sur un vrai dépôt à
conventions de code. Le mécanisme est prouvé, sa **valeur** ne l'est pas. À mesurer au
lot 6, sur un dépôt tiers.

### Lot 4 — Axe *Spec*

Comparer le changement à ce qui était demandé : `--spec <fichier>` ou une issue. Deux
sorties : exigences non satisfaites, et **débordements de périmètre**.

**Achevé quand :** l'axe cite la ligne de spec entre guillemets · l'absence de spec est
déclarée (« aucune spec fournie »), jamais inventée.

### Lot 5 — Intégration

Être plus facile à brancher que l'étalon. Le serveur MCP existe ; il manque une
installation en une commande dans Claude Code, et une action de CI prête à coller.

**Achevé quand :** un utilisateur passe de zéro à un premier verdict en une commande.

### Lot 6 — Prouver

Re-mesurer le corpus étiqueté **avec Opus 5**, publier le tableau et les limites, mettre
la page produit en accord avec les chiffres.

**Achevé quand :** `docs/produit.html` ne contient plus un seul chiffre issu de l'ère du
cerveau local.

---

## 4. Ce qu'on ne fait PAS

Cette liste est la vraie protection contre la dérive. Chaque entrée est une tentation
réelle, refusée par écrit.

| Tentation | Pourquoi refusée |
|---|---|
| Bot de commentaires sur les pull requests | Contredit D2. Terrain d'un concurrent gratuit et mieux intégré. |
| Nouveaux langages (Python, Go, Rust…) | De l'étendue avant le différenciateur donne un LiveReview moins bon. Après le lot 6, pas avant. |
| Passerelle OpenAI / autres fournisseurs | Utile, mais ne rapproche d'aucun lot. Après le lot 6. |
| Reprendre l'intégration MangoOS (`J1-d`) | Hors périmètre produit. Se tranche côté MangoOS. |
| Publier sur npm | `private: true` reste jusqu'au lot 6 — on ne diffuse pas un produit dont le lot 2 n'est pas fait. |
| Interface graphique, tableau de bord | Aucun lot n'en dépend. |
| Réécrire l'existant « au propre » | La règle anti-rechute tient : une capacité nouvelle rejoint une structure existante ou n'entre pas. |
| Relancer l'argumentaire « local, gratuit, souverain » | Contredit D1 et D3. Créneau occupé. |
| Ajouter une branche d'audit | Six suffisent tant que les lots 3 et 4 ne sont pas faits. |

---

## 5. Comment ce document se révise

C'est le point qui rend le « on ne dévie pas » **tenable**. Trois portes, et trois
seulement :

1. **Une mesure contredit une décision.** Le § 2 nomme pour chaque décision ce qui
   l'invaliderait. Si ça arrive, on écrit un ADR-002 qui remplace l'ADR-001 — on ne
   modifie pas celui-ci en douce.
2. **Un lot se révèle impossible tel que défini.** On réécrit sa définition
   d'achèvement, on ne change pas l'ordre des lots.
3. **Raf décide autre chose.** C'est son produit. Mais ça s'écrit ici, daté.

**Tout le reste est une déviation.** Une bonne idée en cours de séance qui n'entre dans
aucun lot ne se code pas : elle s'ajoute au § 4 ou attend l'ADR suivant.

> Un plan qui ne peut pas absorber une preuve n'est pas de la discipline, c'est de
> l'aveuglement. Un plan qu'on change à chaque envie n'est pas de la souplesse, c'est de
> la dérive. Les trois portes ci-dessus sont la frontière entre les deux.
