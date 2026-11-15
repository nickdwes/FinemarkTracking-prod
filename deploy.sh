#!/usr/bin/env bash
# Deploy finemark-prod: type-check, build image(s), redeploy via docker compose.
#
# Usage:
#   ./deploy.sh                 # build + deploy backend and frontend
#   ./deploy.sh backend         # build + deploy backend only
#   ./deploy.sh frontend        # build + deploy frontend only (skips tsc)
#   ./deploy.sh -y              # same as above but skip the confirmation prompt
#   ./deploy.sh backend -y
set -euo pipefail
cd "$(dirname "$0")"

TARGET="all"
AUTO_YES=false
for arg in "$@"; do
  case "$arg" in
    backend|frontend|all) TARGET="$arg" ;;
    -y|--yes) AUTO_YES=true ;;
    *) echo "Usage: $0 [backend|frontend|all] [-y]" >&2; exit 1 ;;
  esac
done

case "$TARGET" in
  backend)  SERVICES="backend" ;;
  frontend) SERVICES="frontend" ;;
  all)      SERVICES="backend frontend" ;;
esac

echo "==> Target: $SERVICES"

if [[ -d .git ]] && ! git diff --quiet 2>/dev/null; then
  echo "==> Note: uncommitted changes present (this is normal for this repo — deploying working tree as-is)"
fi

if [[ "$SERVICES" == *backend* ]]; then
  echo "==> Type-checking backend..."
  (cd finemark-backend && npx tsc --noEmit)
  echo "    tsc passed"
fi

echo "==> Building: $SERVICES"
docker compose build $SERVICES

if [[ "$AUTO_YES" != true ]]; then
  read -rp "==> Deploy $SERVICES to prod now? [y/N] " confirm
  if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "Aborted — images built but not deployed. Re-run with the same target to deploy the built image(s)."
    exit 1
  fi
fi

echo "==> Deploying: $SERVICES"
docker compose up -d $SERVICES

if [[ "$SERVICES" == *backend* ]]; then
  echo "==> Waiting for backend health..."
  for i in $(seq 1 30); do
    status=$(docker compose ps backend --format '{{.Status}}' 2>/dev/null || true)
    if [[ "$status" == *"(healthy)"* ]]; then
      echo "    backend healthy"
      break
    fi
    if [[ "$status" == *"Exited"* || "$status" == *"unhealthy"* ]]; then
      echo "    backend failed to start:" >&2
      docker compose logs backend --tail 40 >&2
      exit 1
    fi
    sleep 2
    if [[ "$i" == 30 ]]; then
      echo "    backend did not report healthy within 60s — check logs:" >&2
      docker compose logs backend --tail 40 >&2
      exit 1
    fi
  done
fi

echo "==> Status"
docker compose ps $SERVICES

echo "==> Recent logs"
docker compose logs $SERVICES --tail 15

echo "==> Deployment complete"
