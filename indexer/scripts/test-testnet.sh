#!/usr/bin/env bash
# Runs src/test/testnet.test.ts: the real handlers over the live Monad testnet deployment
# (config.testnet.yaml), compared with the contracts. Needs ENVIO_API_TOKEN (indexer/.env) for
# HyperSync. The test indexer only reads config.yaml, so this swaps it in and always swaps it back.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && { set -a; . ./.env; set +a; }
: "${ENVIO_API_TOKEN:?set ENVIO_API_TOKEN in indexer/.env}"
cp config.yaml .config.local.yaml
restore() { mv .config.local.yaml config.yaml; pnpm -s codegen >/dev/null; }
trap restore EXIT
cp config.testnet.yaml config.yaml
pnpm -s codegen >/dev/null
KLEOS_TESTNET=1 pnpm -s vitest run src/test/testnet.test.ts --test-timeout=600000 --silent=false --reporter=verbose
