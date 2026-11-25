#!/usr/bin/env bash
# Monta a pasta para subir no Space (Files › Upload files): Dockerfile + README do Space + app.py, lowmem.py, requirements.txt.
#   bash voice-worker/hf-space/montar.sh /tmp/mck-voz-space
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"; OUT="${1:-/tmp/mck-voz-space}"
rm -rf "$OUT" && mkdir -p "$OUT"
cp "$D/Dockerfile" "$D/README.md" "$OUT/"
cp "$D/../app.py" "$D/../lowmem.py" "$D/../requirements.txt" "$OUT/"
echo "Pronto: $OUT"
