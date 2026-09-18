# 🥭 Mango QA — Audit Fantôme pour MangoOS

Processus Node.js **indépendant** de MangoOS qui audite chaque phase de build et
répond un verdict **Feu Vert / Feu Rouge / Non vérifié** par le système de fichiers.

> ⚠️ **Reconstruction du 2026-06-19.** Le code original (testé à l'atelier) n'a pas
> pu être rapatrié (clé USB absente). Cette version a été **reconstruite à partir
> du contrat d'interface figé** `mangoai/server/src/mangoqa.ts` + le guide de
> transfert V2 + la spec « Production Aveugle / Audit Fantôme ». Elle est
> **fonctionnellement compatible** avec MangoOS (même contrat I/O), mais les
> détails internes des branches (prompts, seuils) sont une réimplémentation, pas
> le code byte-identique de l'atelier. Si l'original revient, comparer puis
> remplacer/fusionner.

## Contrat autonome — septembre 2026

Lancer les deux projets depuis `mangoai` avec `npm run setup`, puis `npm start`.
Le dépôt MangoQA doit se trouver à côté de mangoai, ou être indiqué par `MANGOQA_DIR`.
Le modèle d'audit doit être configuré séparément : démarrer le processus ne prouve pas que son fournisseur répond.

Un contrôle techniquement impossible donne `skip`, une branche sans objet donne `not_applicable`.
Un verdict `green` exige au moins une branche bloquante réussie et aucune branche bloquante en `skip`.
Un échec prouvé donne `red` ; sinon, une vérification incomplète donne `unknown`.
Le verdict porte `signalTimestamp` pour permettre à Mango de distinguer l'audit demandé d'un résultat ancien.
Un nouveau signal reçu pendant un audit est repris à sa fin (le dernier état de chaque projet est conservé).
La création peut continuer sans audit ; la publication refuse les audits absents, incomplets ou non corrélés.

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
