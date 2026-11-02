"""Server tests. Run: python3 -m unittest discover -s tests -p 'test_*.py'"""

import http.client
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402


class Passwords(unittest.TestCase):
    def test_hash_round_trip(self):
        stored = server.hash_password("correct horse")
        self.assertTrue(server.verify_password("correct horse", stored))
        self.assertFalse(server.verify_password("wrong horse", stored))

    def test_hash_is_salted_and_env_safe(self):
        a, b = server.hash_password("same"), server.hash_password("same")
        self.assertNotEqual(a, b)
        self.assertNotRegex(a, r"[$=\s'\"]")

    def test_garbage_never_verifies(self):
        for stored in ("", "scrypt", "md5:abc", "scrypt:1:2:3:!!:!!"):
            self.assertFalse(server.verify_password("x", stored))


class EnvSlots(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.env = Path(self.dir.name) / ".env"
        self.env.write_text("PFD_PORT=8118\nPFD_USER_1=\nPFD_USER_2=\nPFD_USER_3=\nOLLAMA_URL=\n")

    def tearDown(self):
        self.dir.cleanup()

    def users(self):
        env = dict(line.split("=", 1) for line in self.env.read_text().splitlines() if "=" in line)
        return server.parse_users(env)

    def test_three_users_then_refuse_a_fourth(self):
        for name in ("ravi", "sam", "alex"):
            server.update_env_users(self.env, name, server.hash_password("pw-" + name))
        self.assertEqual(list(self.users()), ["ravi", "sam", "alex"])
        with self.assertRaises(SystemExit):
            server.update_env_users(self.env, "dana", server.hash_password("x"))

    def test_passwd_keeps_the_slot_and_other_lines(self):
        server.update_env_users(self.env, "ravi", server.hash_password("old"))
        server.update_env_users(self.env, "sam", server.hash_password("s"))
        server.update_env_users(self.env, "ravi", server.hash_password("new"))
        users = self.users()
        self.assertEqual(list(users), ["ravi", "sam"])
        self.assertTrue(server.verify_password("new", users["ravi"]))
        self.assertIn("PFD_PORT=8118", self.env.read_text())
        self.assertEqual(self.env.stat().st_mode & 0o777, 0o600)

    def test_remove_frees_the_slot(self):
        server.update_env_users(self.env, "ravi", server.hash_password("a"))
        server.update_env_users(self.env, "sam", server.hash_password("b"))
        server.update_env_users(self.env, "ravi", None)
        self.assertEqual(list(self.users()), ["sam"])
        server.update_env_users(self.env, "alex", server.hash_password("c"))
        self.assertIn("PFD_USER_1=alex:", self.env.read_text())

    def test_reserved_and_malformed_names_rejected(self):
        with self.assertRaises(SystemExit):
            server.parse_users({"PFD_USER_1": "household:" + server.hash_password("x")})
        with self.assertRaises(SystemExit):
            server.parse_users({"PFD_USER_1": "ravi:plaintext"})


class DemoMode(unittest.TestCase):
    def test_demo_only_without_real_users(self):
        users, demo = server.load_users({"PFD_USER_1": ""})
        self.assertTrue(demo)
        self.assertTrue(server.verify_password("demo", users["demo"]))
        users, demo = server.load_users({"PFD_USER_1": "ravi:" + server.hash_password("long-password")})
        self.assertFalse(demo)
        self.assertNotIn("demo", users)


class Http(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        server.DATA_DIR = Path(cls.tmp.name)
        server.DASHBOARD_DIR = server.DATA_DIR / "dashboards"
        server.BACKUP_DIR = server.DATA_DIR / "backups"
        server.USERS = {"ravi": server.hash_password("ravi-pass"), "sam": server.hash_password("sam-pass")}
        cls.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.tmp.cleanup()

    def setUp(self):
        server._failures.clear()

    def call(self, method, path, body=None, cookie=None, write_header=True):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        headers = {"Content-Type": "application/json"}
        if write_header:
            headers["X-PFD"] = "1"
        if cookie:
            headers["Cookie"] = f"{server.SESSION_COOKIE}={cookie}"
        conn.request(method, path, json.dumps(body) if body is not None else None, headers)
        res = conn.getresponse()
        raw = res.read()
        data = json.loads(raw) if res.getheader("Content-Type", "").startswith("application/json") and raw else raw
        return res, data

    def login(self, name="ravi", password="ravi-pass"):
        res, _ = self.call("POST", "/api/login", {"name": name, "password": password})
        self.assertEqual(res.status, 200)
        cookie = res.getheader("Set-Cookie")
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Strict", cookie)
        return cookie.split(";", 1)[0].split("=", 1)[1]

    def test_landing_is_public_app_and_data_are_not(self):
        res, body = self.call("GET", "/")
        self.assertEqual(res.status, 200)
        self.assertIn(b"Sign in", body)
        self.assertEqual(self.call("GET", "/app")[0].status, 303)
        self.assertEqual(self.call("GET", "/api/dashboards")[0].status, 401)
        self.assertEqual(self.call("GET", "/api/me")[0].status, 401)

    def test_wrong_password_and_unknown_user_look_the_same(self):
        a = self.call("POST", "/api/login", {"name": "ravi", "password": "nope"})
        b = self.call("POST", "/api/login", {"name": "nobody", "password": "nope"})
        self.assertEqual((a[0].status, a[1]), (b[0].status, b[1]))
        self.assertEqual(a[0].status, 401)

    def test_lockout_after_repeated_failures(self):
        for _ in range(server.LOCK_AFTER_FAILURES):
            self.call("POST", "/api/login", {"name": "ravi", "password": "nope"})
        res, body = self.call("POST", "/api/login", {"name": "ravi", "password": "ravi-pass"})
        self.assertEqual(res.status, 429)

    def test_writes_need_the_header(self):
        res, _ = self.call("POST", "/api/login", {"name": "ravi", "password": "ravi-pass"}, write_header=False)
        self.assertEqual(res.status, 403)

    def test_everyone_sees_every_dashboard_and_household_exists(self):
        token = self.login("sam", "sam-pass")
        res, me = self.call("GET", "/api/me", cookie=token)
        self.assertEqual(me["dashboards"], ["household", "ravi", "sam"])
        self.assertEqual(self.call("GET", "/app", cookie=token)[0].status, 200)

    def test_save_records_who_and_refuses_stale_writes(self):
        ravi, sam = self.login(), self.login("sam", "sam-pass")
        res, saved = self.call("PUT", "/api/dashboards/household", {"version": 1, "x": 1}, cookie=ravi)
        self.assertEqual(res.status, 200)
        self.assertEqual(saved["_meta"]["updatedBy"], "ravi")
        v1 = saved["_meta"]

        # Sam saves on top of version 1.
        res, saved = self.call("PUT", "/api/dashboards/household", {"version": 1, "x": 2, "_meta": v1}, cookie=sam)
        self.assertEqual(res.status, 200)

        # Ravi's tab still holds version 1: refused, not overwritten.
        res, body = self.call("PUT", "/api/dashboards/household", {"version": 1, "x": 3, "_meta": v1}, cookie=ravi)
        self.assertEqual(res.status, 409)
        self.assertIn("sam", body["error"])
        _, all_docs = self.call("GET", "/api/dashboards", cookie=ravi)
        self.assertEqual(all_docs["household"]["x"], 2)

    def test_reset_keeps_a_copy_of_what_it_replaced(self):
        token = self.login()
        _, docs = self.call("GET", "/api/dashboards", cookie=token)
        current_meta = (docs["ravi"] or {}).get("_meta")
        res, saved = self.call("PUT", "/api/dashboards/ravi", {"version": 1, "mine": "real", "_meta": current_meta}, cookie=token)
        self.assertEqual(res.status, 200, saved)
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("PUT", "/api/dashboards/ravi", json.dumps({"version": 1, "_meta": saved["_meta"]}),
                     {"Content-Type": "application/json", "X-PFD": "1", "X-PFD-Reset": "1",
                      "Cookie": f"{server.SESSION_COOKIE}={token}"})
        self.assertEqual(conn.getresponse().status, 200)
        copies = list(server.BACKUP_DIR.glob("ravi-before-reset-*.json"))
        self.assertEqual(len(copies), 1)
        self.assertEqual(json.loads(copies[0].read_text())["mine"], "real")
        _, docs = self.call("GET", "/api/dashboards", cookie=token)
        self.assertNotIn("mine", docs["ravi"])

    def test_files_are_private_on_disk(self):
        token = self.login()
        self.call("PUT", "/api/dashboards/ravi", {"version": 1}, cookie=token)
        for path in [server.dashboard_path("ravi"), *server.BACKUP_DIR.glob("ravi-*.json")]:
            self.assertEqual(path.stat().st_mode & 0o777, 0o600, path)

    def test_unknown_dashboard_and_bad_body(self):
        token = self.login()
        self.assertEqual(self.call("PUT", "/api/dashboards/alex", {"version": 1}, cookie=token)[0].status, 404)
        self.assertEqual(self.call("PUT", "/api/dashboards/ravi", {"version": 2}, cookie=token)[0].status, 400)

    def test_logout_ends_the_session(self):
        token = self.login()
        self.call("POST", "/api/logout", cookie=token)
        self.assertEqual(self.call("GET", "/api/me", cookie=token)[0].status, 401)

    def test_static_cannot_escape(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("GET", "/static/../server.py")
        self.assertEqual(conn.getresponse().status, 404)


if __name__ == "__main__":
    unittest.main()


class PublicDemo(unittest.TestCase):
    """Hosted demo: demo/demo only, one private in-memory sandbox per sign-in, nothing on disk."""

    @classmethod
    def setUpClass(cls):
        cls.saved = {k: getattr(server, k) for k in
                     ("PUBLIC_DEMO", "TRUST_PROXY", "USERS", "DEMO", "DATA_DIR", "DASHBOARD_DIR", "BACKUP_DIR",
                      "OLLAMA_URL", "OLLAMA_MODEL", "ask_ollama")}
        cls.tmp = tempfile.TemporaryDirectory()
        server.DATA_DIR = Path(cls.tmp.name)
        server.DASHBOARD_DIR = server.DATA_DIR / "dashboards"
        server.BACKUP_DIR = server.DATA_DIR / "backups"
        server.PUBLIC_DEMO, server.TRUST_PROXY, server.DEMO = True, True, True
        server.USERS = {"demo": server.hash_password("demo")}
        server.OLLAMA_URL, server.OLLAMA_MODEL = "http://ollama.invalid", "test-model"
        server.ask_ollama = lambda brief: "explained"
        cls.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        for k, v in cls.saved.items():
            setattr(server, k, v)
        server._sessions.clear()
        cls.tmp.cleanup()

    def setUp(self):
        server._failures.clear()

    call = Http.call

    def login(self, ip):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("POST", "/api/login", json.dumps({"name": "demo", "password": "demo"}),
                     {"Content-Type": "application/json", "X-PFD": "1", "CF-Connecting-IP": ip})
        res = conn.getresponse()
        res.read()
        self.assertEqual(res.status, 200)
        cookie = res.getheader("Set-Cookie")
        self.assertIn("Secure", cookie)
        return cookie.split(";", 1)[0].split("=", 1)[1]

    def test_visitors_never_see_each_other(self):
        a, b = self.login("203.0.113.1"), self.login("203.0.113.2")
        res, _ = self.call("PUT", "/api/dashboards/demo", {"version": 1, "secret": "a"}, cookie=a)
        self.assertEqual(res.status, 200)
        _, docs_b = self.call("GET", "/api/dashboards", cookie=b)
        self.assertIsNone(docs_b["demo"])
        _, docs_a = self.call("GET", "/api/dashboards", cookie=a)
        self.assertEqual(docs_a["demo"]["secret"], "a")
        self.assertFalse(server.DASHBOARD_DIR.exists(), "public demo must not write to disk")

    def test_sign_out_discards_the_sandbox(self):
        a = self.login("203.0.113.3")
        self.call("PUT", "/api/dashboards/demo", {"version": 1, "x": 1}, cookie=a)
        self.call("POST", "/api/logout", cookie=a)
        a2 = self.login("203.0.113.3")
        _, docs = self.call("GET", "/api/dashboards", cookie=a2)
        self.assertIsNone(docs["demo"])

    def test_lockout_is_per_visitor_behind_the_proxy(self):
        conn = lambda: http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        for _ in range(server.LOCK_AFTER_FAILURES):
            c = conn()
            c.request("POST", "/api/login", json.dumps({"name": "demo", "password": "x"}),
                      {"Content-Type": "application/json", "X-PFD": "1", "CF-Connecting-IP": "198.51.100.9"})
            c.getresponse().read()
        c = conn()
        c.request("POST", "/api/login", json.dumps({"name": "demo", "password": "demo"}),
                  {"Content-Type": "application/json", "X-PFD": "1", "CF-Connecting-IP": "198.51.100.9"})
        self.assertEqual(c.getresponse().status, 429)
        self.login("198.51.100.10")  # someone else is unaffected

    def test_explanations_are_capped_per_visit(self):
        a = self.login("203.0.113.4")
        for _ in range(server.DEMO_EXPLAINS_PER_SESSION):
            res, body = self.call("POST", "/api/advise", {"brief": "x"}, cookie=a)
            self.assertEqual(res.status, 200, body)
        res, _ = self.call("POST", "/api/advise", {"brief": "x"}, cookie=a)
        self.assertEqual(res.status, 429)

    def test_explanations_one_at_a_time(self):
        a = self.login("203.0.113.5")
        self.assertTrue(server._llm_slot.acquire(blocking=False))
        try:
            res, body = self.call("POST", "/api/advise", {"brief": "x"}, cookie=a)
            self.assertEqual(res.status, 429)
            self.assertIn("Another explanation", body["error"])
        finally:
            server._llm_slot.release()

    def test_sessions_are_bounded(self):
        saved = server.MAX_DEMO_SESSIONS
        server.MAX_DEMO_SESSIONS = 3
        try:
            server._sessions.clear()
            tokens = [server.new_session("demo") for _ in range(5)]
            self.assertEqual(len(server._sessions), 3)
            self.assertNotIn(tokens[0], server._sessions)
        finally:
            server.MAX_DEMO_SESSIONS = saved
