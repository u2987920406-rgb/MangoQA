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
| R1 | Double parse des fichiers dans `buildGraph` (flux-eye) : chaque fichier est passé au blob global ET re-parsé individuellement → un seul passage par fichier, symboles/machines fusionnés depuis les ASTs par fichier (`symbolsFromRoots`/`machinesFromRoots`) — liens inter-fichiers préservés | P3 | ✅ FAIT | — | — |
| R2 | `DesignFile` (design-eye/runner.ts) duplique `ProjectFile` (types.ts) : deux types identiques pour la même donnée → `DesignFile` est maintenant un alias de `ProjectFile`, signatures `inspectProjectDesign`/`runDesignEye` sur `ProjectFile` | P3 | ✅ FAIT | — | — |
| R3 | Duplication `renderFiles` (llm.ts vs flux-eye/deep.ts, caps différents) et `walk`/`walkSrc` (orchestrator.ts vs flux-eye/runner.ts, extensions/caps divergents) → module partagé `src/fs-shared.ts` (`renderFiles(files, cap, label)` + `walkTree` paramétré), les deux visages pointent dessus | P3 | ✅ FAIT | — | — |

## Notes

- **Q1/Q5** : le pattern anti-OOM (#L70) prouvé par `readBusEvents` est désormais mutualisé dans `src/jsonl.ts` (`readJsonlTail` stateless, `readJsonlSince` incrémental). Toute nouvelle lecture de `.jsonl` doit passer par ce module.
- **Q2** : `SUITE_EYE=on` active l'Auditeur de Suite dans le cycle de phase (défaut off = comportement historique). `run-suite-eye.ts` reste utilisable en CLI ponctuel.
- **Q3** : règle gravée — un `catch` fail-open sans trace est interdit ; seul ENOENT (fichier pas encore créé = état normal) reste silencieux.
- **R1** : la fusion par-fichier (au lieu du blob concaténé) peut en théorie diverger du blob dans un cas adversarial (un fichier gravement malformé qui aurait corrompu tout le parse du blob) ; sur du code réel (top-level statements indépendants), le comportement observable est identique — prouvé par la suite `test-flux-eye.ts` (résolution de constantes réparties sur 3+ fichiers tiers, setter appelé depuis 4 fichiers distincts, redéfinition de clé, fichier cassé à côté de fichiers sains).
- **R3** : `walkTree` généralise `walk`/`walkSrc` via un callback `visit` — reproduit à l'identique la nuance historique où un fichier illisible ne consommait pas de place dans `maxFiles` (flux-eye) alors qu'un chemin non lu en comptait un (orchestrator, qui ne lit pas le contenu à ce stade).
- **Visage 2 (Observateur-Conseil)** : amorce non câblée — `src/observer.ts` (module pur, événements injectés) + `src/test-observer.ts`. Détecte des patterns de défaillance récurrents (branche/règle/projet au-dessus d'un seuil configurable) et produit des SUGGESTIONS texte pour Raf, jamais d'action. Volontairement PAS branché dans `orchestrator.ts`/`index.ts` — à câbler dans une session dédiée (source d'événements réelle à définir : Retex existant ou nouvel historique de verdicts).
