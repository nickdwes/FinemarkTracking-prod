#!/usr/bin/env bash
# Durable Metro dev server for the Finemark mobile app, exposed via Caddy at
# https://metro.finemarktracking.co.ke (reverse_proxy -> localhost:8081).
#
# Run under pm2 so it survives disconnects and auto-restarts on crash:
#   pm2 start ./start-metro.sh --name metro-mobile
#   pm2 logs metro-mobile
#   pm2 stop metro-mobile        # take it offline when not developing
#
# NODE_OPTIONS raises the heap to 4 GB — the full-app bundle + React Compiler
# exceeds Node's ~2 GB default and OOM-crashes without this.

cd "$(dirname "$0")" || exit 1
export EXPO_PACKAGER_PROXY_URL="https://metro.finemarktracking.co.ke"
export EXPO_NO_TELEMETRY=1
export NODE_OPTIONS="--max-old-space-size=4096"

exec npx expo start --dev-client
