#!/bin/sh
# Entrypoint of the agent service (compose.yaml, profile "agent"). Points the demo agent at this stack's API, Zallet
# and Zaino, or the discover subcommand at the discovery service. Flags given after the service name come last and
# win over these defaults:
#   docker compose run --rm agent --calls 20
#   docker compose run --rm agent discover --intent "summarise a web page"
set -eu

if [ "${1:-}" = discover ]; then
  shift
  exec node --import tsx apps/agent/src/main.ts discover --discovery http://discovery:4030 "$@"
fi
exec node --import tsx apps/agent/src/main.ts \
  --api http://api:4021 --zallet-url http://zallet:28232 --lightwalletd http://zaino:8137 "$@"
