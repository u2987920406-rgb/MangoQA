#!/usr/bin/env python3
"""Pont Laya → MangoQA.

MangoQA est en Node, Laya en Python : ce pont expose HTTP minimal (stdlib, zéro
dépendance serveur) sur le SDK `laya`.

Mode SHADOW uniquement : ce pont ne calcule aucun verdict MangoQA, il renvoie
des probabilités calibrées que MangoQA journalise À CÔTÉ du verdict LLM
(.mangoqa/laya-shadow.jsonl) — matière première pour un fine-tuning ultérieur.

Point d'attention (README « Honest Limits ») :
- zéro-shot ≈ hasard sur typed-decisions → ces probabilités ne décident de RIEN
  tant qu'elles ne sont pas affinées sur le corpus MangoQA ;
- checkpoint anglais = anglais seul → on charge `multilingual` (les résumés de
  branche sont en français) ;
- USE_TF=0 avant tout import de transformers : deadlock abseil (README).

Usage :
    .venv/bin/python server.py            # écoute LAYA_PORT (8791)
    curl -s localhost:8791/health
    curl -s -X POST localhost:8791/decide -d '{"state":{...},"questions":{...}}'
"""
from __future__ import annotations

import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# AVANT tout import transformers/laya (deadlock TF/abseil — README).
os.environ.setdefault("USE_TF", "0")

REPO = os.environ.get("LAYA_REPO", "convaiinnovations/laya")
# multilingual = mmBERT-base, 1024 ctx (768 tokens d'état), 100+ langues.
SUBFOLDER = os.environ.get("LAYA_SUBFOLDER", "multilingual")
PORT = int(os.environ.get("LAYA_PORT", "8791"))
MAX_BODY = 64 * 1024  # état + questions : borné (anti-passthrough sauvage)

_agent = None  # chargé une fois, résident en mémoire
_load_ms = 0


def agent():
    """Charge le checkpoint une seule fois (froid = téléchargement 1ᵉʳ appel)."""
    global _agent, _load_ms
    if _agent is None:
        t0 = time.time()
        import laya  # import tardif : USE_TF doit être posé avant

        _agent = laya.load(REPO, subfolder=SUBFOLDER)
        _load_ms = int((time.time() - t0) * 1000)
        print(f"[laya-bridge] checkpoint chargé ({SUBFOLDER}) en {_load_ms} ms", flush=True)
    return _agent


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):  # journal verbeux du serveur HTTP étouffé
        return

    def do_GET(self):  # noqa: N802
        if self.path.rstrip("/") in ("", "/health"):
            self._send(
                200,
                {
                    "ok": True,
                    "repo": REPO,
                    "subfolder": SUBFOLDER,
                    "loaded": _agent is not None,
                    "load_ms": _load_ms,
                },
            )
        else:
            self._send(404, {"error": "unknown path"})

    def do_POST(self):  # noqa: N802
        if self.path.rstrip("/") != "/decide":
            self._send(404, {"error": "unknown path"})
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0 or n > MAX_BODY:
            self._send(400, {"error": "body manquant ou trop gros"})
            return
        try:
            req = json.loads(self.rfile.read(n).decode("utf-8"))
            state = req["state"]
            questions = req["questions"]
            if not isinstance(questions, dict) or not questions:
                self._send(400, {"error": "questions vides"})
                return
        except (ValueError, KeyError, UnicodeDecodeError) as exc:
            self._send(400, {"error": f"payload invalide: {exc}"})
            return

        t0 = time.time()
        try:
            # Un seul forward pass pour TOUTES les questions (force de Laya).
            # `Agent.predict` est l'alias de `system_one` (laya/agent.py).
            result = agent().predict(state, questions)
        except Exception as exc:  # le pont ne tue jamais MangoQA : 500 explicite
            self._send(500, {"error": f"{type(exc).__name__}: {exc}"})
            return
        self._send(
            200,
            {
                "answers": result.get("answers", {}),
                "ms": int((time.time() - t0) * 1000),
                "model": f"{REPO}/{SUBFOLDER}",
            },
        )


def main() -> None:
    print(f"[laya-bridge] préchargement du checkpoint ({SUBFOLDER})…", flush=True)
    agent()  # prêt avant d'écouter : le 1ᵉʳ appel MangoQA n'attend pas le froid
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[laya-bridge] prêt sur http://127.0.0.1:{PORT} (shadow only)", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
