#!/usr/bin/env bash
# Personal Financial Dashboard: build and run helper (single container, no pod needed)
# Run from any directory on the Podman host (the script uses sudo itself).
#
# Commands:
#   pull     get the latest code (git pull) into this checkout
#   build    build the personal-financial-dashboard container image
#   start    (or up) start the container on 127.0.0.1:8118 (private: no Cloudflare tunnel, ever)
#   stop     stop the container
#   logs     tail logs (request paths only; financial data is never logged)
#   backups  list the daily backups of your numbers
#   all      pull + build + start
#
# Reach it from your Mac:  ssh -L 8118:localhost:8118 <podman-host>  then open http://localhost:8118
# To expose it on the LAN instead, set PFD_BIND=0.0.0.0 in .env (anyone on the network can then read it).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

IMAGE="personal-financial-dashboard:latest"
CONTAINER="personal-financial-dashboard"
PORT=8118
# state.json and backups/ live here.
DATA_HOST_DIR="${HOME}/containers/volumes/personal-financial-dashboard/data"
ENV_FILE="$PROJECT_DIR/.env"

cmd="${1:-help}"

case "$cmd" in

  pull)
    echo "Pulling the latest code into $PROJECT_DIR ..."
    git -C "$PROJECT_DIR" pull --ff-only
    echo "Now at: $(git -C "$PROJECT_DIR" log --oneline -1)"
    ;;

  build)
    echo "Building $IMAGE (context: $PROJECT_DIR) ..."
    cd "$PROJECT_DIR"
    COMMIT=$(git -C "$PROJECT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)
    BUILT=$(date +%Y-%m-%d)
    sudo podman build -t "$IMAGE" -f ubuntu/Containerfile \
      --build-arg PFD_COMMIT="$COMMIT" --build-arg PFD_BUILT="$BUILT" .
    echo "Build $COMMIT · $BUILT"
    echo "Build complete: $IMAGE"
    ;;

  start|up)
    [[ -f "$ENV_FILE" ]] || { echo "Error: $ENV_FILE not found. Copy .env.example to .env and edit it."; exit 1; }
    chmod 600 "$ENV_FILE"
    BIND=$(grep -E '^PFD_BIND=' "$ENV_FILE" | tail -1 | cut -d= -f2)
    BIND="${BIND:-127.0.0.1}"
    sudo mkdir -p "$DATA_HOST_DIR"
    # The container runs as UID 1001 (not root), so it must be able to write here.
    sudo chown -R 1001:0 "$DATA_HOST_DIR"
    sudo chmod 700 "$DATA_HOST_DIR"
    echo "Starting $CONTAINER ..."
    sudo podman rm -f "$CONTAINER" 2>/dev/null || true
    sudo podman run -d \
      --name "$CONTAINER" \
      --restart=always \
      -p "$BIND:$PORT:8118" \
      -v "$DATA_HOST_DIR":/app/data:Z \
      --env-file "$ENV_FILE" \
      "$IMAGE"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Personal Financial Dashboard"
    if [[ "$BIND" == "127.0.0.1" ]]; then
      echo "  Site:    http://localhost:${PORT}/   (this host only)"
      echo "  From your Mac: ssh -L ${PORT}:localhost:${PORT} $(hostname)"
    else
      HOST_IP=$(hostname -I | awk '{print $1}')
      echo "  Site:    http://${HOST_IP}:${PORT}/   (LAN, no login)"
    fi
    echo "  Health:  http://localhost:${PORT}/healthz"
    echo "  Data:    $DATA_HOST_DIR"
    echo "  Logs:    $0 logs"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    ;;

  stop)
    sudo podman stop "$CONTAINER" && sudo podman rm "$CONTAINER"
    ;;

  logs)
    sudo podman logs -f "$CONTAINER"
    ;;

  backups)
    sudo ls -la "$DATA_HOST_DIR/backups"
    ;;

  all)
    "$0" pull
    "$0" build
    "$0" start
    ;;

  *)
    sed -n '2,16p' "$0"
    ;;
esac
