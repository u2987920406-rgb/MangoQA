# J1 — Détacher : Mango QA audite n'importe quel dossier

> Clos le **2026-08-04**. Critère de réussite fixé en J0 :
> *« `auditProject('./nimporte-quel-dossier')` rend un verdict, sans MangoOS. »*
> **Atteint** — et la première exécution sur du vrai code a trouvé deux défauts du produit.

---

## Ce qui a été construit

| Fichier | Rôle |
|---|---|
| `src/audit.ts` | **API autonome** : `auditProject(dir, opts)` → rapport complet. Aucun fichier-signal, aucun workspace, aucun watcher. |
| `src/config.ts` | `MANGOQA_ROOT`, avec repli strict sur `MANGOAI_WORKSPACE` (une installation MangoOS existante ne casse pas). |

Le chemin historique (`orchestrator.ts` + watcher chokidar) est **inchangé** et continue de servir
l'intégration MangoOS. Les deux partagent le même moteur et le même calcul de verdict —
il n'y a pas deux vérités.

### Ce qu'il a fallu ajouter, et ce qui existait déjà

`readProjectFiles()` savait **déjà** parcourir un dossier entier quand aucun delta n'est fourni.
Le collecteur générique existait ; il était seulement inatteignable sans `phase-complete.json`.
Le seul vrai manque était la synthèse du `PhaseSignal` — c'est-à-dire **quatre champs**.

> Confirmation nette de l'audit de cadrage : Mango QA n'était pas couplé à MangoOS,
> il était seulement **déclenché** par lui.

### Ajouts d'API notables

- **`concurrency`** — les 6 branches ne partent plus forcément toutes en parallèle. Sur cerveau
  local mono-GPU, le total est le même (Ollama sérialise de toute façon), mais à `concurrency: 1`
  les verdicts tombent **un par un** au lieu de rester bloqués 6 minutes. Indispensable pour une CLI.
- **`onBranch`** — affichage au fil de l'eau.
- **`relevant() === [] → skip`, jamais `pass`.** Distinguer « rien à auditer » de « audité et
  conforme » est ce qui empêche un rapport de mentir par omission.

---

## Première exécution sur du vrai code

Cible : `D:\IA\MangoOS\workspace\abyss` — un projet réellement généré par MangoOS,
jamais audité par ce chemin. 20 fichiers, cerveau `qwen2.5-coder:14b` local.

```
  🟢 🏗️ Architecture     51.4s  19 fichiers  Aucune violation structurelle claire identifiée.
  🟢 🔒 Sécurité         40.8s   4 fichiers  Aucune vulnérabilité OWASP détectée.
  ⚪ ♿ Accessibilité     51.9s  13 fichiers  Aucun élément pertinent à auditer.
  🔴 ⚡ Performance      75.3s  19 fichiers  Liste sans clé stable dans le composant Catalogue.
  🔴 🧪 Tests            85.8s  19 fichiers  Aucun fichier de test n'existe dans le projet.
  🟢 🎨 Design System    59.5s  14 fichiers  Cohérence respectée, palette réutilisée.

  VERDICT : 🔴 FEU ROUGE — branche performance (React Key Prop)
  Correctif : « Ajouter une clé unique (par exemple `c.id`) à chaque élément de la liste
               générée par filtered.map dans le composant Catalogue. »
```

**Le mécanisme fonctionne de bout en bout.** Mais un auditeur ne se croit pas sur parole :
les deux feux rouges ont été vérifiés à la main dans le code.

---

## 🔴 Défaut 1 — un faux positif sur du vrai code (hallucination)

`src/components/Catalogue.jsx:306`

```jsx
{filtered.map((c) => (
  <CreatureCard
    key={c.id}        // ← la clé est LÀ, ligne 308
```

**Le correctif proposé recommande exactement ce qui existe déjà.**

Les trois `.map()` du fichier (lignes 156, 265, 306) ont tous leur `key`. Vérifié un par un.

Et ce n'est pas un problème de troncature : mesure faite, `Catalogue.jsx` était **intégralement
présent dans le prompt**, et la chaîne `key={c.id}` s'y trouvait bien. **Le modèle avait
l'information sous les yeux et a affirmé le contraire.**

> **Ce que ça invalide.** Le corpus J0 donnait `0/45 faux positifs`. La première rencontre avec
> du vrai code en produit un immédiatement. La limite déclarée en J0 se confirme, plus vite
> qu'attendu : *« les défauts sont propres — injectés isolément, dans des fichiers courts ; le
> code réel est plus long, plus bruyant »*. Un fichier de 334 lignes ne se juge pas comme un
> fixture de 12.
>
> **Le score de J0 reste vrai, mais il ne mesure pas ce qu'on croyait.** Il mesure la capacité à
> juger un défaut isolé, pas à juger du code réel. Le corpus doit accueillir des fichiers longs.

---

## 🔴 Défaut 2 — l'auditeur ne voit que 27 % du code, et ne le dit pas

Mesuré sur ce même projet, branche Performance :

| | |
|---|---|
| Fichiers retenus par `relevant()` | **19** |
| Caractères totaux | **90 268** |
| Cap du prompt (`FILE_PAYLOAD_CAP`) | **24 000** |
| Caractères réellement envoyés au modèle | **24 013 — soit 27 %** |
| **Fichiers effectivement vus** | **5 / 19** |
| **Fichiers jamais vus** | **14** |

`renderFiles()` remplit le prompt jusqu'au cap puis fait `break` : les fichiers suivants sont
**abandonnés en silence**. Le rapport, lui, affiche « 19 fichiers » et rend un verdict comme s'il
avait tout lu.

**C'est plus grave que le défaut 1.** Un faux positif se voit et s'ignore. Ici, un vrai défaut
présent dans les 73 % non lus produirait un **feu vert** — et rien, nulle part, n'indiquerait que
l'audit était partiel. C'est exactement le mensonge par omission que le produit prétend combattre.

**Ce n'est pas un bug de code** — `renderFiles` fait ce qui est écrit. C'est un **défaut de
conception** : il manque la notion de couverture. Trois pistes, à trancher :

1. **Découper** — auditer par lots de fichiers et fusionner les verdicts (coût : N appels au lieu de 1).
2. **Déclarer** — afficher « 5/19 fichiers audités » dans le rapport et dans le verdict.
   Correctif minimal, honnête, immédiat.
3. **Prioriser** — `sortByPriority()` existe déjà ; s'assurer que les fichiers les plus à risque
   passent en premier, et dire lesquels ont été écartés.

> **La 2 est non négociable, quelle que soit la suite retenue.** Un auditeur a le droit de ne pas
> tout lire ; il n'a pas le droit de le taire.

---

## Confirmation du conflit de latence avec MangoOS

L'audit complet a pris **365 s** sur un projet réel (20 fichiers, cerveau local, `concurrency: 1`).

Le chemin de production MangoOS est `runClosureMangoQA` (`relay-closure.ts`), budget **60 s**
(`MANGOQA_CLOSURE_TIMEOUT`). `surfaceVerdict`, la voie asynchrone à 300 s, **n'est appelée nulle
part** dans le code de production.

→ Un audit local sur projet réel dépasse le budget d'un facteur 6. En l'état, MangoOS marquerait
chaque clôture « non-vérifiée » (fail-open) et **l'audit disparaîtrait sans bruit**.

**Sans effet sur Mango QA en usage autonome** (CLI / CI / MCP) : aucun budget de 60 s là-bas.
C'est un problème d'**intégration**, à trancher côté MangoOS — soit relever le timeout, soit
câbler le chemin non bloquant déjà écrit.

---

## Verdict de J1

> **Atteint.** Mango QA audite n'importe quel dossier de code, sans MangoOS, sans fichier-signal,
> sans workspace. Vérifié sur un projet réel.
>
> Et comme en J0, l'exercice a servi à autre chose qu'à cocher une case : **deux défauts réels du
> produit**, dont un — l'audit partiel silencieux — touche à la promesse même de l'outil.

### À traiter avant J3 (la CLI)

| # | Sujet | Priorité |
|---|---|---|
| 1 | **Déclarer la couverture** (« 5/19 fichiers audités ») dans le rapport et le verdict | **bloquant** |
| 2 | Décider du découpage en lots vs cap assumé | haut |
| 3 | Ajouter des **fichiers longs et réalistes** au corpus, puis re-mesurer | haut |
| 4 | Trancher l'intégration MangoOS (timeout vs non-bloquant) | moyen, hors MangoQA |
