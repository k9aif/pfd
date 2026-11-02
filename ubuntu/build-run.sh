#!/usr/bin/env bash
# Personal Financial Dashboard: build and run helper (single container, no pod needed)
# Run from any directory. On Linux it uses sudo itself; on macOS it uses the rootless Podman machine.
#
# Commands:
#   pull     get the latest code (git pull) into this checkout (skipped when there is no remote)
#   build    build the personal-financial-dashboard container image
#   start    (or up) start the container on 127.0.0.1:8118 (private: no Cloudflare tunnel, ever)
#   stop     stop the container
#   logs     tail logs (request paths only; financial data is never logged)
#   backups  list the daily backups of your numbers
#   adduser <name>     add a person (up to 3) or change their password, then restart
#   removeuser <name>  remove a person, then restart (their dashboard file stays)
#   all      pull + build + start
#
# On the Mac itself: open http://localhost:8118. On a remote Podman host: ssh -L 8118:localhost:8118 <host>
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

# macOS: rootless Podman machine, no sudo, and the VM maps file ownership itself.
if [[ "$(uname)" == "Darwin" ]]; then MAC=1; SUDO=""; else MAC=0; SUDO="sudo"; fi

cmd="${1:-help}"

case "$cmd" in

  pull)
    if ! git -C "$PROJECT_DIR" rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then
      echo "No git remote for this checkout; building from the working copy."
      exit 0
    fi
    echo "Pulling the latest code into $PROJECT_DIR ..."
    git -C "$PROJECT_DIR" pull --ff-only
    echo "Now at: $(git -C "$PROJECT_DIR" log --oneline -1)"
    ;;

  build)
    echo "Building $IMAGE (context: $PROJECT_DIR) ..."
    cd "$PROJECT_DIR"
    COMMIT=$(git -C "$PROJECT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)
    BUILT=$(date +%Y-%m-%d)
    if [[ $MAC == 1 ]] && ! podman machine inspect --format "{{.State}}" 2>/dev/null | grep -q running; then
      echo "Starting the Podman machine ..."; podman machine start
    fi
    $SUDO podman build --format docker -t "$IMAGE" -f ubuntu/Containerfile \
      --build-arg PFD_COMMIT="$COMMIT" --build-arg PFD_BUILT="$BUILT" .
    echo "Build $COMMIT · $BUILT"
    echo "Build complete: $IMAGE"
    ;;

  start|up)
    [[ -f "$ENV_FILE" ]] || { echo "Error: $ENV_FILE not found. Copy .env.example to .env and edit it."; exit 1; }
    chmod 600 "$ENV_FILE"
    BIND=$(grep -E '^PFD_BIND=' "$ENV_FILE" | tail -1 | cut -d= -f2)
    BIND="${BIND:-127.0.0.1}"
    $SUDO mkdir -p "$DATA_HOST_DIR"
    if [[ $MAC == 0 ]]; then
      # The container runs as UID 1001 (not root), so it must be able to write here.
      sudo chown -R 1001:0 "$DATA_HOST_DIR"
    fi
    $SUDO chmod 700 "$DATA_HOST_DIR"
    echo "Starting $CONTAINER ..."
    $SUDO podman rm -f "$CONTAINER" 2>/dev/null || true
    $SUDO podman run -d \
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
      [[ $MAC == 1 ]] || echo "  From your Mac: ssh -L ${PORT}:localhost:${PORT} $(hostname)"
    else
      if [[ $MAC == 1 ]]; then HOST_IP=$(ipconfig getifaddr en0 || echo localhost); else HOST_IP=$(hostname -I | awk '{print $1}'); fi
      echo "  Site:    http://${HOST_IP}:${PORT}/   (LAN, no login)"
    fi
    echo "  Health:  http://localhost:${PORT}/healthz"
    echo "  Data:    $DATA_HOST_DIR"
    echo "  Logs:    $0 logs"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    ;;

  stop)
    $SUDO podman stop "$CONTAINER" && $SUDO podman rm "$CONTAINER"
    ;;

  logs)
    $SUDO podman logs -f "$CONTAINER"
    ;;

  backups)
    $SUDO ls -la "$DATA_HOST_DIR/backups"
    ;;

  adduser|passwd|removeuser)
    [[ -n "${2:-}" ]] || { echo "Usage: $0 $cmd <name>"; exit 1; }
    sub=passwd; [[ "$cmd" == removeuser ]] && sub=removeuser
    PFD_ENV_FILE="$ENV_FILE" python3 "$PROJECT_DIR/server.py" "$sub" "$2"
    if $SUDO podman container exists "$CONTAINER"; then "$0" start; fi
    ;;

  all)
    "$0" pull
    "$0" build
    "$0" start
    ;;

  *)
    sed -n '2,18p' "$0"
    ;;
esac
