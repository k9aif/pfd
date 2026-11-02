"""Personal Financial Dashboard server.

Serves the landing page and the app, signs users in (up to three, defined in
.env as scrypt hashes), and keeps one JSON file per dashboard on a mounted
volume. Optional: forwards an advice summary to a local Ollama model.
Standard library only.

    python3 server.py                     run the server
    python3 server.py passwd <name>       add a user or change their password (writes .env)
    python3 server.py removeuser <name>   remove a user from .env (their data stays on disk)
"""

from __future__ import annotations

import base64
import getpass
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timezone
from html import escape
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DATA_DIR = Path(os.environ.get("DATA_DIR", ROOT / "data"))
DASHBOARD_DIR = DATA_DIR / "dashboards"
BACKUP_DIR = DATA_DIR / "backups"
ENV_FILE = Path(os.environ.get("PFD_ENV_FILE", ROOT / ".env"))
BACKUPS_KEPT = 60
MAX_BODY = 2 * 1024 * 1024

MAX_USERS = 3
HOUSEHOLD = "household"
NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,23}$")
SESSION_COOKIE = "pfd_session"
SESSION_IDLE_SECONDS = 12 * 3600
LOCK_AFTER_FAILURES = 5
LOCK_SECONDS = 60
SCRYPT = {"n": 2**14, "r": 8, "p": 1}

# Public demo (e.g. a hosted "play with it" site): only demo/demo, every sign-in gets its own
# throwaway dashboards in memory, and nothing is written to disk. The LLM explanation follows
# .env as usual, limited per visitor and to one at a time so strangers cannot tie up the GPU.
PUBLIC_DEMO = os.environ.get("PFD_PUBLIC_DEMO") == "1"
DEMO_SESSION_IDLE_SECONDS = 2 * 3600
MAX_DEMO_SESSIONS = 500
DEMO_MAX_BODY = 256 * 1024
DEMO_EXPLAINS_PER_SESSION = 3
_llm_slot = threading.BoundedSemaphore(1)
# Behind Cloudflare (or another proxy) every request comes from 127.0.0.1; trust its client-IP header.
TRUST_PROXY = os.environ.get("PFD_TRUST_PROXY") == "1"

OLLAMA_URL = os.environ.get("OLLAMA_URL", "").rstrip("/")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "")
OLLAMA_TIMEOUT = int(os.environ.get("OLLAMA_TIMEOUT", "180"))
REPO_URL = os.environ.get("PFD_REPO_URL", "").strip()
BUILD = {"commit": os.environ.get("PFD_COMMIT", "dev"), "built": os.environ.get("PFD_BUILT", "dev")}

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json",
}

ADVICE_PROMPT = """You are explaining a personal FIRE (financial independence) plan to its owner.
The dashboard has already chosen the risk tier and calculated every number below.
Rules: use only the numbers given, never change or invent one, and never pick a different tier.
In plain English and under 300 words:
1. Explain why the recommended tier ({recommended}) fits, using its success rate and FIRE age compared with the other tiers.
2. Explain the two or three most important flags and what to do about each.
3. Name one thing to discuss with a licensed financial advisor or CPA.
Do not recommend specific funds or tickers. This is educational, not financial advice.

{brief}
"""


# ---- Users and passwords ----------------------------------------------------
# .env line: PFD_USER_1=<name>:scrypt:<n>:<r>:<p>:<salt>:<hash>  (base64url, so it is
# safe to `source` from bash and to pass with podman --env-file).

def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, dklen=32, **SCRYPT)
    return f"scrypt:{SCRYPT['n']}:{SCRYPT['r']}:{SCRYPT['p']}:{_b64(salt)}:{_b64(digest)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt, digest = stored.split(":")
        if scheme != "scrypt":
            return False
        actual = hashlib.scrypt(password.encode(), salt=_unb64(salt), n=int(n), r=int(r), p=int(p), dklen=32)
        return hmac.compare_digest(actual, _unb64(digest))
    except (ValueError, TypeError):
        return False


# Spent on unknown names so a wrong user name takes as long as a wrong password.
_DUMMY_HASH = hash_password(secrets.token_hex(8))


def parse_users(env) -> dict[str, str]:
    users = {}
    for slot in range(1, MAX_USERS + 1):
        line = (env.get(f"PFD_USER_{slot}") or "").strip()
        if not line:
            continue
        name, _, stored = line.partition(":")
        if not NAME_RE.match(name) or not stored.startswith("scrypt:"):
            raise SystemExit(f"PFD_USER_{slot} in .env is malformed; reset it with ./run.sh passwd <name>")
        if name == HOUSEHOLD:
            raise SystemExit(f"PFD_USER_{slot}: '{HOUSEHOLD}' is reserved for the shared dashboard")
        users[name] = stored
    return users


def update_env_users(env_file: Path, name: str, stored: str | None) -> str:
    """Sets (stored) or removes (None) a user's slot in .env. Returns what happened."""
    lines = env_file.read_text().splitlines() if env_file.exists() else []
    slot_re = re.compile(r"^PFD_USER_([1-9])=(.*)$")
    slots: dict[int, tuple[int, str]] = {}
    for i, line in enumerate(lines):
        m = slot_re.match(line)
        if m and int(m.group(1)) <= MAX_USERS:
            slots[int(m.group(1))] = (i, m.group(2).split(":", 1)[0])

    existing = next((s for s, (_, n) in slots.items() if n == name), None)
    if stored is None:
        if existing is None:
            raise SystemExit(f"No user named {name} in {env_file}")
        lines[slots[existing][0]] = f"PFD_USER_{existing}="
        result = f"Removed {name} (slot {existing}). Their dashboard file stays in the data folder."
    else:
        target = existing or next((s for s in range(1, MAX_USERS + 1) if not slots.get(s, (0, ""))[1]), None)
        if target is None:
            raise SystemExit(f"All {MAX_USERS} user slots are taken. Remove one first: ./run.sh removeuser <name>")
        entry = f"PFD_USER_{target}={name}:{stored}"
        if target in slots:
            lines[slots[target][0]] = entry
        else:
            lines.append(entry)
        result = f"{'Changed password for' if existing else 'Added'} {name} (slot {target})."

    env_file.write_text("\n".join(lines) + "\n")
    env_file.chmod(0o600)
    return result


# With no users in .env the app runs in demo mode: one "demo" login (password "demo")
# shown on the landing page. Adding a real user turns it off.
DEMO_USER = "demo"


def load_users(env) -> tuple[dict[str, str], bool]:
    users = parse_users(env)
    if users:
        return users, False
    return {DEMO_USER: hash_password(DEMO_USER)}, True


USERS: dict[str, str] = {}
DEMO = False


# ---- Sessions and login throttling -------------------------------------------

_lock = threading.Lock()
_sessions: dict[str, dict] = {}
_failures: dict[str, dict] = {}


def session_idle_seconds() -> int:
    return DEMO_SESSION_IDLE_SECONDS if PUBLIC_DEMO else SESSION_IDLE_SECONDS


def new_session(user: str) -> str:
    token = secrets.token_urlsafe(32)
    with _lock:
        if PUBLIC_DEMO:
            now = time.time()
            for t in [t for t, s in _sessions.items() if now - s["seen"] > DEMO_SESSION_IDLE_SECONDS]:
                del _sessions[t]
            # Bounded memory: the least recently used sandbox goes first.
            while len(_sessions) >= MAX_DEMO_SESSIONS:
                del _sessions[min(_sessions, key=lambda t: _sessions[t]["seen"])]
        _sessions[token] = {"user": user, "seen": time.time(), "docs": {}}
    return token


def sandbox(token: str | None) -> dict:
    """The calling session's own dashboards (public demo only)."""
    with _lock:
        return _sessions[token]["docs"]


def session_user(token: str | None) -> str | None:
    if not token:
        return None
    with _lock:
        s = _sessions.get(token)
        if not s:
            return None
        if time.time() - s["seen"] > session_idle_seconds() or s["user"] not in USERS:
            _sessions.pop(token, None)
            return None
        s["seen"] = time.time()
        return s["user"]


def end_session(token: str | None) -> None:
    with _lock:
        _sessions.pop(token or "", None)


def locked_for(ip: str) -> float:
    with _lock:
        f = _failures.get(ip)
        return max(0.0, f["until"] - time.time()) if f else 0.0


def record_failure(ip: str) -> None:
    with _lock:
        f = _failures.setdefault(ip, {"count": 0, "until": 0.0})
        f["count"] += 1
        if f["count"] >= LOCK_AFTER_FAILURES:
            f["until"] = time.time() + LOCK_SECONDS
            f["count"] = 0


def clear_failures(ip: str) -> None:
    with _lock:
        _failures.pop(ip, None)


# ---- Dashboards on disk ------------------------------------------------------

def dashboard_ids() -> list[str]:
    names = list(USERS)
    return ([HOUSEHOLD] if len(names) > 1 else []) + names


def dashboard_path(dashboard_id: str) -> Path:
    return DASHBOARD_DIR / f"{dashboard_id}.json"


def read_dashboard(dashboard_id: str) -> dict | None:
    path = dashboard_path(dashboard_id)
    return json.loads(path.read_text()) if path.exists() else None


_write_lock = threading.Lock()


class Conflict(Exception):
    pass


def next_meta(current: dict | None, payload: dict, user: str) -> dict:
    current_meta = (current or {}).get("_meta") or {}
    current_version = current_meta.get("version", 0)
    sent_version = (payload.get("_meta") or {}).get("version", 0)
    # Someone else saved since this browser loaded the dashboard: refuse rather than overwrite.
    if current is not None and sent_version != current_version:
        raise Conflict(f"Changed by {current_meta.get('updatedBy', 'someone')} at "
                       f"{current_meta.get('updatedAt', 'an earlier time')}. Reload to see their version.")
    return {
        "version": current_version + 1,
        "updatedBy": user,
        "updatedAt": datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M"),
    }


def write_sandbox(docs: dict, dashboard_id: str, payload: dict, user: str) -> dict:
    with _write_lock:
        meta = next_meta(docs.get(dashboard_id), payload, user)
        docs[dashboard_id] = {**payload, "_meta": meta}
        return meta


def write_dashboard(dashboard_id: str, payload: dict, user: str, reset: bool = False) -> dict:
    with _write_lock:
        current = read_dashboard(dashboard_id)
        meta = next_meta(current, payload, user)
        if reset and current is not None:
            # The daily backup is overwritten through the day, so keep what a reset replaces.
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            _atomic_write(BACKUP_DIR / f"{dashboard_id}-before-reset-{stamp}.json",
                          json.dumps(current, indent=2, sort_keys=True).encode("utf-8"))
        payload = {**payload, "_meta": meta}
        body = json.dumps(payload, indent=2, sort_keys=True).encode("utf-8")
        _atomic_write(dashboard_path(dashboard_id), body)
        # One backup per dashboard per day, overwritten through the day; oldest pruned.
        backup = BACKUP_DIR / f"{dashboard_id}-{date.today().isoformat()}.json"
        _atomic_write(backup, body)
        for old in sorted(BACKUP_DIR.glob(f"{dashboard_id}-*.json"))[:-BACKUPS_KEPT]:
            old.unlink()
        return meta


def _atomic_write(path: Path, body: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(body)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def migrate_single_state() -> None:
    """The first version kept one state.json; it becomes the first user's dashboard."""
    old = DATA_DIR / "state.json"
    if old.exists() and USERS:
        target = dashboard_path(next(iter(USERS)))
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(old, target)
            print(f"Moved {old.name} to {target.relative_to(DATA_DIR)}", flush=True)


# ---- HTTP --------------------------------------------------------------------

def asset_version(name: str) -> str:
    return hashlib.sha256((STATIC_DIR / name).read_bytes()).hexdigest()[:12]


def render_page(name: str) -> bytes:
    html = (STATIC_DIR / name).read_text(encoding="utf-8")
    # Content-hash every local asset so a changed file is never served stale.
    html = re.sub(
        r'(src|href)="/static/([\w.-]+\.(?:js|css))"',
        lambda m: f'{m.group(1)}="/static/{m.group(2)}?v={asset_version(m.group(2))}"',
        html,
    )
    # The landing page shows where to clone from; set PFD_REPO_URL once the repo is published.
    html = html.replace("{{REPO_URL}}", escape(REPO_URL or "<repository URL>"))
    return html.encode("utf-8")


def recommended_tier(brief: str) -> str:
    m = re.search(r"Recommended tier by rule: ([^.\n]+)", brief)
    return m.group(1).strip() if m else "stated below"


def ask_ollama(brief: str) -> str:
    request = urllib.request.Request(
        f"{OLLAMA_URL}/api/generate",
        data=json.dumps({
            "model": OLLAMA_MODEL,
            "prompt": ADVICE_PROMPT.format(brief=brief, recommended=recommended_tier(brief)),
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
    server_version = "PersonalFinancialDashboard/1.1"

    def log_message(self, fmt: str, *args) -> None:
        # Request paths only; bodies hold financial data and passwords and are never logged.
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    # -- helpers

    def cookie(self, name: str) -> str | None:
        for part in (self.headers.get("Cookie") or "").split(";"):
            key, _, value = part.strip().partition("=")
            if key == name:
                return value
        return None

    def user(self) -> str | None:
        return session_user(self.cookie(SESSION_COOKIE))

    def client_ip(self) -> str:
        if TRUST_PROXY:
            forwarded = self.headers.get("CF-Connecting-IP") or (self.headers.get("X-Forwarded-For") or "").split(",")[0]
            if forwarded.strip():
                return forwarded.strip()
        return self.client_address[0]

    def session_cookie(self, token: str, max_age: int) -> str:
        secure = "; Secure" if TRUST_PROXY else ""
        return f"{SESSION_COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={max_age}{secure}"

    def send_bytes(self, status: int, body: bytes, content_type: str, cache: str = "no-store",
                   extra: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
            "script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
        )
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status: int, payload, extra: dict | None = None) -> None:
        self.send_bytes(status, json.dumps(payload).encode("utf-8"), "application/json", extra=extra)

    def redirect(self, location: str) -> None:
        self.send_response(HTTPStatus.SEE_OTHER)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def read_json(self):
        limit = DEMO_MAX_BODY if PUBLIC_DEMO else MAX_BODY
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > limit:
            raise ValueError(f"body must be between 1 and {limit} bytes")
        return json.loads(self.rfile.read(length))

    def same_origin_write(self) -> bool:
        # A custom header cannot be sent cross-site without a CORS preflight, which
        # this server never grants, so other sites cannot post to it.
        return self.headers.get("X-PFD") == "1"

    # -- routes

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        user = self.user()
        if path == "/":
            if user:
                self.redirect("/app")
            else:
                self.send_bytes(HTTPStatus.OK, render_page("landing.html"), CONTENT_TYPES[".html"])
        elif path == "/app":
            if user:
                self.send_bytes(HTTPStatus.OK, render_page("index.html"), CONTENT_TYPES[".html"])
            else:
                self.redirect("/")
        elif path == "/healthz":
            self.send_json(HTTPStatus.OK, {"ok": True, **BUILD})
        elif path == "/api/status":
            self.send_json(HTTPStatus.OK, {"usersConfigured": not DEMO, "demo": DEMO, "publicDemo": PUBLIC_DEMO,
                                           "maxUsers": MAX_USERS})
        elif path.startswith("/static/"):
            self.serve_static(path.removeprefix("/static/"))
        elif not path.startswith("/api/"):
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
        elif not user:
            self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "sign in first"})
        elif path == "/api/me":
            self.send_json(HTTPStatus.OK, {
                "user": user, "users": list(USERS), "dashboards": dashboard_ids(), "household": HOUSEHOLD,
                "llm": bool(OLLAMA_URL and OLLAMA_MODEL), "model": OLLAMA_MODEL,
                "demo": DEMO, "publicDemo": PUBLIC_DEMO, "repoUrl": REPO_URL, **BUILD,
            })
        elif path == "/api/dashboards":
            if PUBLIC_DEMO:
                docs = sandbox(self.cookie(SESSION_COOKIE))
                self.send_json(HTTPStatus.OK, {d: docs.get(d) for d in dashboard_ids()})
            else:
                self.send_json(HTTPStatus.OK, {d: read_dashboard(d) for d in dashboard_ids()})
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

    def do_POST(self) -> None:
        if not self.same_origin_write():
            self.send_json(HTTPStatus.FORBIDDEN, {"error": "missing X-PFD header"})
            return
        if self.path == "/api/login":
            self.login()
        elif self.path == "/api/logout":
            end_session(self.cookie(SESSION_COOKIE))
            self.send_json(HTTPStatus.OK, {"ok": True}, {"Set-Cookie": self.session_cookie("", 0)})
        elif self.path == "/api/advise":
            if self.user():
                self.advise()
            else:
                self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "sign in first"})
        else:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def login(self) -> None:
        ip = self.client_ip()
        wait = locked_for(ip)
        if wait:
            self.send_json(HTTPStatus.TOO_MANY_REQUESTS, {"error": f"Too many attempts. Try again in {int(wait) + 1} seconds."})
            return
        try:
            body = self.read_json()
            name = str(body.get("name", "")).strip().lower()
            password = str(body.get("password", ""))
        except (ValueError, json.JSONDecodeError, AttributeError):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "name and password required"})
            return
        stored = USERS.get(name)
        ok = verify_password(password, stored or _DUMMY_HASH) and stored is not None
        if not ok:
            record_failure(ip)
            self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "Name or password is wrong."})
            return
        clear_failures(ip)
        token = new_session(name)
        self.send_json(HTTPStatus.OK, {"user": name}, {"Set-Cookie": self.session_cookie(token, session_idle_seconds())})

    def advise(self) -> None:
        if not (OLLAMA_URL and OLLAMA_MODEL):
            self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "OLLAMA_URL and OLLAMA_MODEL are not set in .env"})
            return
        if PUBLIC_DEMO:
            with _lock:
                session = _sessions.get(self.cookie(SESSION_COOKIE) or "", {})
                used = session.get("explains", 0)
                if used >= DEMO_EXPLAINS_PER_SESSION:
                    self.send_json(HTTPStatus.TOO_MANY_REQUESTS,
                                   {"error": f"The demo allows {DEMO_EXPLAINS_PER_SESSION} explanations per visit."})
                    return
        if not _llm_slot.acquire(blocking=PUBLIC_DEMO is False):
            self.send_json(HTTPStatus.TOO_MANY_REQUESTS, {"error": "Another explanation is running. Try again in a moment."})
            return
        try:
            brief = str(self.read_json().get("brief", ""))[:20000]
            text = ask_ollama(brief)
            if PUBLIC_DEMO:
                with _lock:
                    if (session := _sessions.get(self.cookie(SESSION_COOKIE) or "")) is not None:
                        session["explains"] = session.get("explains", 0) + 1
            self.send_json(HTTPStatus.OK, {"text": text, "model": OLLAMA_MODEL})
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json(HTTPStatus.BAD_GATEWAY, {"error": str(exc)})
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            self.send_json(HTTPStatus.BAD_GATEWAY, {"error": f"could not reach Ollama at {OLLAMA_URL}: {exc}"})
        finally:
            _llm_slot.release()

    def do_PUT(self) -> None:
        if not self.same_origin_write():
            self.send_json(HTTPStatus.FORBIDDEN, {"error": "missing X-PFD header"})
            return
        user = self.user()
        if not user:
            self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "sign in first"})
            return
        m = re.fullmatch(r"/api/dashboards/([a-z][a-z0-9_-]{0,23})", self.path)
        if not m or m.group(1) not in dashboard_ids():
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "no such dashboard"})
            return
        try:
            payload = self.read_json()
            if not isinstance(payload, dict) or payload.get("version") != 1:
                raise ValueError("dashboard must be an object with version 1")
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        try:
            if PUBLIC_DEMO:
                meta = write_sandbox(sandbox(self.cookie(SESSION_COOKIE)), m.group(1), payload, user)
            else:
                meta = write_dashboard(m.group(1), payload, user, reset=self.headers.get("X-PFD-Reset") == "1")
        except Conflict as exc:
            self.send_json(HTTPStatus.CONFLICT, {"error": str(exc)})
            return
        self.send_json(HTTPStatus.OK, {"saved": True, "_meta": meta})


# ---- Entry points ------------------------------------------------------------

def cli(args: list[str]) -> None:
    if len(args) != 2 or args[0] not in ("passwd", "removeuser"):
        raise SystemExit(__doc__)
    command, name = args[0], args[1].strip().lower()
    if not NAME_RE.match(name) or name == HOUSEHOLD:
        raise SystemExit("Name must be lowercase letters, digits, - or _, start with a letter, "
                         f"at most 24 characters, and not '{HOUSEHOLD}'.")
    if command == "removeuser":
        print(update_env_users(ENV_FILE, name, None))
    else:
        password = getpass.getpass(f"New password for {name}: ")
        if len(password) < 10:
            raise SystemExit("Use at least 10 characters.")
        if getpass.getpass("Again: ") != password:
            raise SystemExit("Passwords did not match.")
        print(update_env_users(ENV_FILE, name, hash_password(password)))
    print("Restart the dashboard for the change to take effect.")


def main() -> None:
    global USERS, DEMO
    if PUBLIC_DEMO:
        # Real users in .env are ignored: the public demo only ever has demo/demo.
        USERS, DEMO = {DEMO_USER: hash_password(DEMO_USER)}, True
    else:
        USERS, DEMO = load_users(os.environ)
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        migrate_single_state()
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8118"))
    server = ThreadingHTTPServer((host, port), Handler)
    if PUBLIC_DEMO:
        where = "PUBLIC DEMO: demo/demo, per-session sandboxes in memory, nothing written to disk"
    elif DEMO:
        where = f"users: demo mode (demo/demo); add yourself with ./run.sh adduser <name>; data: {DATA_DIR}"
    else:
        where = f"users: {', '.join(USERS)}; data: {DATA_DIR}"
    print(f"Personal Financial Dashboard on http://{host}:{port} ({where})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    if len(sys.argv) > 1:
        cli(sys.argv[1:])
    else:
        main()
