#!/usr/bin/env bash
# Personal Financial Dashboard: run locally.
#   ./run.sh          the dashboard on PFD_PORT (default 8118): http://localhost:8118
#   ./run.sh test     run the tests (node for the math, python for the server)
#   ./run.sh adduser <name>     add a person (up to 3) or change their password
#   ./run.sh passwd <name>      same as adduser
#   ./run.sh removeuser <name>  remove a person (their dashboard file stays)
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
    node --test tests/*.test.mjs
    exec python3 -m unittest discover -s tests -p 'test_*.py' ;;
  adduser|passwd)
    [[ -n "${2:-}" ]] || { echo "Usage: ./run.sh $1 <name>"; exit 1; }
    exec python3 server.py passwd "$2" ;;
  removeuser)
    [[ -n "${2:-}" ]] || { echo "Usage: ./run.sh removeuser <name>"; exit 1; }
    exec python3 server.py removeuser "$2" ;;
  *)
    sed -n '2,8p' "$0"; exit 1 ;;
esac
