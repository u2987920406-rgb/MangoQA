# J0 — Synthèse : Mango QA a-t-il raison ?

> Clos le **2026-08-04**. Corpus : 23 cas étiquetés (19 à défaut · 4 propres), 3 passes,
> 2 cerveaux locaux, **0 mock**, coût réel **0 €**.
> Rapports bruts : `eval/rapports/J0-2026-08-04-*.md` · JSON : `corpus-*.json`.

## La question de départ

Le `README` de Mango QA le disait lui-même : le code est une **reconstruction** (2026-06-19),
les prompts et seuils des 6 branches sont une réimplémentation jamais mesurée. Le seul chiffre
existant venait de la sonde MangoOS du 2026-07-24 : **1 raté sur 4** défauts rejoués.

**On savait que le mécanisme tournait. On ne savait pas s'il avait raison.**

---

## Résultat — comparatif des deux cerveaux locaux

| | **qwen2.5-coder:14b** | **gemma4:latest** |
|---|---|---|
| **Détection** | **16/16** (100 %) | 14/16 (88 %) |
| **Faux positifs** | **0/45** (0 %) | 7/45 (16 %) |
| **Instabilité** (verdict qui change entre passes) | **0** | 4 |
| **Abstentions** | 3 *(toutes correctes)* | 3 |
| **Durée moyenne** | **13,6 s** / audit | 15,3 s / audit |
| **Corpus complet ×3** | 21 min | 24 min |
| **Coût** | **0 €** | **0 €** |

### Par branche — qwen2.5-coder

| Branche | Détection | Faux positifs | Instables |
|---|---|---|---|
| architecture | 3/3 | 0/12 | 0 |
| security | 5/5 | 0/6 | 0 |
| accessibility | 4/4 | 0/9 | 0 |
| performance | 3/3 | 0/9 | 0 |
| tests | 1/1 | 0/3 | 0 |
| design-system *(conseil)* | 6/6 mentions | 0/6 | 0 |

### Par branche — gemma4

| Branche | Détection | Faux positifs | Instables |
|---|---|---|---|
| architecture | 3/3 | **4/12** | 1 |
| security | 4/5 ¹ | 0/6 | 1 |
| accessibility | **3/4** ² | 0/9 | 1 |
| performance | 3/3 | 0/9 | 1 |
| tests | 1/1 | **3/3** ³ | 0 |
| design-system *(conseil)* | 6/6 mentions | 0/6 | 0 |

¹ Non détecté sur une passe pour cause d'abstention — la règle de comptage exige les 3 passes.
² **Vrai raté** : `A11Y-01` (contraste 2.8:1) jugé conforme en passe 2 — *« le composant est
sémantiquement correct »*. Le modèle a répondu à côté de la question posée.
³ `TEST-02` (contrôle : logique métier **avec** ses tests) rejeté aux 3 passes — *« manque de
couverture pour les valeurs intermédiaires entre les seuils »*. Exigence infinie : aucun code
testé ne satisferait ce critère.

---

## Recommandation : `qwen2.5-coder:14b`

Trois raisons, dans l'ordre de force :

1. **0 faux positif sur 45 observations propres.** C'est le chiffre qui décide de l'adoption :
   un auditeur qui rejette du bon code cesse d'être lu, et un auditeur qu'on n'ouvre plus ne
   protège plus rien.
2. **0 instabilité sur 3 passes.** Condition nécessaire pour un usage en CI — un verdict qui
   change d'un run à l'autre est inexploitable, quel que soit le taux de détection.
3. **Détection parfaite ET pour le bon motif.** Vérifié une par une : chaque verdict nomme
   précisément le défaut injecté (*« injection SQL via la requête construite par
   concaténation »*, *« la fonction formatPrix est dupliquée dans trois fichiers »*). Ce n'est
   pas un modèle qui crie au loup — c'est un modèle qui lit.

**Réponse à la question de Raf (« Gemma4 peut-il faire le travail ? ») : oui, mais moins bien.**
Gemma4 détecte l'essentiel et respecte le contrat JSON — le risque redouté (un modèle local qui
bavarde et casse le parsing) ne s'est jamais matérialisé chez aucun des deux. Mais il est trop
sévère et moins stable. Sur ce corpus, le modèle **spécialisé code** l'emporte nettement sur le
généraliste, ce qui est cohérent avec la tâche.

> **Un panachage par branche n'est pas justifié.** L'hypothèse de départ était que Gemma4, plus
> généraliste, serait meilleur là où il faut du raisonnement humain (accessibilité, design).
> Mesure faite, c'est faux : gemma4 est à égalité sur design-system (6/6) et **en dessous** sur
> l'accessibilité (3/4 contre 4/4, avec un vrai raté). Un seul cerveau pour les 6 branches.

---

## Le résultat le plus important n'est pas un chiffre

**Trois défauts réels du produit ont été trouvés — aucun n'était visible sans mesurer.**

### 1. La branche Sécurité était aveugle à `import.meta.env`

`SEC-01` (clé de **service** Supabase préfixée `VITE_`, donc inlinée dans le bundle) n'était
**jamais lu** : verdict « non pertinent » en 0,0 s. Le filtre ne connaissait que `process.env`
(convention Node), alors que tout le front Vite — donc **toutes les apps générées par MangoOS** —
écrit `import.meta.env`.

Le prompt de la branche mentionnait pourtant déjà *« préfixe VITE_ pour une clé secrète »* : le
jugement était prévu, **c'est le filtre qui l'empêchait d'arriver**.
→ *Classe de bug à retenir : un filtre trop étroit rend un bon prompt muet.*

### 2. La branche Performance ne voyait aucun fichier `.ts`

Son filtre était `['.jsx', '.tsx', '.js']`. Dans un projet Vite+TS, les utils, hooks, stores et
clients d'API sont en `.ts` : **seuls les composants étaient audités, jamais la logique.**

Et corriger le filtre seul n'aurait pas suffi — la spécialité ne mentionnait **aucun** critère de
poids de bundle. Le fichier serait arrivé au modèle sans qu'aucune règle ne s'y applique. Les deux
défauts devaient être corrigés ensemble.

### 3. La branche Architecture rejetait du code idiomatique

`CLEAN-04` — composant React de 25 lignes qui charge sa propre liste paginée, avec
`AbortController` — était rejeté par **trois modèles de familles différentes** (Claude Haiku,
gemma4, qwen2.5-coder), tous avec le même motif : *« mélange data-fetching et présentation »*.

Quand trois modèles indépendants convergent, l'explication la plus probable n'est pas qu'ils ont
tous tort. **Le prompt listait ce symptôme sans seuil, tout en définissant un échec comme « un
défaut qui rendra la maintenance COÛTEUSE ».** Les modèles satisfaisaient la liste de symptômes
en violant la barre de gravité que le prompt s'était lui-même fixée.

Conséquence produit si on n'y touchait pas : **tout composant React qui charge ses propres données
devient un feu rouge** — soit l'écrasante majorité du code généré.

**Correctif** : seuil de gravité + une clause explicite disant ce qui **n'est pas** un échec
(composant court auto-suffisant, état local près de son usage, abstraction dont rien ne prouve le
besoin), et une règle de sortie : *« si tu ne peux pas nommer le coût de maintenance, réponds
pass »*.

**Résultat vérifié sur les trois familles de modèles :**

| | avant | après |
|---|---|---|
| Architecture — détection | 3/3 | **3/3** *(préservée)* |
| Architecture — faux positifs (Haiku) | 1/4 | **0/4** |
| Architecture — faux positifs (qwen, ×3 passes) | — | **0/12** |

> **Enseignement réutilisable pour les 5 autres branches : nommer les NON-échecs est plus
> efficace, sur un juge LLM, qu'affiner la liste des échecs.**
>
> Réserve honnête : le correctif n'a **pas** suffi pour gemma4, qui continue de rejeter `CLEAN-04`
> aux 3 passes malgré la clause explicite. Le respect d'une contrainte négative dépend de la
> capacité du modèle — c'est un critère de sélection du cerveau, pas seulement de rédaction du prompt.

---

## Deux défauts de configuration trouvés au passage

1. **`QA_OLLAMA_MODEL` n'est pas défini** → le défaut du code est `qwen3.5:cloud`, un modèle
   **non installé** sur la machine. Chaque audit partait le chercher, expirait à 25 s, ×3 essais :
   **~75 s brûlées par audit** avant chaque repli vers Claude. Sans effet sur la justesse des
   verdicts, mais toutes les durées du premier run complet en étaient gonflées.

2. **`ollama-client.ts` lisait sa configuration au chargement du module.** En ESM, les imports
   sont évalués avant le corps de l'appelant : le harnais aurait fixé le modèle trop tard, et
   **j'aurais mesuré `qwen3.5:cloud` en croyant mesurer gemma4**. Corrigé en lecture paresseuse —
   la convention déjà établie dans `flags.ts` côté MangoOS.

---

## Ce que J0 ne dit pas — limites honnêtes

- **Le corpus est petit** : 23 cas, dont 19 à défaut. Un score parfait dessus ne garantit rien
  au-delà. Il faut l'élargir avec des défauts rencontrés en vrai.
- **Les défauts sont propres** : injectés isolément, dans des fichiers courts. Le code généré
  réel est plus long, plus bruyant, avec plusieurs défauts qui se masquent l'un l'autre.
- **Une seule pile technique** : web TS/JS/React. Rien sur Python, Go, Vue, Svelte.
- **Le contenu n'est toujours pas couvert.** La conclusion du 2026-07-24 tient : Mango QA protège
  le **code**, pas le **contenu** (un quiz dont toutes les réponses sont « a » passerait). Ce gap
  est structurel — aucune des 6 branches ne juge la justesse d'une donnée.
- **Un détail de justification peut être inventé.** Sur `ARCH-01`, qwen écrit *« plus de
  300 lignes »* alors que le fichier en fait ~90. Le verdict est juste, **le chiffre cité ne l'est
  pas**. Pour un produit dont l'argument est « on cite toujours la source, la ligne et la règle »,
  c'est à traiter avant publication.

---

## Verdict de J0

> **Mango QA a raison — mesuré, pas supposé.**
> Sur 23 cas étiquetés et 3 passes : **16/16 détections, 0 faux positif, 0 instabilité**, avec un
> cerveau **100 % local et gratuit**.
>
> Ce chiffre n'était pas acquis au départ : la mesure a trouvé **trois défauts réels du produit**,
> dont deux rendaient des branches entières partiellement aveugles sur exactement le type de code
> que MangoOS génère.

**J0 est atteint. Le jalon suivant (J1 — détacher) peut commencer.**

### Suites recommandées, par ordre

1. Définir `QA_OLLAMA_MODEL=qwen2.5-coder:14b` dans le `.env` — arrête les 75 s perdues par audit
   et le débit du forfait Ollama.
2. Appliquer le patron « nommer les non-échecs » aux 5 autres branches, puis re-mesurer.
3. Traiter les chiffres inventés dans les justifications (imposer la citation de la ligne réelle).
4. Élargir le corpus : défauts multiples par projet, fichiers longs, une seconde pile technique.
