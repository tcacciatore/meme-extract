#!/bin/sh
# Lance Meme Extract sur http://127.0.0.1:5050
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "Création de l'environnement virtuel (.venv)…"
  PY=$(command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3)
  "$PY" -m venv .venv && .venv/bin/pip install -q -U pip -r requirements.txt
fi
exec .venv/bin/python app.py
