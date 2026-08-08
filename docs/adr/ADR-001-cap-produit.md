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

### Lot 4 — Axe *Spec* ✅ FAIT (2026-08-08)

`--spec <fichier>` fournit ce qui était demandé ; `src/spec.ts` (déterministe, zéro LLM)
en **localise** chaque exigence avec sa ligne, et `src/branches/spec.ts` est la **septième
branche** — la seule qui ne juge pas le code mais le TRAVAIL. Placée **en premier** au
registre : le premier échec bloquant porte le Feu Rouge, et quand du code ne fait pas ce
qui était demandé, c'est le seul reproche qui compte.

**La distinction structurante : ce qui manque bloque, ce qui déborde se signale.** Une
exigence non satisfaite est un `fail` avec l'exigence citée entre guillemets ; un
débordement de périmètre est rapporté sans jamais bloquer — faire plus que demandé peut
être légitime, et confondre les deux ferait d'un auditeur un censeur.

Trois garde-fous composés contre le faux positif : la **prudence de couverture** dans le
prompt (« une exigence dont l'implémentation pourrait vivre dans un fichier que tu ne
reçois pas ne compte PAS comme non satisfaite »), la **citation vérifiée** (patron du
lot 3), et `degraderSiNonCitee` — un `fail` qui ne cite aucune exigence vérifiée devient
une observation, parce qu'un feu rouge adossé à rien de réfutable est une opinion.

Une spec **introuvable ou sans exigence lisible** lève `SpecInutilisableError` (code 2,
aucun audit lancé) : elle n'est PAS traitée comme « pas de spec » — l'utilisateur a
demandé qu'on juge contre un document, lui rendre un audit sans spec répondrait à une
autre question.

**Mesuré à la livraison — contrôle apparié, même code, même diff, deux specs :** contre la
spec du lot 4 (implémenté) → `🟢 FEU VERT`, **avec un débordement relevé seul** (trois
ajouts que la liste ne demandait pas) ; contre la spec du lot 5 (pas implémenté) →
`🔴 FEU ROUGE`, `spec:7` citée textuellement, correctif chirurgical — **et refus motivé
d'accuser sur trois autres exigences** dont l'implémentation pouvait vivre hors du
périmètre lu. `tsc` propre, **309 tests verts** (18 neufs). Détail :
`eval/rapports/LOT4-SPEC.md`.

**Limites honnêtes :** un dépôt, deux specs, un modèle — le contrôle apparié écarte « il
crie au loup sur toute spec », il ne mesure pas un taux de détection. Les specs ont été
écrites en puces nettes à partir de ce document, pas en vrai ticket bavard et ambigu. Et
`--spec` ne lit qu'un **fichier** : récupérer une issue demande réseau et
authentification — consigné, pas codé.

### Lot 5 — Intégration ✅ FAIT (2026-08-08)

`mangoqa init [dossier] [--ci] [--hook]` et `mangoqa install-hook` branchent l'auditeur
sur **trois portes**, parce qu'on ne le branche pas au même moment : `.mcp.json`
(l'assistant l'appelle pendant qu'on code), hook `pre-push` (la barrière tombe à la
poussée), action de CI (à plusieurs, sur la forge).

**La règle qui gouverne le module : on n'écrase jamais le travail d'un autre.** Un
`.mcp.json` à trois serveurs, un `pre-push` qui lance déjà des tests, ce sont des heures
de réglage — un outil qui les remplace en silence pour s'installer plus vite est un outil
qu'on désinstalle. Tout fusionne ou refuse : les autres serveurs survivent, une entrée
`mangoqa` différente est respectée (c'est un réglage volontaire), un JSON illisible fait
refuser plutôt qu'écraser, un hook étranger est laissé intact **avec la ligne exacte pour
cohabiter**. Vérifié en réel sur un dépôt portant déjà un serveur `github` et un hook
`npm run test:ci`.

Deux choix qui décident si le hook survit à la semaine : **`--diff` et non le projet
entier** (un `pre-push` doit rester de l'ordre de la dizaine de secondes, sinon il est
désinstallé — et un hook désinstallé ne protège rien) et une **échappatoire explicite**
`MANGOQA_SKIP=1` (sans elle, l'utilisateur passe par `--no-verify`, qui désarme *tous*
les hooks du dépôt). Le code de sortie est propagé tel quel : **`4` bloque aussi**.

En CI, `--exiger-couverture` est activé **là et nulle part ailleurs** : personne n'y lit
le rapport, et un feu vert rendu sur 30 % du code y passerait pour une vérification. Sans
`ANTHROPIC_API_KEY`, le workflow s'arrête (code 2) au lieu de rendre un audit vide.

**Faille L4-a fermée** : `--spec #42` ou une URL d'issue passent par le CLI `gh` déjà
authentifié chez l'utilisateur — **aucun code d'authentification maison**, aucun jeton
stocké, aucune surface d'attaque ajoutée à un outil dont l'argument est la confiance.

**Incident produit par le lot lui-même, et corrigé** : `init` n'agissait que sur
`process.cwd()` ; lancé depuis le dépôt de Mango QA en croyant équiper un autre dossier,
il y a écrit trois fichiers. Nettoyé, puis corrigé à la racine — argument de dossier, et
le chemin visé est annoncé en tête de sortie. `tsc` propre, `npm run build` vert,
**336 tests verts** (27 neufs, dont la moitié gèle des refus), plus deux vérifications
hors TypeScript : le hook passe `sh -n` et son échappatoire rend bien `0`, et le
protocole MCP répond 16/16. Détail : `eval/rapports/LOT5-INTEGRATION.md`.

### Lot 6 — Prouver ✅ FAIT (2026-08-08)

Corpus complet re-mesuré sous **`claude-opus-5`**, primaire, **aucun repli** : 32 cas
(24 à défaut · 8 propres), 2 passes, **88 observations**, 776,5 s.

| Branche | Détection | Ratés | Faux positifs | Abstentions | Pannes | Instables |
|---|---|---|---|---|---|---|
| architecture | **4/4** | 0 | 0/10 | 0 | — | 0 |
| security | **6/6** | 0 | 0/4 *(+4 h.p.)* | 0 | — | 0 |
| accessibility | **5/5** | 0 | **2/8** *(+2 h.p.)* | 0 | — | 0 |
| performance | **4/4** | 0 | 0/10 | 4 | — | 0 |
| tests | **1/1** | 0 | 0/4 | 0 | **2** | 0 |
| design-system *(conseil)* | **4/4** mentions | 0 | 0/4 | 0 | — | 0 |

**Zéro raté, zéro instable, détection 100 % sur les cinq branches bloquantes.** Les 4
abstentions de `performance` sont le bon comportement (code serveur, hors spécialité,
décliné en le disant). Les 2 pannes de `tests` sont des défaillances transitoires du SDK,
sorties du dénominateur et affichées à part.

**Trois défauts de l'INSTRUMENT trouvés avant qu'un chiffre ne soit publié** — un chiffre
rendu sous de mauvaises conditions est pire qu'aucun chiffre : **L6-a** l'en-tête ignorait
`QA_BRAIN` et annonçait le mauvais cerveau (2ᵉ occurrence après J2-d ; tranché par une
preuve — `OLLAMA_URL` sur un port mort, l'audit répond quand même) · **L6-c** le harnais
confondait panne et abstention, ce qui faisait tomber `architecture` à 3/4 et `tests` à
1/2 sur des incidents **réseau** · **L6-b** un test manuel affirmait « 6 branches » en dur
et n'avait rien dit depuis le lot 4, faute d'être exécuté.

**La fausse alerte est publiée avec son analyse.** `LONG-01` → accessibilité : saut de
niveau de titre, **fait vérifié à la main, exact**. Ce n'est pas une hallucination, c'est
le corpus qui affirmait plus qu'il ne pouvait. **L'assertion n'a pas été retirée** (L6-d) :
éditer un corpus après avoir vu un résultat défavorable ruine une mesure, même quand c'est
défendable.

`docs/produit.html` **ne contient plus un seul chiffre de l'ère du cerveau local**. Au
passage : « 1,6 Mo installés » était **périmé** — remesuré à **1,09 Mo** dans un dossier
vierge, corrigé plutôt que recopié. La page affiche désormais le run réel d'`abyss`
**panne comprise** : l'auditeur y trouve deux vrais défauts et refuse quand même de vendre
son verdict comme complet.

**Deux découvertes en conditions réelles** : l'axe *Standards* a **changé un verdict** sur
du vrai code (Tests passe au vert en s'appuyant sur une règle du `CLAUDE.md` du dépôt, là
où le cerveau local rendait rouge) — mais **`cited` est resté vide** (L6-e), le modèle
ayant paraphrasé la règle sans citer son identifiant. Et la panne SDK n'est **pas
aléatoire** (L6-f) : elle se concentre sur les plus gros prompts. Détail :
`eval/rapports/LOT6-PREUVE.md`.

---

## Les sept lots sont clos

Ce qui reste avant une publication npm n'est plus du code, c'est **un dépôt tiers à
auditer** : L140 (pas de vraies conventions de code mesurées), L141 (pas de vrai ticket),
L139 (`reponse-illisible` jamais rejouée contre un vrai modèle incompatible), L5-b (`gh`
non authentifié ici). Le § 4 garde `private: true` jusqu'au lot 6 — il est fait, mais ces
quatre limites disent ce qu'une publication annoncerait sans l'avoir vérifié.

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
