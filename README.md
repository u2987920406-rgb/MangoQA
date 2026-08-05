# 🥭 Mango QA — Audit Fantôme pour MangoOS

Processus Node.js **indépendant** de MangoOS qui audite chaque phase de build et
répond un verdict **Feu Vert / Feu Rouge** par le système de fichiers.

Depuis J1/J3 (2026-08), il s'utilise aussi **seul**, sans MangoOS, sans fichier-signal :

```bash
npm run audit -- ./mon-projet                    # verdict + couverture
npm run audit -- ./mon-projet --only security,tests
npm run audit -- . --json rapport.json --exiger-couverture
```

| Code de sortie | Sens |
|---|---|
| `0` | 🟢 Feu Vert |
| `1` | 🔴 Feu Rouge — une branche bloquante a échoué |
| `2` | Erreur d'usage (dossier introuvable, option inconnue). **Jamais** un défaut d'audit |
| `3` | Feu Vert sur lecture **partielle**, avec `--exiger-couverture` |

> **La couverture s'affiche avec le verdict, jamais en note de bas de page.** Mango QA dit
> combien de fichiers il a réellement envoyés au modèle et **nomme ceux qu'il n'a pas vus**.
> Un auditeur a le droit de ne pas tout lire ; il n'a pas le droit de le taire — c'est le
> défaut n°2 de J1, corrigé en J2 (`eval/rapports/J2-COUVERTURE.md`).
>
> Le code `3` existe pour la CI : il est **distinct** du Feu Rouge, parce qu'aucun défaut
> n'a été trouvé. On refuse seulement de traiter « rien vu » comme « rien à signaler ».

> ⚠️ **Reconstruction du 2026-06-19.** Le code original (testé à l'atelier) n'a pas
> pu être rapatrié (clé USB absente). Cette version a été **reconstruite à partir
> du contrat d'interface figé** `mangoai/server/src/mangoqa.ts` + le guide de
> transfert V2 + la spec « Production Aveugle / Audit Fantôme ». Elle est
> **fonctionnellement compatible** avec MangoOS (même contrat I/O), mais les
> détails internes des branches (prompts, seuils) sont une réimplémentation, pas
> le code byte-identique de l'atelier. Si l'original revient, comparer puis
> remplacer/fusionner.

## Architecture

```
MangoOS écrit  <projet>/.mangoqa/phase-complete.json   (PhaseSignal)
        │
        ▼  (chokidar « entre sans frapper »)
Mango QA  ──────────────────────────────────────────────────
        │   3 VISAGES + Flux/Suite/Observateur (abonnement Claude, $0)
        │
        │   🏛️ Visage 1 : JUGE (6 branches d'audit en parallèle)
        │      🏗️ architecture · 🔒 sécurité · ♿ accessibilité
        │      ⚡ performance · 🧪 tests · 🎨 design-system (conseil)
        │      ─► verdicts binaires (Feu Vert/Rouge) dans <projet>/.mangoqa/
        │
        │   👀 Visage 2 : OBSERVATEUR-CONSEIL (analyzeEvents, amorce #R-bonus)
        │      Analyse patterns de rejets récurrents (fenêtre temporelle TODO)
        │      Aucun garde-fou, pas de verdict — conseils à Raf seulement
        │      ─► rapport CONSTAT dans <projet>/.mangoqa/observer-report.json
        │
        │   🧠 Visage 3 : Flux/Suite (orchestration, retry, apprentissage)
        │      Relit le Retex (historique) pour affiner les branches
        │
        ▼
Mango QA écrit  <projet>/.mangoqa/audit-verdict.json    (QAVerdict)
        │
        └─► si red : journalise dans .mangoqa-retex.jsonl (Boîte Noire)
            et réinjecte préemptivement aux audits suivants.
```

**Note technique** : L'Observateur n'exploite pas encore `ts` (timestamps) pour
les fenêtres temporelles glissantes — actuellement agrégation globale (share =
part-des-rejets dans l'historique entier, pas part-des-audits). Fenêtre glissante
réservée pour une future vague.

- **Sentinelle** : `workspace/.mangoqa-active` (heartbeat 10 s) → MangoOS détecte
  automatiquement que Mango QA tourne via `isMangoQaActive()`. Rien à configurer.
- **Contrat I/O figé** : `src/types.ts` (`PhaseSignal`, `QAVerdict`, `Rejection`).
  Ne pas en changer la forme sans changer aussi `mangoqa.ts` côté MangoOS.
- **Fail-open** : toute défaillance de Mango QA (réseau, parsing) devient un
  `skip` — la production n'est jamais bloquée par une erreur de l'auditeur.
- **Branches** : `src/branches/*.ts`. `design-system` est en **conseil** (jamais
  de Feu Rouge). Ordre dans `src/index.ts` = priorité du rejet.

## Installation

```bash
cd D:\IA\MangoQA
npm install
# créer .env (déjà présent ici) : MANGOAI_WORKSPACE pointe sur le workspace MangoOS
```

## Lancer

```bash
npm run dev              # watch (redémarre à chaque modif de code)
npm run start            # one-shot, sans supervision
npm run watch:supervised # RECOMMANDÉ pour une session longue durée (relance auto)
npm run typecheck
```

MangoOS détecte Mango QA tout seul dès qu'il tourne. Si le terminal n'est pas
lancé, MangoOS continue normalement (fail-open).

**`npm run watch:supervised`** (limites.md L127) : superviseur léger (`src/watchdog.ts`)
qui relance `src/index.ts` automatiquement s'il crashe OU si sa sentinelle
`.mangoqa-active` cesse d'être rafraîchie (process vivant mais bloqué). MangoQA a
connu 2 crashs réels par fuite mémoire progressive sur des sessions multi-heures
(SOUV-D, 2026-07-15) — ce mode absorbe le symptôme (continuité de service) sans
corriger la fuite elle-même (cause racine encore ouverte). Log dans `watchdog.log`.

## ⚠️ Bug chokidar connu

Un `phase-complete.json` écrit via PowerShell `Set-Content` ou Bash MINGW n'est
pas toujours vu par chokidar. Pour un **déclenchement manuel**, écrire le signal
via Node : `node -e "require('fs').writeFileSync(...)"` (même mécanisme que
MangoOS). N'affecte pas le flux normal (MangoOS écrit déjà via Node).

## Validé e2e (2026-06-19)

Cycle complet prouvé sur un projet de test : Feu Rouge ♿ (inputs sans label,
`div onClick`, `img` sans alt) → Retex journalisé → correction → Feu Vert.
