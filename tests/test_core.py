import json
import os
import sqlite3
import tempfile

os.environ.update(DATA_DIR=tempfile.mkdtemp(), SECRET_KEY="t" * 40, AUDIT_SIGNING_KEY="a" * 40, DEMO_MODE="true", WORKFLOWS="true",
                  BOOTSTRAP_ADMINS="demo.admin@example.com", GOOGLE_ALLOWED_DOMAINS="example.com",
                  ENTRA_TENANT_ID="11111111-2222-3333-4444-555555555555")

import pytest  # noqa: E402
import requests  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import auth, config, connectors, db, discovery as d  # noqa: E402
from app.api import _csv_cell  # noqa: E402
from app.main import app  # noqa: E402

G = "https://www.googleapis.com/auth/"


@pytest.fixture
def conn():
    for t in ("hr_record", "access_request", "account", "issue", "subscription", "app_source", "app", "person_email", "person", "integration_state"):
        c = db.connect()
        with c:
            c.execute(f"DELETE FROM {t}")
        c.close()
    c = db.connect()
    yield c
    c.close()


def test_audit_chain_detects_tampering(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "audit.db")
    db.init()
    conn = db.connect()
    with conn:
        for i in range(3):
            db.audit(conn, "tester", "test.event", "x", i, {"n": i})
    assert db.verify_audit(conn) == (True, 3, None)
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        with conn:
            conn.execute("UPDATE audit_event SET actor = 'mallory'")
    # An attacker with file access can drop the trigger, but cannot recompute the HMAC chain without the key.
    with conn:
        conn.execute("DROP TRIGGER audit_no_update")
        conn.execute("UPDATE audit_event SET detail = '{\"n\":99}' WHERE id = 2")
    ok, _, bad = db.verify_audit(conn)
    assert not ok and bad == conn.execute("SELECT event_id FROM audit_event WHERE id = 2").fetchone()[0]
    conn.close()


def test_reconcile_rules_open_resolve_and_reopen(conn):
    ts = db.now()
    with conn:
        leaver = d.upsert_person(conn, ts, "gone@example.com", status="suspended", status_source="google", google_id="g1")
        d.upsert_person(conn, ts, "here@example.com", status="active", status_source="google", google_id="g2")
        risky = d.ensure_app(conn, ts, "google_oauth", "cid-1", "Mail Thing")
        d.upsert_account(conn, ts, risky, "google", "oauth_grant", "cid-1:g1", email="gone@example.com",
                         scopes=json.dumps(["https://mail.google.com/"]))
        tool = d.ensure_app(conn, ts, "manual", "tool", "Tool")
        conn.execute("INSERT INTO subscription (app_id, name, quantity) VALUES (?, 'Pro', 1)", (tool,))
        d.import_csv(conn, "t", tool, "x.csv", b"email,plan\nhere@example.com,Pro\nstranger@other.com,Pro\n")
    kinds = {r["kind"]: r for r in conn.execute("SELECT * FROM issue WHERE status = 'open'")}
    assert {"leaver_access", "risky_scopes", "orphan_account", "over_allocated", "unreviewed_app"} <= kinds.keys()
    assert kinds["leaver_access"]["person_id"] == leaver

    # Re-import without the stranger: orphan + over-allocation resolve automatically, history kept.
    with conn:
        d.import_csv(conn, "t", tool, "x.csv", b"email,plan\nhere@example.com,Pro\n")
    st = dict(conn.execute("SELECT kind, status FROM issue WHERE kind IN ('orphan_account', 'over_allocated')").fetchall())
    assert st == {"orphan_account": "resolved", "over_allocated": "resolved"}
    assert conn.execute("SELECT state FROM account WHERE email = 'stranger@other.com'").fetchone()[0] == "removed"

    # An accepted exception whose expiry passed is reopened.
    with conn:
        conn.execute("UPDATE issue SET status = 'accepted', accepted_until = '2000-01-01' WHERE kind = 'risky_scopes'")
        d.reconcile(conn, db.now())
    assert conn.execute("SELECT status FROM issue WHERE kind = 'risky_scopes'").fetchone()[0] == "open"


def test_risky_scope_classification():
    assert d.risky_scopes([G + "drive.file", G + "drive.readonly", "Mail.Read", "User.Read", "openid"]) == \
        ["Mail.Read", G + "drive.readonly"]


def _fake_google(monkeypatch, users, tokens):
    monkeypatch.setattr(d, "g_users", lambda: iter(users))
    monkeypatch.setattr(d, "g_tokens_all", lambda users: ((u, tokens.get(u["id"], [])) for u in users))
    monkeypatch.setattr(d, "g_activities", lambda app, start: iter([]))
    monkeypatch.setattr(d, "g_latest_activity", lambda pairs, start: ((p, None) for p in pairs))
    monkeypatch.setattr(config, "GOOGLE_CUSTOMER_DOMAIN", "")


def test_google_sync_snapshot_semantics(conn, monkeypatch):
    users = [{"id": "u1", "primaryEmail": "a@example.com", "aliases": ["alias@example.com"], "name": {"fullName": "A"}},
             {"id": "u2", "primaryEmail": "b@example.com", "suspended": True, "name": {"fullName": "B"}}]
    slack = {"clientId": "slack-cid", "displayText": "Slack", "scopes": ["openid"]}
    _fake_google(monkeypatch, users, {"u1": [slack], "u2": [slack]})
    with conn:
        d.sync_google(conn, d.Run(db.now()))
        d.reconcile(conn, db.now())
    assert d.person_by_email(conn, "alias@example.com") == d.person_by_email(conn, "a@example.com")
    assert conn.execute("SELECT COUNT(*) FROM issue WHERE kind = 'leaver_access' AND status = 'open'").fetchone()[0] == 1

    # Token revoked for the leaver upstream -> account marked removed (not deleted), issue resolves.
    _fake_google(monkeypatch, users, {"u1": [slack]})
    with conn:
        d.sync_google(conn, d.Run(db.now()))
        d.reconcile(conn, db.now())
    assert conn.execute("SELECT state FROM account WHERE external_id = 'slack-cid:u2'").fetchone()[0] == "removed"
    assert conn.execute("SELECT COUNT(*) FROM issue WHERE kind = 'leaver_access' AND status = 'open'").fetchone()[0] == 0

    # An empty user list is treated as an error, never as "everyone left".
    _fake_google(monkeypatch, [], {})
    with pytest.raises(RuntimeError, match="empty snapshot"):
        with conn:
            d.sync_google(conn, d.Run(db.now()))
    assert conn.execute("SELECT COUNT(*) FROM person WHERE status = 'deleted'").fetchone()[0] == 0


def test_missing_optional_scope_is_a_warning(conn, monkeypatch):
    _fake_google(monkeypatch, [{"id": "u1", "primaryEmail": "a@example.com"}], {})

    def denied(users):
        raise connectors.NotAuthorized("scope not granted")
        yield
    monkeypatch.setattr(d, "g_tokens_all", denied)
    run = d.Run(db.now())
    with conn:
        d.sync_google(conn, run)
    assert any("OAuth token inventory skipped" in w for w in run.warnings)


def test_oidc_claim_checks(monkeypatch):
    good = {"email": "x@example.com", "email_verified": True, "hd": "example.com"}
    assert auth.verified_email("google", good) == "x@example.com"
    assert auth.verified_email("google", {**good, "email_verified": False}) is None
    assert auth.verified_email("google", {**good, "hd": None}) is None  # personal Gmail account
    assert auth.verified_email("google", {**good, "email": "x@evil.com", "hd": "evil.com"}) is None
    tid = config.ENTRA_TENANT_ID
    assert auth.verified_email("microsoft", {"tid": tid, "preferred_username": "Y@example.com"}) == "y@example.com"
    assert auth.verified_email("microsoft", {"tid": "other", "preferred_username": "y@example.com"}) is None


def test_csv_formula_injection_is_neutralised():
    assert _csv_cell("=HYPERLINK(\"x\")") == "'=HYPERLINK(\"x\")"
    assert _csv_cell("normal") == "normal"


def _client(role=None):
    c = TestClient(app, base_url="http://localhost:8000")
    if role:
        assert c.post("/api/auth/demo", json={"role": role}, headers={"x-requested-with": "fetch"}).status_code == 200
        c.headers["x-csrf-token"] = c.get("/api/session").json()["csrf"]
    return c


def test_http_auth_csrf_and_roles():
    assert TestClient(app, base_url="http://evil.example").get("/api/session").status_code == 400  # DNS rebinding
    anon = _client()
    assert anon.get("/api/applications").status_code == 401
    assert anon.post("/api/auth/demo", json={}).status_code == 403  # no custom header -> cross-site login blocked

    admin = _client("admin")
    r = admin.get("/api/users")
    assert r.status_code == 200 and "script-src 'self'" in r.headers["content-security-policy"]
    no_csrf = admin.post("/api/users", json={"email": "aud@example.com", "role": "auditor"}, headers={"x-csrf-token": "x"})
    assert no_csrf.status_code == 403
    assert admin.post("/api/users", json={"email": "aud@example.com", "role": "auditor"}).status_code == 200
    assert admin.post("/api/users", json={"email": "not-an-email", "role": "auditor"}).status_code == 422

    auditor = _client("auditor")  # A11: read and export, but every change is refused by the backend
    assert auditor.get("/api/audit").status_code == 200
    assert auditor.post("/api/exports", json={"resource": "people"}).status_code == 200
    assert auditor.post("/api/users", json={"email": "x@example.com", "role": "admin"}).status_code == 403
    assert auditor.get("/api/users").status_code == 403


def test_request_states_and_verification(conn):
    """A01/A02: decision, execution, observation and verification stay separate; only a later observation verifies."""
    ts = db.now()
    with conn:
        pid = d.upsert_person(conn, ts, "leaver@example.com", status="suspended", status_source="google", google_id="g9")
        tool = d.ensure_app(conn, ts, "manual", "tool", "Tool")
        d.import_csv(conn, "t", tool, "x.csv", b"email\nleaver@example.com\nother@example.com\n")
    c = _client("admin")
    rid = c.post("/api/requests", json={"person_id": pid, "app_id": tool, "type": "revoke",
                                        "justification": "Leaver"}).json()["id"]
    r = c.get(f"/api/requests/{rid}").json()["request"]
    assert (r["decision"], r["execution"], r["observed"]["state"], r["verification"]) == \
        ("pending", "not_started", "present", "not_applicable")
    assert c.post(f"/api/requests/{rid}/execution", json={"outcome": "completed"}).status_code == 409  # not approved
    assert c.post(f"/api/requests/{rid}/decision", json={"decision": "approved"}).status_code == 200
    assert c.post(f"/api/requests/{rid}/decision", json={"decision": "rejected"}).status_code == 409  # no double decision
    r = c.post(f"/api/requests/{rid}/execution", json={"outcome": "completed"}).json()["request"]
    assert r["verification"] == "awaiting"  # the only observation predates the recorded change
    with conn:  # a new snapshot without the leaver arrives
        d.import_csv(conn, "t", tool, "x.csv", b"email\nother@example.com\n")
    r = c.get(f"/api/requests/{rid}").json()["request"]
    assert r["observed"]["state"] == "absent" and r["verification"] == "matched"


def test_bulk_results_are_per_target(conn):
    ts = db.now()
    with conn:
        a = d.ensure_app(conn, ts, "manual", "a", "A")
        b = d.ensure_app(conn, ts, "manual", "b", "B")
    c = _client("admin")
    c.patch(f"/api/applications/{b}", json={"status": "tolerated"})
    res = c.post("/api/applications/bulk-status", json={"ids": [a, b, 999999], "status": "tolerated"}).json()["results"]
    assert [r["outcome"] for r in res] == ["completed", "unchanged", "failed"]


def test_export_covers_all_matching_records(conn):
    """A10: a filtered export returns every match, not the 25 rows of the loaded page."""
    ts = db.now()
    with conn:
        for i in range(40):
            d.ensure_app(conn, ts, "manual", f"crm{i}", f"CRM {i}")
        d.ensure_app(conn, ts, "manual", "other", "Other")
    c = _client("auditor")
    assert c.get("/api/applications", params={"q": "CRM"}).json()["total"] == 40
    assert len(c.get("/api/applications", params={"q": "CRM"}).json()["data"]) == 25
    r = c.post("/api/exports", json={"resource": "applications", "filters": {"q": "CRM"}, "fields": ["id", "name"]})
    assert r.headers["x-export-count"] == "40" and r.text.count("CRM") == 40
    picked = c.post("/api/exports", json={"resource": "applications", "filters": {"q": "CRM"}, "ids": [1, 2, 3],
                                          "fields": ["name", "nope"]})
    assert picked.text.splitlines()[0] == "name"  # unknown fields are dropped, never interpolated


def test_concurrent_audit_writes_keep_one_chain(monkeypatch, tmp_path):
    import threading
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "race.db")
    db.init()

    def writer():
        c = db.connect()
        for _ in range(20):
            with c:
                db.audit(c, "t", "race")
        c.close()
    threads = [threading.Thread(target=writer) for _ in range(6)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    c = db.connect()
    assert db.verify_audit(c) == (True, 120, None)
    c.close()


def test_usage_needs_history_and_activity_data(conn):
    """Access is not usage. Inactivity is only claimed when the activity log covers the whole window."""
    ts, cutoff = db.now(), d.ago(config.INACTIVITY_DAYS)
    with conn:
        pid = d.upsert_person(conn, ts, "idle@example.com", status="active", status_source="google", google_id="g7")
        mail = d.ensure_app(conn, ts, "google_oauth", "cid-m", "Mail Helper")
        quiet = d.ensure_app(conn, ts, "google_oauth", "cid-q", "Sign-in Only")
        d.upsert_account(conn, ts, mail, "google", "oauth_grant", "cid-m:g7", person_id=pid,
                         scopes=json.dumps(["https://mail.google.com/"]))  # no API calls seen
        d.upsert_account(conn, ts, quiet, "google", "oauth_grant", "cid-q:g7", person_id=pid, scopes=json.dumps(["openid"]))
        d.set_cursor(conn, "google", ts)
        d.set_activity_since(conn, "google", d.ago(30))  # first scan: log reaches back 30 days only
        d.reconcile(conn, ts)
    u = d.app_usage(conn, cutoff)
    assert u[mail]["states"][pid] == "insufficient_history" and u[mail]["coverage"] == "partial"
    assert u[quiet]["states"][pid] == "unknown"  # no source reports activity: never "inactive"
    assert not conn.execute("SELECT 1 FROM issue WHERE kind IN ('dormant_grant', 'unused_app')").fetchone()

    with conn:  # the log now reaches back far enough
        conn.execute("UPDATE integration_state SET activity_since = ? WHERE name = 'google'", (d.ago(200),))
        d.reconcile(conn, db.now())
    assert d.app_usage(conn, cutoff)[mail]["states"][pid] == "inactive"
    kinds = {r[0] for r in conn.execute("SELECT kind FROM issue WHERE status = 'open' AND app_id = ?", (mail,))}
    assert {"dormant_grant", "unused_app"} <= kinds
    assert not conn.execute("SELECT 1 FROM issue WHERE app_id = ? AND kind IN ('dormant_grant', 'unused_app')", (quiet,)).fetchone()

    with conn:  # recent use resolves both
        d.touch_activity(conn, mail, "google", "oauth_grant", "cid-m:g7", d.ago(1))
        d.reconcile(conn, db.now())
    assert not conn.execute("SELECT 1 FROM issue WHERE status = 'open' AND kind IN ('dormant_grant', 'unused_app')").fetchone()


def test_sync_does_not_lock_database_while_fetching(conn, monkeypatch):
    """Regression: a sign-in during a slow scan failed with 'database is locked'. Fetching must hold no write lock."""
    import threading
    import time
    fetching, release = threading.Event(), threading.Event()

    def slow_users():
        fetching.set()
        release.wait(10)
        return iter([{"id": "u1", "primaryEmail": "a@example.com"}])
    _fake_google(monkeypatch, [], {})
    monkeypatch.setattr(d, "g_users", slow_users)
    with conn:  # some earlier data, so the database is not empty
        d.upsert_person(conn, db.now(), "x@example.com", google_id="gx")
    sync = threading.Thread(target=d._run_one, args=("google", d.fetch_google, d.apply_google, "test"))
    sync.start()
    assert fetching.wait(5)
    other = db.connect()
    started = time.monotonic()
    with other:
        db.audit(other, "someone@example.com", "auth.login")  # what the sign-in callback does
    other.close()
    assert time.monotonic() - started < 1
    release.set()
    sync.join(10)
    assert conn.execute("SELECT status FROM sync_run ORDER BY id DESC LIMIT 1").fetchone()[0] == "ok"


def test_google_sync_tolerates_real_world_shapes_and_timeouts(conn, monkeypatch):
    """Regressions from the first real scan: a manager relation without a value, and an audit report that times out."""
    import requests
    users = [{"id": "u1", "primaryEmail": "a@example.com", "relations": [{"type": "manager"}]}]
    _fake_google(monkeypatch, users, {"u1": [{"clientId": "c1", "displayText": "Tool", "scopes": ["openid"]}]})

    def timeout(app, start):
        raise requests.ReadTimeout("read timed out")
        yield
    monkeypatch.setattr(d, "g_activities", timeout)
    run = d.Run(db.now())
    with conn:
        d.sync_google(conn, run)
    assert run.stats["users"] == 1 and run.stats["oauth_grants"] == 1  # everything else was kept
    assert any("could not be read" in w for w in run.warnings)
    assert d.get_cursor(conn, "google") is None  # the next run retries the report from the same point


def test_google_activity_is_looked_up_per_grant(conn, monkeypatch):
    """One newest-event lookup per grant instead of reading the whole log; recently active grants are not re-asked."""
    users = [{"id": "u1", "primaryEmail": "a@example.com"}]
    grants = [{"clientId": "busy", "displayText": "Busy", "scopes": [G + "drive"]},
              {"clientId": "idle", "displayText": "Idle", "scopes": [G + "drive"]}]
    _fake_google(monkeypatch, users, {"u1": grants})
    asked = []

    def lookup(pairs, start):
        for u, t in pairs:
            asked.append(t["clientId"])
            yield (u, t), (d.ago(0) if t["clientId"] == "busy" else None)
    monkeypatch.setattr(d, "g_latest_activity", lookup)
    with conn:
        d.sync_google(conn, d.Run(db.now()))
    assert sorted(asked) == ["busy", "idle"]
    assert conn.execute("SELECT last_activity_at FROM account WHERE external_id = 'busy:u1'").fetchone()[0]
    assert conn.execute("SELECT last_activity_at FROM account WHERE external_id = 'idle:u1'").fetchone()[0] is None
    assert conn.execute("SELECT activity_since FROM integration_state WHERE name = 'google'").fetchone()[0]

    asked.clear()
    with conn:
        d.sync_google(conn, d.Run(db.now()))
    assert asked == ["idle"]  # active within the last day: skipped; dormant: checked again


def test_connectors_fetch_in_parallel_but_write_one_at_a_time(conn, monkeypatch):
    import threading
    import time
    writing, overlaps = threading.Lock(), []

    def fetch(conn, run):
        time.sleep(0.4)
        return {}

    def apply(conn, run, data):
        if not writing.acquire(blocking=False):
            overlaps.append(True)
            return
        time.sleep(0.1)
        writing.release()
    monkeypatch.setattr(d, "INTEGRATIONS", {"a": (lambda: True, fetch, apply), "b": (lambda: True, fetch, apply)})
    started = time.monotonic()
    assert d.run_sync("test")
    assert time.monotonic() - started < 0.75  # sequential fetching would take 0.8 s or more
    assert not overlaps


def test_google_rate_limit_403_is_retried_but_denied_scope_is_not(monkeypatch):
    class R:
        def __init__(self, status, reason=None):
            self.status_code, self.headers = status, {"Retry-After": "0"}
            self._body = {"error": {"errors": [{"reason": reason}]}} if reason else {}

        def json(self):
            return self._body

        def raise_for_status(self):
            pass
    responses = iter([R(403, "userRateLimitExceeded"), R(200)])
    monkeypatch.setattr(connectors.time, "sleep", lambda s: None)
    session = type("S", (), {"get": lambda self, url, params=None, timeout=None: next(responses)})()
    assert connectors.g_get(session, "https://x") == {}  # rate limit: retried, then succeeded
    denied = type("S", (), {"get": lambda self, url, params=None, timeout=None: R(403, "forbidden")})()
    with pytest.raises(connectors.NotAuthorized):
        connectors.g_get(denied, "https://x")


def test_classifier_fills_blanks_and_ignores_platform_clients(conn):
    ts = db.now()
    with conn:
        chrome = d.ensure_app(conn, ts, "google_oauth", "c1", "Google Chrome")
        slack = d.ensure_app(conn, ts, "google_oauth", "c2", "Slack")
        custom = d.ensure_app(conn, ts, "google_oauth", "c3", "project-458107167321")
        ours = d.ensure_app(conn, ts, "google_oauth", "c4", "Example Birthday Bot")
        unknown = d.ensure_app(conn, ts, "google_oauth", "c5", "Something Obscure")
        conn.execute("UPDATE app SET category = 'Chat' WHERE id = ?", (slack,))  # an admin's choice
        d.classify_apps(conn)
    app = {r["id"]: r for r in conn.execute("SELECT * FROM app")}
    assert (app[chrome]["category"], app[chrome]["status"]) == ("Platform client", "ignored")
    assert (app[slack]["category"], app[slack]["website"], app[slack]["status"]) == ("Chat", "https://slack.com", "discovered")
    assert app[custom]["category"] == app[ours]["category"] == "Internal"
    assert (app[unknown]["category"], app[unknown]["website"]) == (None, None)
    with conn:  # an admin un-ignoring a platform client is not undone by the next sync
        conn.execute("UPDATE app SET status = 'tolerated' WHERE id = ?", (chrome,))
        d.classify_apps(conn)
    assert conn.execute("SELECT status FROM app WHERE id = ?", (chrome,)).fetchone()[0] == "tolerated"


def test_icon_is_fetched_once_per_domain(conn, monkeypatch):
    from app import api
    calls = []
    monkeypatch.setattr(api, "_fetch_icon", lambda domain: calls.append(domain) or (b"\x89PNG", "image/png"))
    with conn:
        app_id = d.ensure_app(conn, db.now(), "google_oauth", "c1", "Slack")
        conn.execute("UPDATE app SET website = 'https://slack.com' WHERE id = ?", (app_id,))
    client = _client("auditor")
    for _ in range(2):
        r = client.get(f"/api/applications/{app_id}/icon")
        assert r.status_code == 200 and r.content == b"\x89PNG" and r.headers["content-type"] == "image/png"
    assert calls == ["slack.com"]


def test_applications_filter_by_category(conn):
    ts = db.now()
    with conn:
        slack = d.ensure_app(conn, ts, "google_oauth", "c1", "Slack")
        bare = d.ensure_app(conn, ts, "google_oauth", "c2", "Something Obscure")
        conn.execute("UPDATE app SET category = 'Communication' WHERE id = ?", (slack,))
    c = _client("auditor")
    r = c.get("/api/applications", params={"category": "Communication"}).json()
    assert [a["id"] for a in r["data"]] == [slack] and r["categories"] == ["Communication"]
    assert [a["id"] for a in c.get("/api/applications", params={"category": r["no_category"]}).json()["data"]] == [bare]


def _pe(pid, email, status="active", leave=None, hire="2020-01-01", **extra):
    """A Personio v1 employee as the API returns it: every attribute wrapped in {"label", "value"}."""
    attrs = {"id": {"value": pid}, "email": {"value": email}, "first_name": {"value": "First"},
             "last_name": {"value": f"Last{pid}"}, "status": {"value": status}, "hire_date": {"value": f"{hire}T00:00:00+01:00"},
             "termination_date": {"value": leave and f"{leave}T00:00:00+01:00"},
             "department": {"value": {"type": "Department", "attributes": {"id": 7, "name": "Ops"}}},
             "supervisor": {"value": {"type": "Employee", "attributes": {"id": {"value": 1}, "email": {"value": "boss@example.com"}}}},
             **extra}
    return {"type": "Employee", "attributes": attrs}


def test_personio_hr_rules(conn):
    import datetime as dt
    ts, today = db.now(), dt.date.today()
    day = lambda n: (today + dt.timedelta(days=n)).isoformat()  # noqa: E731
    with conn:
        for i, email in enumerate(["left@example.com", "juergen@example.com", "rehired@example.com", "soon@example.com",
                                   "shared@example.com"]):
            d.upsert_person(conn, ts, email, status="active", status_source="google", google_id=f"g{i}")
    employees = [_pe(1, "left@example.com", "inactive", leave=day(-3)),
                 _pe(2, "jürgen@example.com"),                                   # umlaut in HR, ASCII in Google
                 _pe(3, "rehired@example.com", "inactive", leave="2022-01-31"),  # old record ...
                 _pe(4, "rehired@example.com"),                                  # ... and the current one
                 _pe(5, "soon@example.com", leave=day(5)),
                 _pe(6, "newhire@example.com", "onboarding", hire=day(10))]
    run = d.Run(ts)
    with conn:
        conn.execute("INSERT INTO integration_state (name, last_success_at) VALUES ('personio', ?)", (ts,))
        d.apply_personio(conn, run, {"employees": employees})
        d.reconcile(conn, ts)
    assert run.stats == {"employees": 6, "matched_to_accounts": 5} and not run.warnings
    issues = {r["kind"]: r for r in conn.execute("SELECT * FROM issue WHERE status = 'open'")}
    kinds = [r["kind"] for r in conn.execute("SELECT kind FROM issue WHERE status = 'open' AND kind LIKE '%hr%' ORDER BY kind")]
    assert kinds == ["hr_leaver", "hr_leaving_soon", "hr_unmatched", "no_hr_record"]  # the rehire is not a leaver
    assert "left@example.com is still active" in issues["hr_leaver"]["title"]
    assert issues["hr_unmatched"]["severity"] == "low"           # starts in the future: no account expected yet
    assert "shared@example.com" in issues["no_hr_record"]["title"]
    hr = conn.execute("SELECT * FROM hr_record WHERE personio_id = '1'").fetchone()
    assert (hr["department"], hr["supervisor_email"], hr["leave_date"], hr["hire_date"]) == ("Ops", "boss@example.com", day(-3), "2020-01-01")

    c = _client("auditor")
    left = c.get("/api/people", params={"hr": "inactive", "sort": "hr_status"}).json()["data"]
    assert [(p["email"], p["hr_leave_date"]) for p in left] == [("left@example.com", day(-3))]
    assert [p["email"] for p in c.get("/api/people", params={"hr": "none"}).json()["data"]] == ["shared@example.com"]
    rehired = c.get(f"/api/people/{left[0]['id'] + 2}").json()["hr"]  # latest record first
    assert [h["status"] for h in rehired] == ["active", "inactive"]
    assert "personio" in [i["name"] for i in c.get("/api/integrations").json()["integrations"]]

    with conn:  # Google suspends the leaver: the issue resolves on its own
        conn.execute("UPDATE person SET status = 'suspended' WHERE email = 'left@example.com'")
        d.reconcile(conn, db.now())
    assert conn.execute("SELECT status FROM issue WHERE kind = 'hr_leaver'").fetchone()[0] == "resolved"


def test_personio_without_leaving_dates_warns(conn):
    e = _pe(1, "a@example.com")
    del e["attributes"]["termination_date"]
    run = d.Run(db.now())
    with conn:
        d.apply_personio(conn, run, {"employees": [e]})
    assert run.warnings and "termination_date" in run.warnings[0]


def test_personio_paging_dedupes_overlapping_pages(monkeypatch):
    class S:
        headers = {}
        def post(self, *a, **k):
            return type("R", (), {"status_code": 200, "json": lambda self: {"access_token": "t"}, "raise_for_status": lambda self: None})()
    pages = {0: [_pe(i, f"{i}@x") for i in range(100)], 100: [_pe(i, f"{i}@x") for i in range(50, 150)], 200: []}
    monkeypatch.setattr(connectors.requests, "Session", S)
    monkeypatch.setattr(connectors, "personio_get", lambda s, path, params: {"data": pages[params["offset"]]})
    assert len(connectors.personio_employees()) == 150


class FakeGoogle:
    """Records write calls; answers from a {(method, url suffix): (status, json)} table."""
    def __init__(self, calls, answers):
        self.calls, self.answers = calls, answers

    def request(self, method, url, **kw):
        self.calls.append((method, url.split("/v1/")[-1], kw.get("json")))
        status, body = next((v for (m, suffix), v in self.answers.items() if m == method and url.endswith(suffix)), (200, {}))
        r = requests.Response()
        r.status_code, r._content = status, json.dumps(body).encode()
        return r


def test_offboarding_runs_confirmed_steps_in_order_and_stops_at_failure(conn, monkeypatch):
    from app import offboarding
    ts = db.now()
    leaver = d.upsert_person(conn, ts, "leaver@example.com", google_id="g-leaver", entra_id="e-leaver",
                             manager_email="boss@example.com")
    d.upsert_person(conn, ts, "boss@example.com", google_id="g-boss")
    d.upsert_person(conn, ts, "ext@other.com")
    conn.commit()
    monkeypatch.setattr(config, "google_write", True)
    calls, graph_calls = [], []
    answers = {("GET", "/users/g-leaver"): (200, {"primaryEmail": "leaver@example.com"}),
               ("GET", "/tokens"): (200, {"items": [{"clientId": "c1", "displayText": "Zoom"}]}),
               ("POST", "/forwardingAddresses"): (200, {"verificationStatus": "accepted"}),
               ("GET", "/applications"): (200, {"applications": [{"id": "55656082996", "name": "Drive and Docs"}]}),
               ("POST", "/transfers"): (403, {"error": {"message": "Insufficient permission"}})}
    monkeypatch.setattr(offboarding, "_google", lambda scope, subject=None: FakeGoogle(calls, answers))
    monkeypatch.setattr(offboarding, "_graph", lambda *a, **kw: graph_calls.append(a))
    admin = _client("admin")
    url = f"/api/people/{leaver}/offboard"

    detail = admin.get(f"/api/people/{leaver}").json()["offboarding"]
    assert detail["default_recipient"] == "boss@example.com"
    assert {s["key"]: s["reason"] for s in detail["steps"]}["entra_disable"] == "write access not configured"

    base = {"steps": ["reset_password"], "confirm": "leaver@example.com"}
    assert admin.post(url, json={**base, "confirm": "someone@example.com"}).status_code == 422
    assert "suspended" in admin.post(url, json={**base, "steps": ["suspend", "forward_mail"],
                                                "recipient_email": "boss@example.com"}).json()["detail"]
    assert admin.post(url, json={**base, "steps": ["entra_disable"]}).status_code == 422  # write not configured
    assert admin.post(url, json={**base, "steps": ["forward_mail"], "recipient_email": "ext@other.com"}).status_code == 422
    assert _client("auditor").post(url, json=base).status_code == 403
    assert calls == [] and graph_calls == []  # nothing ran for any refused request

    res = admin.post(url, json={"steps": ["transfer_drive", "revoke_tokens", "reset_password", "forward_mail"],
                                "recipient_email": "boss@example.com", "confirm": "Leaver@example.com"}).json()["results"]
    assert [(r["step"], r["status"]) for r in res] == [
        ("reset_password", "done"), ("revoke_tokens", "done"), ("forward_mail", "done"), ("transfer_drive", "failed")]
    assert "Insufficient permission" in res[-1]["detail"]
    assert ("DELETE", "users/g-leaver/tokens/c1", None) in calls
    password = next(c[2]["password"] for c in calls if c[2] and "password" in c[2])
    events = admin.get(f"/api/people/{leaver}").json()["offboarding"]["history"]
    assert [e["action"] for e in events][::-1] == ["offboarding.started", "offboarding.step_done", "offboarding.step_done",
                                                   "offboarding.step_done", "offboarding.step_failed"]
    assert all(password not in (e["detail"] or "") for e in events)

    answers[("POST", "/forwardingAddresses")] = (409, {})
    answers[("GET", "/forwardingAddresses/boss@example.com")] = (200, {"verificationStatus": "pending"})
    res = admin.post(url, json={"steps": ["forward_mail", "sign_out"], "recipient_email": "boss@example.com",
                                "confirm": "leaver@example.com"}).json()["results"]
    assert [(r["step"], r["status"]) for r in res] == [("sign_out", "done"), ("forward_mail", "failed")]
    assert "confirm the forwarding" in res[1]["detail"]


def test_addons_are_grouped_with_their_provider(conn):
    ts = db.now()
    names = lambda: {r[0] for r in conn.execute("SELECT name FROM app")}  # noqa: E731
    addon = d.ensure_app(conn, ts, "google", "c-gmail", "Claude for Gmail")
    assert "Claude for Gmail" in names()  # no provider yet: stays on its own
    claude = d.ensure_app(conn, ts, "google", "c-claude", "Claude")
    assert d.ensure_app(conn, ts, "google", "c-gmail", "Claude for Gmail") == claude != addon  # folded into Claude
    anthropic = d.ensure_app(conn, ts, "entra", "a-console", "Anthropic")  # catalog.PROVIDER: Claude -> Anthropic
    assert {r[0] for r in conn.execute("SELECT DISTINCT app_id FROM app_source")} == {anthropic}
    assert d.ensure_app(conn, ts, "google", "c-drive", "Claude for Google Drive") == anthropic  # chain resolved at once

    zapier = d.ensure_app(conn, ts, "google", "z", "Zapier")
    conn.execute("UPDATE app SET status = 'sanctioned' WHERE id = ?", (zapier,))
    forms = d.ensure_app(conn, ts, "google", "zf", "Zapier Forms")
    assert forms == zapier  # undecided add-on joins the sanctioned provider
    decided = conn.execute("INSERT INTO app (name, norm_name, status, category, website, first_seen) VALUES"
                           " ('Zapier Teams', 'zapierteams', 'unsanctioned', 'Developer tools', 'https://zapier.com', ?)",
                           (ts,)).lastrowid
    assert d.group_addons(conn) == 0  # an admin decided this add-on differently from its provider: left alone
    assert decided in {r[0] for r in conn.execute("SELECT id FROM app")}

    canva = d.ensure_app(conn, ts, "google", "cv", "Canva")
    assert d.ensure_app(conn, ts, "google", "cl", "Canvas LMS") != canva  # name prefix alone is not enough
    assert d.ensure_app(conn, ts, "google", "gw", "Gmail for Workspace Studio") not in (canva, anthropic)
    assert d.ensure_app(conn, ts, "google", "mt", "Mermaid Toolkit for Google Docs") != anthropic
    assert any(json.loads(e[0])["reason"] == "add-on of provider" for e in conn.execute(
        "SELECT detail FROM audit_event WHERE action = 'app.merged'"))


def test_real_mode_startup_purges_roles_granted_in_demo(monkeypatch):
    admin = _client("admin")
    assert admin.post("/api/users", json={"email": "planted@example.com", "role": "admin"}).status_code == 200
    monkeypatch.setattr(config, "DEMO_MODE", False)
    with TestClient(app, base_url="http://localhost:8000"):  # runs the startup lifespan
        pass
    c = db.connect()
    assert c.execute("SELECT 1 FROM user_role WHERE email = 'planted@example.com'").fetchone() is None
    c.close()


def test_workflows_off_is_report_only(monkeypatch):
    monkeypatch.setattr(config, "WORKFLOWS", False)
    admin = _client("admin")
    assert admin.get("/api/session").json()["workflows"] is False
    assert admin.get("/api/requests").status_code == 404
    assert admin.post("/api/requests", json={}).status_code == 404
    assert admin.post("/api/people/1/offboard", json={}).status_code == 404
    assert "requests" not in admin.get("/api/exports/fields").json()
    assert admin.post("/api/exports", json={"resource": "requests"}).status_code == 404


def test_security_actions_need_officer_stepup_and_second_approver(conn, monkeypatch):
    from app import actions
    monkeypatch.setattr(config, "ACTIONS", True)
    monkeypatch.setattr(config, "SECURITY_OFFICERS", ["demo.admin@example.com", "demo.auditor@example.com"])
    with conn:
        pid = d.upsert_person(conn, db.now(), "target@example.com", status="active", status_source="google", google_id="g7")
    ran = []
    monkeypatch.setattr(actions, "execute", lambda kind, person, target: ran.append((kind, person["google_id"], target)))

    def stepup(email):
        c = db.connect()
        with c:
            c.execute("UPDATE session SET stepup_at = ? WHERE email = ?", (db.now(), email))
        c.close()

    a = _client("admin")
    url = f"/api/people/{pid}/security-actions"
    body = {"kind": "revoke_all_sign_out", "reason": "phished", "confirm": "target@example.com"}
    assert a.post(url, json=body).json()["detail"] == "stepup_required"
    stepup("demo.admin@example.com")
    assert a.post(url, json={**body, "confirm": "someone@example.com"}).status_code == 422
    assert a.post(url, json={**body, "kind": "revoke_grant", "target": "not-observed"}).status_code == 422
    aid = a.post(url, json=body).json()["id"]
    assert a.post(f"/api/security-actions/{aid}/approve").status_code == 403  # requester cannot approve
    assert ran == []

    b = _client("auditor")
    with conn:  # second officer: must also be an admin
        conn.execute("UPDATE user_role SET role = 'admin' WHERE email = 'demo.auditor@example.com'")
    stepup("demo.auditor@example.com")
    assert b.post(f"/api/security-actions/{aid}/approve").json()["status"] == "done"
    assert ran == [("revoke_all_sign_out", "g7", None)]
    assert b.post(f"/api/security-actions/{aid}/approve").status_code == 409  # runs once
    assert {r[0] for r in conn.execute("SELECT action FROM audit_event WHERE action LIKE 'security_action.%'")} \
        >= {"security_action.requested", "security_action.approved", "security_action.done"}

    monkeypatch.setattr(config, "SECURITY_OFFICERS", ["demo.auditor@example.com", "x@example.com"])
    assert a.post(url, json=body).status_code == 403  # admin alone is not enough
    monkeypatch.setattr(config, "ACTIONS", False)
    assert b.post(url, json=body).status_code == 404
    with conn:
        conn.execute("UPDATE user_role SET role = 'auditor' WHERE email = 'demo.auditor@example.com'")
