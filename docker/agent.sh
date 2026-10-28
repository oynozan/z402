#!/bin/sh
# Entrypoint of the agent service (compose.yaml, profile "agent"). Points the demo agent at this stack's API, Zallet
# and Zaino. Flags given after the service name come last and win over these defaults:
#   docker compose run --rm agent --calls 20
# The catalog has its own wallet-free service: docker compose run --rm discover --intent "summarise a web page"
set -eu

exec node --import tsx apps/agent/src/main.ts \
  --api http://api:4021 --zallet-url http://zallet:28232 --lightwalletd http://zaino:8137 "$@"
