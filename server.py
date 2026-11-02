"""Personal Financial Dashboard server.

Serves the static app and keeps the dashboard state in a JSON file on a
mounted volume. Optional: forwards an advice summary to a local Ollama model.
Standard library only.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import date
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DATA_DIR = Path(os.environ.get("DATA_DIR", ROOT / "data"))
STATE_FILE = DATA_DIR / "state.json"
BACKUP_DIR = DATA_DIR / "backups"
BACKUPS_KEPT = 60
MAX_BODY = 2 * 1024 * 1024

OLLAMA_URL = os.environ.get("OLLAMA_URL", "").rstrip("/")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "")
OLLAMA_TIMEOUT = int(os.environ.get("OLLAMA_TIMEOUT", "180"))
BUILD = {"commit": os.environ.get("PFD_COMMIT", "dev"), "built": os.environ.get("PFD_BUILT", "dev")}

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json",
}

ADVICE_PROMPT = """You are explaining a personal FIRE (financial independence) plan to its owner.
Every number below was calculated by the dashboard. Do not invent new numbers or change them.
In plain English and under 350 words:
1. Say which risk tier fits and why, using the success rates and FIRE ages.
2. Explain the two or three most important flags and what to do about each.
3. Name one thing to discuss with a licensed financial advisor or CPA.
Do not recommend specific funds or tickers. This is educational, not financial advice.

{brief}
"""


def asset_version(name: str) -> str:
    return hashlib.sha256((STATIC_DIR / name).read_bytes()).hexdigest()[:12]


def render_index() -> bytes:
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    # Content-hash every local asset so a changed file is never served stale.
    html = re.sub(
        r'(src|href)="/static/([\w.-]+\.(?:js|css))"',
        lambda m: f'{m.group(1)}="/static/{m.group(2)}?v={asset_version(m.group(2))}"',
        html,
    )
    return html.encode("utf-8")


def write_state(payload: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    body = json.dumps(payload, indent=2, sort_keys=True).encode("utf-8")
    fd, tmp = tempfile.mkstemp(dir=DATA_DIR, prefix=".state-", suffix=".json")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(body)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, STATE_FILE)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    # One backup per day, overwritten through the day; oldest pruned.
    backup = BACKUP_DIR / f"state-{date.today().isoformat()}.json"
    backup.write_bytes(body)
    backup.chmod(0o600)
    for old in sorted(BACKUP_DIR.glob("state-*.json"))[:-BACKUPS_KEPT]:
        old.unlink()


def ask_ollama(brief: str) -> str:
    request = urllib.request.Request(
        f"{OLLAMA_URL}/api/generate",
        data=json.dumps({
            "model": OLLAMA_MODEL,
            "prompt": ADVICE_PROMPT.format(brief=brief),
            "stream": False,
            "options": {"temperature": 0.2},
        }).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=OLLAMA_TIMEOUT) as response:
        result = json.loads(response.read())
    text = (result.get("response") or "").strip()
    # Reasoning models may prefix a think block; the user only needs the answer.
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()
    if not text:
        raise ValueError("Ollama returned an empty response")
    return text


class Handler(BaseHTTPRequestHandler):
    server_version = "PersonalFinancialDashboard/1.0"

    def log_message(self, fmt: str, *args) -> None:
        # Request paths only; bodies hold financial data and are never logged.
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    def send_bytes(self, status: int, body: bytes, content_type: str, cache: str = "no-cache") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
        )
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status: int, payload) -> None:
        self.send_bytes(status, json.dumps(payload).encode("utf-8"), "application/json")

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            raise ValueError(f"body must be between 1 and {MAX_BODY} bytes")
        return json.loads(self.rfile.read(length))

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            self.send_bytes(HTTPStatus.OK, render_index(), CONTENT_TYPES[".html"], "no-store")
        elif path == "/healthz":
            self.send_json(HTTPStatus.OK, {"ok": True, **BUILD})
        elif path == "/api/config":
            self.send_json(HTTPStatus.OK, {"llm": bool(OLLAMA_URL and OLLAMA_MODEL), "model": OLLAMA_MODEL})
        elif path == "/api/state":
            if STATE_FILE.exists():
                self.send_bytes(HTTPStatus.OK, STATE_FILE.read_bytes(), "application/json", "no-store")
            else:
                self.send_json(HTTPStatus.NOT_FOUND, {"error": "no saved state yet"})
        elif path.startswith("/static/"):
            self.serve_static(path.removeprefix("/static/"))
        else:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def serve_static(self, name: str) -> None:
        target = (STATIC_DIR / name).resolve()
        if STATIC_DIR not in target.parents or not target.is_file():
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        body = target.read_bytes()
        etag = '"%s"' % hashlib.sha256(body).hexdigest()[:16]
        if self.headers.get("If-None-Match") == etag:
            self.send_response(HTTPStatus.NOT_MODIFIED)
            self.send_header("ETag", etag)
            self.end_headers()
            return
        # no-cache + ETag: the browser revalidates every module import, so
        # files imported by app.js are never stale even without a ?v= hash.
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", CONTENT_TYPES.get(target.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("ETag", etag)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_PUT(self) -> None:
        if self.path != "/api/state":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        try:
            payload = self.read_json()
            if not isinstance(payload, dict) or payload.get("version") != 1:
                raise ValueError("state must be an object with version 1")
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        write_state(payload)
        self.send_json(HTTPStatus.OK, {"saved": True})

    def do_POST(self) -> None:
        if self.path != "/api/advise":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        if not (OLLAMA_URL and OLLAMA_MODEL):
            self.send_json(HTTPStatus.SERVICE_UNAVAILABLE,
                           {"error": "OLLAMA_URL and OLLAMA_MODEL are not set in .env"})
            return
        try:
            brief = str(self.read_json().get("brief", ""))[:20000]
            self.send_json(HTTPStatus.OK, {"text": ask_ollama(brief), "model": OLLAMA_MODEL})
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json(HTTPStatus.BAD_GATEWAY, {"error": str(exc)})
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            self.send_json(HTTPStatus.BAD_GATEWAY, {"error": f"could not reach Ollama at {OLLAMA_URL}: {exc}"})


def main() -> None:
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8118"))
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Personal Financial Dashboard on http://{host}:{port} (data: {DATA_DIR})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
