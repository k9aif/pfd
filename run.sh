#!/usr/bin/env bash
# Personal Financial Dashboard: run locally.
#   ./run.sh          the dashboard on PFD_PORT (default 8118): http://localhost:8118
#   ./run.sh test     run the calculation tests (node)
# Data is kept in ./data (gitignored). For the container on the Podman host, see ubuntu/build-run.sh.
set -euo pipefail
cd "$(dirname "$0")"
[[ -f .env ]] || { echo "Copy .env.example to .env and edit it first."; exit 1; }
chmod 600 .env
case "${1:-web}" in
  web)
    set -a; source .env; set +a
    export PORT="${PFD_PORT:-8118}" HOST=127.0.0.1 DATA_DIR="$PWD/data"
    echo "Personal Financial Dashboard on http://localhost:${PORT}"
    exec python3 server.py ;;
  test)
    exec node --test tests/*.test.mjs ;;
  *)
    sed -n '2,5p' "$0"; exit 1 ;;
esac
