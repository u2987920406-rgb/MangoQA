# Pont Laya → MangoQA (shadow)

MangoQA (Node) ne peut pas importer Laya (Python) : ce dossier expose un pont
HTTP minimal sur le SDK `laya`, **zéro dépendance serveur** (stdlib).

## Rôle — SHADOW UNIQUEMENT

Laya **ne décide de rien** dans le verdict. Chaque verdict de branche bloquante
est soumis à un 2ᵉ avis calibré, journalisé **à côté** du verdict :

    <projet>/.mangoqa/laya-shadow.jsonl

Ce fichier est la matière première d'un futur fine-tuning sur le corpus
MangoQA (`evals/corpus.jsonl`). Tant qu'aucun fine-tuning n'a eu lieu, les
probabilités ne servent qu'à être mesurées (README Laya « Honest Limits » :
zéro-shot ≈ hasard, 0.362 vs 0.318 random).

## Démarrage

```bash
cd laya-bridge
.venv/bin/python server.py          # précharge le checkpoint puis écoute :8791
curl -s localhost:8791/health
```

Env : `LAYA_PORT` (8791), `LAYA_SUBFOLDER` (multilingual — les résumés de
branche sont en français), `LAYA_REPO`.

## Côté MangoQA

`QA_LAYA=on` dans `.env` active l'appel (défaut off = comportement historique
inchangé). URL : `QA_LAYA_URL` (défaut `http://127.0.0.1:8791`). Fail-open
toujours : pont mort → `console.warn`, verdict LLM intact.

## Endpoint

`POST /decide` `{state: {...}, questions: {...}}` →
`{answers, ms, model}` — toutes les questions sont résolues en **un seul**
forward pass.
