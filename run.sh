#!/usr/bin/env bash
# Build and (re)start the dashboard in Podman. Data lives in the named volume
# pfd-data, so rebuilding or removing the container keeps your numbers.
set -euo pipefail
cd "$(dirname "$0")"

NAME=personal_financial_dashboard
[ -f .env ] || { cp .env.example .env; chmod 600 .env; echo "Created .env from .env.example"; }
PORT=$(grep -E '^PFD_PORT=' .env | cut -d= -f2)
PORT=${PORT:-8095}

podman build --format docker -t "$NAME" -f Containerfile .
podman rm -f "$NAME" >/dev/null 2>&1 || true
# Bound to 127.0.0.1 only: reachable from this machine, not the network.
podman run -d --name "$NAME" \
  --env-file .env \
  -p "127.0.0.1:${PORT}:8095" \
  -v pfd-data:/data \
  --restart unless-stopped \
  "$NAME"
echo "Personal Financial Dashboard: http://127.0.0.1:${PORT}"
