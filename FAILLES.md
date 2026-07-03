# FAILLES — registre de l'audit MangoQA

Référence des failles identifiées par l'audit (2026-07) et de leur traitement.
Statut : ✅ FAIT · 🟡 ouvert.

| # | Faille | Priorité | Statut | Modèle optimal | Effort |
|---|--------|----------|--------|----------------|--------|
| Q1 | Famille OOM résiduelle : 3 lectures JSONL NON bornées (`readLatestBrief`, `readMetricsTail`, `loadAll` du Retex) → lecteur partagé borné `src/jsonl.ts` (queue, caps octets + lignes, 1ʳᵉ ligne tronquée jetée) + `src/test-jsonl.ts` | P0 | ✅ FAIT | — | — |
| Q2 | `index.ts` monolithique non testable → moteur extrait dans `src/orchestrator.ts` (dédup, verrou inFlight, ordre des visages, deps injectées) ; Auditeur de Suite CÂBLÉ dans le cycle de phase (gaté `SUITE_EYE=on`, défaut off) + `src/test-orchestrator.ts` | P1 | ✅ FAIT | — | — |
| Q3 | Fail-open = fail-silent : `catch {}` muets dans les runners → tous tracent désormais `console.warn("[mango-qa] <visage>: …")` (comportement inchangé : on avale toujours ; ENOENT = état normal, reste silencieux) | P1 | ✅ FAIT | — | — |
| Q4 | Angles morts de test : `src/test-verdict.ts` (contrat red/green `buildVerdict` + `parseFirstJson`) ; `test-*.ts` et `run-*.ts` inclus dans le typecheck (`tsconfig.json` include) | P2 | ✅ FAIT | — | — |
| Q5 | Polling disjoncteur relit 4 Mo tous les 5 s → lecture incrémentale par offset (`createBusEventsReader` : curseur octets + tampon borné, rotation = reset complet, cap 4 Mo conservé) + tests dans `test-disjoncteur.ts` | P2 | ✅ FAIT | — | — |
| R1 | Double parse des fichiers dans `buildGraph` (flux-eye) : chaque fichier est passé au blob global ET re-parsé individuellement → un seul passage | P3 | 🟡 ouvert | ⚡ Haiku 4.5 | S |
| R2 | `DesignFile` (design-eye/runner.ts) duplique `ProjectFile` (types.ts) : deux types identiques pour la même donnée → unifier sur `ProjectFile` | P3 | 🟡 ouvert | ⚡ Haiku 4.5 | XS |
| R3 | Duplication `renderFiles` (llm.ts vs flux-eye/deep.ts, caps différents) et `walk`/`walkSrc` (orchestrator.ts vs flux-eye/runner.ts, extensions/caps divergents) → helpers partagés paramétrés | P3 | 🟡 ouvert | ⚖️ Sonnet 4.6 | S |

## Notes

- **Q1/Q5** : le pattern anti-OOM (#L70) prouvé par `readBusEvents` est désormais mutualisé dans `src/jsonl.ts` (`readJsonlTail` stateless, `readJsonlSince` incrémental). Toute nouvelle lecture de `.jsonl` doit passer par ce module.
- **Q2** : `SUITE_EYE=on` active l'Auditeur de Suite dans le cycle de phase (défaut off = comportement historique). `run-suite-eye.ts` reste utilisable en CLI ponctuel.
- **Q3** : règle gravée — un `catch` fail-open sans trace est interdit ; seul ENOENT (fichier pas encore créé = état normal) reste silencieux.
