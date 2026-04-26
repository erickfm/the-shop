#!/usr/bin/env bash
# Clones HSDLib (Ploaj, MIT) so the-shop-hsd C# CLI can reference it.
# HSDLib is a build-time dep of our texture/preview tooling and is not
# committed to this repo to avoid vendoring upstream code.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
if [ -d HSDLib/.git ]; then
  echo "HSDLib already present at $SCRIPT_DIR/HSDLib"
  exit 0
fi
rm -rf HSDLib
git clone --depth 1 https://github.com/Ploaj/HSDLib.git
echo "HSDLib cloned to $SCRIPT_DIR/HSDLib"
