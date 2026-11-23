#!/usr/bin/env bash
set -e

echo "============================================================"
echo "  Starting Kashva Voice Studio..."
echo "============================================================"

# Check Python
if ! command -v python3 &>/dev/null; then
    echo "[ERROR] Python 3 is not installed or not in PATH!"
    exit 1
fi

echo "[1/3] Checking dependencies..."
python3 -m pip install -r requirements.txt --quiet

echo "[2/3] Checking neural models..."
python3 download_models.py

echo "[3/3] Launching Kashva Voice server on http://localhost:7865..."
if command -v xdg-open &>/dev/null; then
    xdg-open "http://localhost:7865" &
elif command -v open &>/dev/null; then
    open "http://localhost:7865" &
fi

python3 app.py --host "${HOST:-0.0.0.0}" --port "${PORT:-7865}"
