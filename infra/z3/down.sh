#!/usr/bin/env bash
# Stop the z402 Z3 regtest stack. --wipe also deletes the z3-regtest-* volumes (chain, wallet, Zaino).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/lib.sh"

wipe=0
case "${1:-}" in
  --wipe) wipe=1 ;;
  "") ;;
  *) die "usage: bash infra/z3/down.sh [--wipe]" ;;
esac

[ -d "$Z3_DIR" ] || { info "no Z3 checkout at $Z3_DIR, nothing to stop"; exit 0; }

if [ "$wipe" -eq 1 ]; then
  step "Stopping the Z3 regtest stack and deleting its volumes"
  compose --profile '*' down --volumes --remove-orphans 2>&1 | sed 's/^/    /'
  info "regtest chain and wallet are gone, the next up.sh starts from height 0"
else
  step "Stopping the Z3 regtest stack (volumes kept)"
  compose --profile '*' down --remove-orphans 2>&1 | sed 's/^/    /'
fi
