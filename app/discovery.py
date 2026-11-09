"""Ingestion, correlation and reconciliation. Every sync step writes inside one transaction, so a failed
fetch never half-applies a snapshot, and nothing is ever deleted: unseen records move to state 'removed'."""
import csv
import datetime as dt
import hashlib
import io
import json
import logging
import re
import threading
import unicodedata
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse

import httpx2
import requests

from . import catalog, config, db
from .connectors import (MICROSOFT_TENANTS, Graph, NotAuthorized, g_activities, g_latest_activity, g_licenses, g_params,
                         g_tokens_all, g_users, personio_employees)

log = logging.getLogger("discovery")

# Account kinds that mean "currently has access" (sso_login / sign_in are activity evidence only).
ACCESS_KINDS = ("directory", "license", "oauth_grant", "sso_assignment", "imported")

RISKY_GOOGLE_PREFIXES = (
    "https://mail.google.com/", "https://www.googleapis.com/auth/gmail.", "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/admin.", "https://www.googleapis.com/auth/cloud-platform",
)
LOW_RISK_GOOGLE = {"drive.file", "drive.appdata", "drive.install", "gmail.labels"}
RISKY_MICROSOFT = {
    "Mail.Read", "Mail.ReadWrite", "Mail.Send", "Mail.Read.Shared", "Mail.ReadWrite.Shared", "MailboxSettings.ReadWrite",
    "Files.Read.All", "Files.ReadWrite.All", "Sites.Read.All", "Sites.ReadWrite.All", "Sites.FullControl.All",
    "Directory.Read.All", "Directory.ReadWrite.All", "Directory.AccessAsUser.All", "User.ReadWrite.All",
    "Group.ReadWrite.All", "Notes.ReadWrite.All", "full_access_as_user", "EWS.AccessAsUser.All",
}
DISABLED_WORDS = {"disabled", "inactive", "suspended", "deactivated", "blocked"}


def risky_scopes(scopes):
    return sorted(s for s in scopes if s in RISKY_MICROSOFT or (
        s.startswith(RISKY_GOOGLE_PREFIXES) and s.rsplit("/", 1)[-1] not in LOW_RISK_GOOGLE))


def norm(name):
    return re.sub(r"[^a-z0-9]", "", (name or "").lower()) or "unknown"


def iso(value):
    """Normalise any ISO-8601 string/datetime to UTC 'YYYY-MM-DDTHH:MM:SS.mmmZ' so string comparison is chronological."""
    if not value:
        return None
    if isinstance(value, str):
        try:
            value = dt.datetime.fromisoformat(value.strip())
        except ValueError:
            return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=dt.UTC)
    return value.astimezone(dt.UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def ago(days):
    return iso(dt.datetime.now(dt.UTC) - dt.timedelta(days=days))


class Run:
    def __init__(self, ts):
        self.ts, self.stats, self.warnings = ts, Counter(), []
        self.run_id = None  # set by _run_one; progress is only recorded for real sync runs

    def progress(self, stage):
        """Record the current step and counts on the sync_run row (own short transaction), visible in the UI."""
        if self.run_id is None:
            return
        c = db.connect()
        with c:
            c.execute("UPDATE sync_run SET stats = ? WHERE id = ?", (json.dumps({"stage": stage, **self.stats}), self.run_id))
        c.close()

    def warn(self, msg):
        log.warning(msg)
        self.warnings.append(msg)


# ---------------------------------------------------------------- upserts

def person_by_email(conn, email):
    row = conn.execute("SELECT person_id FROM person_email WHERE email = ?", ((email or "").lower(),)).fetchone()
    return row[0] if row else None


def upsert_person(conn, ts, email, *, aliases=(), name=None, department=None, title=None, manager_email=None,
                  kind=None, status=None, status_source=None, google_id=None, entra_id=None):
    email = email.strip().lower()
    emails = {email, *(a.strip().lower() for a in aliases if a)}
    row = None
    if google_id:
        row = conn.execute("SELECT id, google_id FROM person WHERE google_id = ?", (google_id,)).fetchone()
    if not row and entra_id:
        row = conn.execute("SELECT id, google_id FROM person WHERE entra_id = ?", (entra_id,)).fetchone()
    if not row:
        pid = next((p for p in (person_by_email(conn, e) for e in emails) if p), None)
        row = conn.execute("SELECT id, google_id FROM person WHERE id = ?", (pid,)).fetchone() if pid else None
    if row:
        pid = row["id"]
        conn.execute(
            "UPDATE person SET name = COALESCE(?, name), department = COALESCE(?, department), title = COALESCE(?, title),"
            " manager_email = COALESCE(?, manager_email), kind = COALESCE(?, kind), last_seen = ?,"
            " google_id = COALESCE(google_id, ?), entra_id = COALESCE(entra_id, ?) WHERE id = ?",
            (name, department, title, manager_email, kind, ts, google_id, entra_id, pid))
        if google_id:  # Google is authoritative for the primary address
            conn.execute("UPDATE OR IGNORE person SET email = ? WHERE id = ?", (email, pid))
        # Source precedence: Google owns employment status; Entra only decides for Entra-only people.
        if status and (status_source == "google" or not row["google_id"]):
            conn.execute("UPDATE person SET status = ?, status_source = ? WHERE id = ?", (status, status_source, pid))
    else:
        pid = conn.execute(
            "INSERT INTO person (email, name, department, title, manager_email, kind, status, status_source,"
            " google_id, entra_id, first_seen, last_seen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (email, name, department, title, manager_email, kind or "employee", status or "active", status_source,
             google_id, entra_id, ts, ts)).lastrowid
    for e in emails:
        conn.execute("INSERT OR IGNORE INTO person_email (email, person_id) VALUES (?, ?)", (e, pid))
    return pid


def ensure_app(conn, ts, source, external_id, name, status="discovered", category=None):
    row = conn.execute("SELECT app_id FROM app_source WHERE source = ? AND external_id = ?", (source, external_id)).fetchone()
    if row:
        conn.execute("UPDATE app_source SET last_seen = ?, label = ? WHERE source = ? AND external_id = ?",
                     (ts, name, source, external_id))
        return row[0]
    row = conn.execute("SELECT id FROM app WHERE norm_name = ? ORDER BY id LIMIT 1", (norm(name),)).fetchone()
    if row:
        app_id = row[0]
    else:
        app_id = conn.execute("INSERT INTO app (name, norm_name, status, category, first_seen) VALUES (?,?,?,?,?)",
                              (name, norm(name), status, category, ts)).lastrowid
        db.audit(conn, "system", "app.discovered", "app", app_id, {"name": name, "source": source})
        classify_apps(conn, app_id=app_id)
    conn.execute("INSERT INTO app_source (source, external_id, app_id, label, first_seen, last_seen) VALUES (?,?,?,?,?,?)",
                 (source, external_id, app_id, name, ts, ts))
    if not row and group_addons(conn, app_id=app_id):  # the new app was an add-on, or the provider of existing ones
        app_id = conn.execute("SELECT app_id FROM app_source WHERE source = ? AND external_id = ?",
                              (source, external_id)).fetchone()[0]
    return app_id


def ensure_subscription(conn, ts, app_id, source, external_id, name, quantity=None, consumed=None):
    return conn.execute(
        "INSERT INTO subscription (app_id, name, source, external_id, quantity, observed_consumed, last_seen)"
        " VALUES (?,?,?,?,?,?,?) ON CONFLICT (source, external_id) DO UPDATE SET name = excluded.name,"
        " quantity = COALESCE(excluded.quantity, quantity), observed_consumed = excluded.observed_consumed,"
        " last_seen = excluded.last_seen RETURNING id",
        (app_id, name, source, external_id, quantity, consumed, ts)).fetchone()[0]


def upsert_account(conn, ts, app_id, source, kind, external_id, *, person_id=None, email=None, display_name=None,
                   role=None, scopes=None, subscription_id=None, state="active", last_activity_at=None):
    email = (email or "").strip().lower() or None
    if person_id is None and email:
        person_id = person_by_email(conn, email)
    conn.execute(
        "INSERT INTO account (app_id, person_id, source, kind, external_id, email, display_name, role, scopes,"
        " subscription_id, state, first_seen, last_seen, last_activity_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
        " ON CONFLICT (app_id, source, kind, external_id) DO UPDATE SET"
        " person_id = COALESCE(excluded.person_id, person_id), email = COALESCE(excluded.email, email),"
        " display_name = COALESCE(excluded.display_name, display_name), role = excluded.role,"
        " scopes = COALESCE(excluded.scopes, scopes), subscription_id = COALESCE(excluded.subscription_id, subscription_id),"
        " state = excluded.state, last_seen = excluded.last_seen, removed_at = NULL,"
        " last_activity_at = NULLIF(MAX(COALESCE(last_activity_at, ''), COALESCE(excluded.last_activity_at, '')), '')",
        (app_id, person_id, source, kind, external_id, email, display_name, role, scopes, subscription_id, state,
         ts, ts, iso(last_activity_at)))


def touch_activity(conn, app_id, source, kind, external_id, when):
    conn.execute(
        "UPDATE account SET last_activity_at = MAX(COALESCE(last_activity_at, ''), ?)"
        " WHERE app_id = ? AND source = ? AND kind = ? AND external_id = ?",
        (iso(when), app_id, source, kind, external_id))


def mark_removed(conn, ts, source, kind):
    """Snapshot semantics: anything from this source+kind not seen in this run no longer exists upstream."""
    conn.execute("UPDATE account SET state = 'removed', removed_at = ? WHERE source = ? AND kind = ?"
                 " AND last_seen < ? AND state != 'removed'", (ts, source, kind, ts))


def set_cursor(conn, name, cursor):
    conn.execute("INSERT INTO integration_state (name, cursor) VALUES (?, ?)"
                 " ON CONFLICT (name) DO UPDATE SET cursor = excluded.cursor", (name, cursor))


def set_activity_since(conn, name, start):
    conn.execute("UPDATE integration_state SET activity_since = COALESCE(activity_since, ?) WHERE name = ?", (start, name))


def get_cursor(conn, name):
    row = conn.execute("SELECT cursor FROM integration_state WHERE name = ?", (name,)).fetchone()
    return row[0] if row and row[0] else None


# ---------------------------------------------------------------- Google Workspace

# Each connector has two halves. fetch_* only talks to the API (no writes, so no database lock is held while
# Google or Microsoft respond, which can take minutes). apply_* then writes everything in one short transaction,
# so a failed fetch still never half-applies a snapshot.

def _latest(a, b):
    return max(a or "", b or "") or None


# Optional, incremental logs: if one cannot be read after retries, the run keeps everything else, warns, and the
# next run starts from the same point (the cursor only advances when the log was read completely).
TRANSIENT = (requests.RequestException, httpx2.TransportError)


def fetch_google(conn, run):
    run.progress("reading users")
    users = list(g_users())
    if not users:
        raise RuntimeError("Google returned no users; refusing to apply an empty snapshot")
    data = {"users": users, "grants": None, "start": None, "token_window": None, "token": {}, "saml": {}, "licences": None}

    try:  # current third-party OAuth grants per user: the main shadow-IT signal
        grants = []
        for n, (u, tokens) in enumerate(g_tokens_all(users), 1):
            grants += [(u, t) for t in tokens]
            if n % 50 == 0:
                run.progress(f"reading OAuth grants ({n} of {len(users)} users)")
        data["grants"] = grants
    except NotAuthorized as e:
        run.warn(f"OAuth token inventory skipped: {e}")

    # OAuth activity: Google logs every API call (about 190,000 events a day for 600 people), so reading the whole log
    # is far too slow. Instead, ask once per grant for its newest "activity" event in the window (filtered by user and
    # client id, one result). Grants seen active within the last day are not re-checked.
    window = ago(min(180, max(config.LOOKBACK_DAYS, config.INACTIVITY_DAYS)))
    if data["grants"] is not None:
        known = dict(conn.execute("SELECT external_id, last_activity_at FROM account"
                                  " WHERE source = 'google' AND kind = 'oauth_grant'").fetchall())
        fresh = ago(1)
        # Suspended and archived accounts cannot use anything (leaver checks cover them), so they are not looked up.
        todo = [(u, t) for u, t in data["grants"] if not (u.get("suspended") or u.get("archived"))
                and (known.get(f"{t['clientId']}:{u['id']}") or "") < fresh]
        try:
            for n, ((u, t), last) in enumerate(g_latest_activity(todo, window), 1):
                data["token"][(t["clientId"], u["id"])] = {"name": t.get("displayText"), "activity": last}
                if n % 200 == 0:
                    run.progress(f"checking OAuth activity ({n} of {len(todo)} grants)")
            run.stats["activity_lookups"] = len(todo)
            data["token_window"] = window
        except NotAuthorized as e:
            run.warn(f"OAuth activity skipped: {e}")
        except TRANSIENT as e:
            run.warn(f"OAuth activity could not be read ({type(e).__name__}: {e}); checked again next sync")
    else:
        run.warn("OAuth activity skipped: it needs the OAuth token inventory")

    # SAML sign-ins (incremental), condensed to the latest login per app and person while reading.
    start = get_cursor(conn, "google") or window
    try:
        run.progress("reading SAML sign-in report")
        for item in g_activities("saml", start):
            gid, email, when = item["actor"].get("profileId"), item["actor"].get("email"), item["id"]["time"]
            for ev in item.get("events", []):
                name = g_params(ev).get("application_name")
                if ev.get("name") != "login_success" or not name:
                    continue
                e = data["saml"].setdefault((name, gid), {"email": email, "last": None})
                e["last"] = _latest(e["last"], when)
                run.stats["saml_logins"] += 1
        data["start"] = start
    except NotAuthorized as e:
        run.warn(f"SAML sign-in report skipped: {e}")
    except TRANSIENT as e:
        run.warn(f"SAML sign-in report could not be read ({type(e).__name__}: {e}); retried next sync from the same point")

    if not config.GOOGLE_CUSTOMER_DOMAIN:
        run.warn("Licence assignments skipped: GOOGLE_CUSTOMER_DOMAIN not set")
    else:
        try:
            run.progress("reading licence assignments")
            data["licences"] = list(g_licenses())
        except NotAuthorized as e:
            run.warn(f"Licence assignments skipped: {e}")
    return data


def apply_google(conn, run, data):
    ts, users = run.ts, data["users"]
    gw = ensure_app(conn, ts, "builtin", "google_workspace", "Google Workspace", status="sanctioned", category="Productivity")
    person_of = {}
    for u in users:
        orgs = u.get("organizations") or [{}]
        org = next((o for o in orgs if o.get("primary")), orgs[0])
        inactive = bool(u.get("suspended") or u.get("archived"))
        pid = upsert_person(
            conn, ts, u["primaryEmail"],
            aliases=[e.get("address") for e in u.get("emails", [])] + u.get("aliases", []) + u.get("nonEditableAliases", []),
            name=(u.get("name") or {}).get("fullName"), department=org.get("department"), title=org.get("title"),
            manager_email=next((r.get("value") for r in u.get("relations", []) if r.get("type") == "manager"), None),
            status="suspended" if inactive else "active", status_source="google", google_id=u["id"], kind="employee")
        person_of[u["id"]] = pid
        last_login = u.get("lastLoginTime")
        upsert_account(conn, ts, gw, "google", "directory", u["id"], person_id=pid, email=u["primaryEmail"],
                       display_name=(u.get("name") or {}).get("fullName"),
                       role="Super Admin" if u.get("isAdmin") else "Delegated Admin" if u.get("isDelegatedAdmin") else "User",
                       state="disabled" if inactive else "active",
                       last_activity_at=None if not last_login or last_login.startswith("1970") else last_login)
    conn.execute("UPDATE person SET status = 'deleted', status_source = 'google' WHERE google_id IS NOT NULL"
                 " AND last_seen < ? AND status != 'deleted'", (ts,))
    mark_removed(conn, ts, "google", "directory")
    run.stats["users"] = len(users)

    tokens_ok = data["grants"] is not None
    if tokens_ok:
        for u, t in data["grants"]:
            app = ensure_app(conn, ts, "google_oauth", t["clientId"], t.get("displayText") or t["clientId"])
            upsert_account(conn, ts, app, "google", "oauth_grant", f"{t['clientId']}:{u['id']}",
                           person_id=person_of[u["id"]], email=u["primaryEmail"],
                           scopes=json.dumps(sorted(t.get("scopes", []))), role="native app" if t.get("nativeApp") else None)
        mark_removed(conn, ts, "google", "oauth_grant")
        run.stats["oauth_grants"] = len(data["grants"])

    for (client_id, gid), e in data["token"].items():  # activity of current grants (tokens.list is the source of truth)
        if e["activity"]:
            app = ensure_app(conn, ts, "google_oauth", client_id, e["name"] or client_id)
            touch_activity(conn, app, "google", "oauth_grant", f"{client_id}:{gid}", e["activity"])
    if data["start"]:
        for (name, gid), e in data["saml"].items():
            app = ensure_app(conn, ts, "google_saml", name, name)
            upsert_account(conn, ts, app, "google", "sso_login", f"{name}:{gid}", person_id=person_of.get(gid),
                           email=e["email"], last_activity_at=e["last"])
        set_cursor(conn, "google", max(data["start"], ago(3)))  # 3-day overlap: reports arrive late; upserts are idempotent
    if data["start"] and data["token_window"]:  # both activity sources read: history now reaches back to the window
        set_activity_since(conn, "google", min(data["start"], data["token_window"]))

    if data["licences"] is not None:
        for a in data["licences"]:
            sub = ensure_subscription(conn, ts, gw, "google_license", a["skuId"], a.get("skuName") or a["skuId"])
            upsert_account(conn, ts, gw, "google", "license", f"{a['skuId']}:{a['userId'].lower()}", email=a["userId"],
                           role=a.get("skuName"), subscription_id=sub)
        mark_removed(conn, ts, "google", "license")
        run.stats["licence_assignments"] = len(data["licences"])


def sync_google(conn, run):
    apply_google(conn, run, fetch_google(conn, run))


# ---------------------------------------------------------------- Microsoft Entra ID

def _third_party(sp):
    return sp.get("appOwnerOrganizationId") not in MICROSOFT_TENANTS


def fetch_entra(conn, run):
    run.progress("reading users")
    gr = Graph()
    sel = "id,displayName,mail,userPrincipalName,accountEnabled,department,jobTitle,userType,otherMails,proxyAddresses,assignedLicenses"
    try:
        users = list(gr.pages(f"/users?$select={sel},signInActivity&$top=999"))
    except NotAuthorized as e:
        run.warn(f"Last sign-in per user unavailable (needs AuditLog.Read.All + Entra ID P1): {e}")
        users = list(gr.pages(f"/users?$select={sel}&$top=999"))
    if not users:
        raise RuntimeError("Entra returned no users; refusing to apply an empty snapshot")
    data = {"users": users, "skus": {}, "sps": None, "grants": None, "enterprise": [], "assigned": None,
            "start": None, "signins": {}}
    try:
        run.progress("reading licence SKUs")
        data["skus"] = {s["skuId"]: s for s in gr.pages("/subscribedSkus")}
    except NotAuthorized as e:
        run.warn(f"Licence SKUs skipped: {e}")

    try:
        run.progress("reading enterprise apps")
        sps = data["sps"] = {sp["id"]: sp for sp in gr.pages(
            "/servicePrincipals?$select=id,appId,displayName,appOwnerOrganizationId,tags&$top=999")}
    except NotAuthorized as e:
        run.warn(f"Enterprise apps, consents and assignments skipped: {e}")
        return data

    try:  # delegated OAuth consents (user or admin consent on behalf of all users)
        run.progress("reading OAuth consents")
        data["grants"] = list(gr.pages("/oauth2PermissionGrants"))
    except NotAuthorized as e:
        run.warn(f"OAuth consents skipped: {e}")

    # Enterprise (SSO) app assignments, expanding groups.
    data["enterprise"] = [sp for sp in sps.values()
                          if "WindowsAzureActiveDirectoryIntegratedApp" in (sp.get("tags") or []) and _third_party(sp)]
    try:
        run.progress("reading SSO assignments")
        by_path = {f"/servicePrincipals/{sp['id']}/appRoleAssignedTo": sp for sp in data["enterprise"]}
        assignments = [(by_path[p], a) for p, items in gr.all_pages(list(by_path)) for a in items]
        groups = sorted({a["principalId"] for _, a in assignments if a.get("principalType") == "Group"})
        members = {p.split("/")[2]: [m["id"] for m in items] for p, items in gr.all_pages(
            [f"/groups/{g}/transitiveMembers/microsoft.graph.user?$select=id" for g in groups])}
        assigned = []
        for sp, a in assignments:
            if a.get("principalType") == "User":
                assigned.append((sp, a["principalId"], "direct"))
            elif a.get("principalType") == "Group":
                assigned += [(sp, uid, f"via group {a.get('principalDisplayName')}") for uid in members[a["principalId"]]]
        data["assigned"] = assigned
    except NotAuthorized as e:
        run.warn(f"SSO app assignments skipped: {e}")

    # Sign-in logs (incremental; requires Entra ID P1/P2), condensed to the latest sign-in per app and user.
    start = get_cursor(conn, "entra") or ago(config.LOOKBACK_DAYS)
    by_app_id = {sp["appId"]: sp for sp in sps.values()}
    try:
        run.progress("reading sign-in logs")
        # Only the fields used (about a fifth of the payload). Sequential on purpose: Microsoft throttles this report
        # to a few requests per 10 seconds per tenant, so parallel requests would only be slowed down.
        fields = "createdDateTime,appId,appDisplayName,userId,userPrincipalName,status"
        for s in gr.pages(f"/auditLogs/signIns?$filter=createdDateTime ge {start[:19]}Z&$top=1000&$select={fields}"):
            sp = by_app_id.get(s.get("appId"))
            if (s.get("status") or {}).get("errorCode") != 0 or (sp and not _third_party(sp)):
                continue
            e = data["signins"].setdefault((s["appId"], s.get("userId")),
                                           {"name": s.get("appDisplayName"), "upn": s.get("userPrincipalName"), "last": None})
            e["last"] = _latest(e["last"], s.get("createdDateTime"))
            run.stats["sign_ins"] += 1
            if run.stats["sign_ins"] % 5000 == 0:
                run.progress("reading sign-in logs")
        data["start"] = start
    except NotAuthorized as e:
        run.warn(f"Sign-in logs skipped (needs AuditLog.Read.All + Entra ID P1): {e}")
    except TRANSIENT as e:
        run.warn(f"Sign-in logs could not be read ({type(e).__name__}: {e}); retried next sync from the same point")
    return data


def apply_entra(conn, run, data):
    ts, users, skus = run.ts, data["users"], data["skus"]
    m365 = ensure_app(conn, ts, "builtin", "microsoft_365", "Microsoft 365 / Entra ID", status="sanctioned", category="Productivity")
    sub_of = {sku_id: ensure_subscription(conn, ts, m365, "entra_sku", sku_id, s["skuPartNumber"],
                                          quantity=(s.get("prepaidUnits") or {}).get("enabled"), consumed=s.get("consumedUnits"))
              for sku_id, s in skus.items()}

    person_of = {}
    for u in users:
        email = u.get("mail") or u["userPrincipalName"]
        enabled = u.get("accountEnabled", True)
        aliases = [u["userPrincipalName"], *(u.get("otherMails") or [])] + [
            p.split(":", 1)[1] for p in (u.get("proxyAddresses") or []) if p.lower().startswith("smtp:")]
        pid = upsert_person(conn, ts, email, aliases=aliases, name=u.get("displayName"), department=u.get("department"),
                            title=u.get("jobTitle"), kind="guest" if u.get("userType") == "Guest" else "employee",
                            status="active" if enabled else "suspended", status_source="entra", entra_id=u["id"])
        person_of[u["id"]] = (pid, email)
        act = u.get("signInActivity") or {}
        upsert_account(conn, ts, m365, "entra", "directory", u["id"], person_id=pid, email=email,
                       display_name=u.get("displayName"), role=u.get("userType"),
                       state="active" if enabled else "disabled",
                       last_activity_at=act.get("lastSuccessfulSignInDateTime") or act.get("lastSignInDateTime"))
        for lic in u.get("assignedLicenses") or []:
            sku = lic["skuId"]
            sub = sub_of.get(sku) or ensure_subscription(conn, ts, m365, "entra_sku", sku, sku)
            upsert_account(conn, ts, m365, "entra", "license", f"{sku}:{u['id']}", person_id=pid, email=email,
                           role=(skus.get(sku) or {}).get("skuPartNumber"), subscription_id=sub)
    conn.execute("UPDATE person SET status = 'deleted', status_source = 'entra' WHERE entra_id IS NOT NULL"
                 " AND google_id IS NULL AND last_seen < ? AND status != 'deleted'", (ts,))
    mark_removed(conn, ts, "entra", "directory")
    mark_removed(conn, ts, "entra", "license")
    run.stats["users"] = len(users)

    sps = data["sps"]
    if sps is None:
        return

    def app_of(sp):
        return ensure_app(conn, ts, "entra_sp", sp["appId"], sp["displayName"])

    if data["grants"] is not None:
        merged = {}
        for g in data["grants"]:
            sp = sps.get(g["clientId"])
            if sp and _third_party(sp):
                principal = g.get("principalId") if g.get("consentType") == "Principal" else "all"
                merged.setdefault((sp["id"], principal), set()).update((g.get("scope") or "").split())
        for (sp_id, principal), scopes in merged.items():
            sp = sps[sp_id]
            pid, email = person_of.get(principal, (None, None))
            upsert_account(conn, ts, app_of(sp), "entra", "oauth_grant", f"{sp['appId']}:{principal}", person_id=pid,
                           email=email, display_name="All users (admin consent)" if principal == "all" else None,
                           scopes=json.dumps(sorted(scopes)))
        mark_removed(conn, ts, "entra", "oauth_grant")
        run.stats["oauth_grants"] = len(merged)

    if data["assigned"] is not None:
        for sp in data["enterprise"]:
            app_of(sp)
        for sp, uid, how in data["assigned"]:
            pid, email = person_of.get(uid, (None, None))
            upsert_account(conn, ts, app_of(sp), "entra", "sso_assignment", f"{sp['appId']}:{uid}", person_id=pid,
                           email=email, role=how)
        mark_removed(conn, ts, "entra", "sso_assignment")
        run.stats["sso_assignments"] = len(data["assigned"])

    if data["start"]:
        for (app_id, user_id), e in data["signins"].items():
            app = ensure_app(conn, ts, "entra_sp", app_id, e["name"] or app_id)
            pid, email = person_of.get(user_id, (None, e["upn"]))
            upsert_account(conn, ts, app, "entra", "sign_in", f"{app_id}:{user_id}", person_id=pid, email=email,
                           last_activity_at=e["last"])
        set_cursor(conn, "entra", max(data["start"], ago(1)))
        set_activity_since(conn, "entra", data["start"])  # Entra keeps sign-in logs for 30 days, so history grows


def sync_entra(conn, run):
    apply_entra(conn, run, fetch_entra(conn, run))


# ---------------------------------------------------------------- CSV import (any app's user export)

UMLAUTS = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss", "Ä": "Ae", "Ö": "Oe", "Ü": "Ue"})


def ascii_email(email):
    """Personio may hold 'jürgen@…' where the Google account is 'juergen@…' (Google rejects non-ASCII addresses)."""
    return unicodedata.normalize("NFKD", email.translate(UMLAUTS)).encode("ascii", "ignore").decode()


def _pv(attrs, name):
    """Value of a Personio v1 attribute ({"value": ...}); for linked records (department, supervisor) the record."""
    v = (attrs.get(name) or {}).get("value")
    return v.get("attributes") if isinstance(v, dict) and "attributes" in v else v


def fetch_personio(conn, run):
    run.progress("reading employees")
    return {"employees": personio_employees()}


def apply_personio(conn, run, data):
    ts, seen, dated = run.ts, set(), False
    for e in data["employees"]:
        a = e["attributes"]
        pid_hr = str(_pv(a, "id"))
        email = (_pv(a, "email") or "").strip().lower() or None
        leave = _pv(a, "last_working_day") or _pv(a, "last_day_of_work") or _pv(a, "termination_date")
        dated = dated or any(k in a for k in ("last_working_day", "last_day_of_work", "termination_date"))
        sup, dept = _pv(a, "supervisor") or {}, _pv(a, "department") or {}
        name = " ".join(filter(None, [_pv(a, "preferred_name") or _pv(a, "first_name"), _pv(a, "last_name")])) or None
        conn.execute(
            "INSERT INTO hr_record (personio_id, person_id, email, name, status, hire_date, leave_date, department, title,"
            " supervisor_email, first_seen, last_seen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (personio_id) DO UPDATE"
            " SET email = excluded.email, name = excluded.name, status = excluded.status,"
            " hire_date = excluded.hire_date, leave_date = excluded.leave_date, department = excluded.department,"
            " title = excluded.title, supervisor_email = excluded.supervisor_email, last_seen = excluded.last_seen,"
            " removed_at = NULL",
            (pid_hr, None, email, name, (_pv(a, "status") or "active").lower(), (_pv(a, "hire_date") or "")[:10] or None,
             (leave or "")[:10] or None, (dept.get("name") if isinstance(dept, dict) else None), _pv(a, "position"),
             ((sup.get("email") or {}).get("value") if isinstance(sup, dict) else None), ts, ts))
        seen.add(pid_hr)
    conn.execute("UPDATE hr_record SET removed_at = ? WHERE last_seen < ? AND removed_at IS NULL", (ts, ts))
    if data["employees"] and not dated:
        run.warn("Personio returns no leaving dates: allow 'termination_date' and 'last_working_day' on the API credential")
    run.stats["employees"] = len(seen)
    run.stats["matched_to_accounts"] = link_hr(conn)


def link_hr(conn):
    """Match HR records to people by email or alias (also in ASCII spelling). Runs after every apply via reconcile,
    because Personio may be written before the directory sync that creates the person. Returns matched records."""
    for r in conn.execute("SELECT personio_id, email FROM hr_record WHERE email IS NOT NULL").fetchall():
        pid = person_by_email(conn, r["email"]) or person_by_email(conn, ascii_email(r["email"]))
        conn.execute("UPDATE hr_record SET person_id = ? WHERE personio_id = ?", (pid, r["personio_id"]))
    return conn.execute("SELECT COUNT(*) FROM hr_record WHERE person_id IS NOT NULL AND removed_at IS NULL").fetchone()[0]


def import_csv(conn, actor, app_id, filename, data):
    ts = db.now()
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise ValueError("File must be UTF-8 encoded CSV")
    reader = csv.DictReader(io.StringIO(text))
    fields = {f.strip().lower(): f for f in reader.fieldnames or []}
    if "email" not in fields:
        raise ValueError("CSV needs an 'email' column")

    def col(r, *names):
        return next(((r.get(fields[n]) or "").strip() for n in names if n in fields), "")

    subs = {r["name"].lower(): r["id"] for r in conn.execute("SELECT id, name FROM subscription WHERE app_id = ?", (app_id,))}
    only_sub = next(iter(subs.values())) if len(subs) == 1 else None
    rows = skipped = 0
    seen = []
    for r in reader:
        email = col(r, "email").lower()
        if "@" not in email or len(email) > 320:
            skipped += 1
            continue
        rows += 1
        if rows > 50_000:
            raise ValueError("CSV too large (max 50,000 rows)")
        plan = col(r, "plan", "licence", "license")
        seen.append(f"{app_id}:{col(r, 'external_id') or email}")
        upsert_account(conn, ts, app_id, "csv", "imported", seen[-1], email=email,
                       display_name=col(r, "name") or None, role=col(r, "role") or plan or None,
                       subscription_id=subs.get(plan.lower()) if plan else only_sub,
                       state="disabled" if col(r, "status").lower() in DISABLED_WORDS else "active",
                       last_activity_at=col(r, "last_activity", "last_login") or None)
    # By id, not by timestamp: two imports within the same millisecond would otherwise keep removed rows.
    conn.execute("UPDATE account SET state = 'removed', removed_at = ? WHERE app_id = ? AND source = 'csv'"
                 " AND state != 'removed' AND external_id NOT IN (SELECT value FROM json_each(?))",
                 (ts, app_id, json.dumps(seen)))
    db.audit(conn, actor, "import.csv", "app", app_id,
             {"filename": filename, "rows": rows, "skipped": skipped, "sha256": hashlib.sha256(data).hexdigest()})
    reconcile(conn, ts)
    return rows, skipped


def merge_apps(conn, actor, src, dst, reason=None, reconcile_after=True):
    """Fold app `src` into `dst` (same product discovered under different names/sources)."""
    if src == dst:
        raise ValueError("Cannot merge an app into itself")
    old = conn.execute("SELECT name, status, owner_email, notes FROM app WHERE id = ?", (src,)).fetchone()
    for table in ("app_source", "account", "subscription", "issue", "access_request"):
        conn.execute(f"UPDATE {table} SET app_id = ? WHERE app_id = ?", (dst, src))
    db.audit(conn, actor, "app.merged", "app", dst, {"merged_app_id": src, "merged_name": old["name"], "reason": reason,
                                                     "merged_status": old["status"], "merged_owner": old["owner_email"],
                                                     "merged_notes": old["notes"]})
    conn.execute("DELETE FROM app WHERE id = ?", (src,))
    if reconcile_after:
        reconcile(conn, db.now())


def _host(url):
    return (urlparse(url).hostname or "").removeprefix("www.") if url else ""


def group_addons(conn, actor="system", app_id=None):
    """Fold add-ons into their provider's app: an app whose name starts with another app's name and has the same
    website (Claude for Gmail -> Claude), or that catalog.PROVIDER maps to another app (Claude -> Anthropic).
    Platform clients, internal and consumer apps are never grouped. An add-on an admin has decided on differently
    from its provider (say, unsanctioned while the provider is sanctioned) is left alone for the admin to merge.
    With app_id, only groups involving that app. Returns the number of apps merged; the caller reconciles."""
    skip = {catalog.PLATFORM, catalog.INTERNAL, catalog.CONSUMER}
    apps = [dict(r) for r in conn.execute("SELECT id, norm_name, status, category, website FROM app ORDER BY id")]
    # Each app also answers to the names it has absorbed (its sources' labels), with the catalogue's website for
    # those names, so add-ons still find Claude after Claude itself was folded into Anthropic.
    labels = {}
    for app_id_, label in conn.execute("SELECT app_id, label FROM app_source"):
        labels.setdefault(app_id_, set()).add(norm(label))
    by_norm = {}
    for a in apps:
        a["names"] = {a["norm_name"], *labels.get(a["id"], ())}
        a["hosts"] = {_host(a["website"])} | {(catalog.KNOWN.get(n) or (None, None))[1] for n in a["names"]}
        a["hosts"].discard(None), a["hosts"].discard("")
        for n in sorted(a["names"], key=lambda n: n != a["norm_name"]):  # own name first
            by_norm.setdefault(n, a)
    parents = {}

    def parent(a):
        if a["id"] not in parents:
            if a["norm_name"] in catalog.PROVIDER:
                p = by_norm.get(catalog.PROVIDER[a["norm_name"]])
            else:
                host = _host(a["website"])
                matches = [(len(n), b) for b in apps if b is not a and host in b["hosts"]
                           for n in b["names"] if n != a["norm_name"] and a["norm_name"].startswith(n)]
                p = max(matches, key=lambda m: m[0])[1] if host and matches else None
            ok = p and p is not a and a["category"] not in skip and p["category"] not in skip \
                and a["status"] in ("discovered", p["status"])
            parents[a["id"]] = p if ok else None
        return parents[a["id"]]

    new = next((a for a in apps if a["id"] == app_id), None)
    candidates = [a for a in apps if not new or a is new or any(a["norm_name"].startswith(n) for n in new["names"])
                  or catalog.PROVIDER.get(a["norm_name"]) in new["names"]]
    merged = 0
    for a in candidates:
        root, seen = parent(a), {a["id"]}
        while root and parent(root) and root["id"] not in seen:  # chains: Claude for Gmail -> Claude -> Anthropic
            seen.add(root["id"])
            root = parent(root)
        if root and root["id"] not in seen:
            merge_apps(conn, actor, a["id"], root["id"], reason="add-on of provider", reconcile_after=False)
            merged += 1
    return merged


# ---------------------------------------------------------------- reconciliation

def seats(conn, sub_id):
    """Active seats of a subscription with the person's latest trustworthy activity on that app (any source)."""
    return conn.execute(
        "SELECT a.id, a.email, a.person_id, a.source, p.name, p.status AS person_status,"
        " COALESCE((SELECT MAX(b.last_activity_at) FROM account b WHERE b.app_id = a.app_id AND b.person_id = a.person_id),"
        "          a.last_activity_at) AS last_activity"
        " FROM account a LEFT JOIN person p ON p.id = a.person_id"
        " WHERE a.subscription_id = ? AND a.state = 'active' ORDER BY last_activity", (sub_id,)).fetchall()


# Last-activity values the source reports itself (a directory's last login, an app's own CSV export). They are not
# bounded by a log window, so their history counts as complete.
ABSOLUTE_ACTIVITY_KINDS = ("directory", "imported")
UNKNOWN_START = "9999"  # a log-based source whose history start was never recorded: assume no usable history


SIGN_IN_SCOPES = {"openid", "email", "profile", "https://www.googleapis.com/auth/userinfo.email",
                  "https://www.googleapis.com/auth/userinfo.profile"}


def activity_coverage(conn):
    """app_id -> earliest time from which activity is observed ('' = complete). Apps absent here have no activity source.

    Besides apps with recorded activity, a log covers apps it would have recorded if they were used:
    - Google's token log records every API call, so grants with data scopes are covered even with zero events.
      Sign-in-only grants (openid/email/profile) make no API calls and stay uncovered (usage unknown).
    - Entra's sign-in log (interactive sign-ins) covers SSO-assigned apps. Delegated consents can be used
      non-interactively, which that log does not show, so they stay uncovered."""
    since = dict(conn.execute("SELECT name, activity_since FROM integration_state").fetchall())
    cov = {}

    def cover(app_id, start):
        cov[app_id] = min(cov.get(app_id, start), start)
    for app_id, source, kind in conn.execute("SELECT DISTINCT app_id, source, kind FROM account WHERE last_activity_at IS NOT NULL"):
        cover(app_id, "" if kind in ABSOLUTE_ACTIVITY_KINDS else (since.get(source) or UNKNOWN_START))
    if since.get("google"):
        for app_id, scopes in conn.execute("SELECT app_id, scopes FROM account WHERE source = 'google' AND kind = 'oauth_grant'"
                                           " AND scopes IS NOT NULL"):
            if set(json.loads(scopes)) - SIGN_IN_SCOPES:
                cover(app_id, since["google"])
    if since.get("entra"):
        for (app_id,) in conn.execute("SELECT DISTINCT app_id FROM account WHERE source = 'entra' AND kind = 'sso_assignment'"):
            cover(app_id, since["entra"])
    return cov


def usage_state(last, start, cutoff):
    """active | inactive | unknown (no activity source) | insufficient_history (log does not reach back to cutoff)."""
    if start is None:
        return "unknown"
    if last and last >= cutoff:
        return "active"
    return "insufficient_history" if start > cutoff else "inactive"


def app_usage(conn, cutoff, app_ids=None):
    """Per app: activity coverage, people with current evidence, how many were active since cutoff, and a usage
    state per person (key: person id, or 'acc<id>' for accounts that match no person)."""
    if app_ids is not None and not app_ids:
        return {}
    cov = activity_coverage(conn)
    where = f" WHERE app_id IN ({','.join('?' * len(app_ids))})" if app_ids is not None else ""
    keys = {}
    for app_id, pid, acc_id, last, state in conn.execute(
            f"SELECT app_id, person_id, id, last_activity_at, state FROM account{where}", list(app_ids or [])):
        k = keys.setdefault(app_id, {}).setdefault(pid if pid is not None else f"acc{acc_id}", [None, False])
        k[0] = max(k[0] or "", last or "") or None
        k[1] = k[1] or state != "removed"
    out = {}
    for app_id in (app_ids if app_ids is not None else keys):
        start = cov.get(app_id)
        entries = keys.get(app_id, {})
        states = {key: usage_state(last, start, cutoff) for key, (last, _) in entries.items()}
        current = [key for key, (_, cur) in entries.items() if cur]
        out[app_id] = {
            "coverage": "none" if start is None else "partial" if start > cutoff else "complete",
            "since": start if start not in (None, "", UNKNOWN_START) else None,
            "people": len(current), "active": sum(states[k] == "active" for k in current),
            "states": states, "last": {key: last for key, (last, _) in entries.items()},
        }
    return out


def annual_cost(sub):
    if sub["unit_cost"] is None:
        return None
    return sub["unit_cost"] * (12 if sub["billing_period"] == "month" else 1)


def classify_apps(conn, actor="system", app_id=None):
    """Fill in category and website from the catalogue where nobody has set them, and move platform sign-in
    clients that are still awaiting a decision to 'ignored'. Never overwrites an admin's values. Runs for each new
    app as it is discovered, and for all apps at startup (so catalogue and INTERNAL_APP_HINTS changes apply).
    Returns the number of apps changed."""
    hints, changed = catalog.internal_hints(), 0
    for app in conn.execute("SELECT id, name, norm_name, status, category, website FROM app"
                            " WHERE (category IS NULL OR website IS NULL OR status = 'discovered') AND ? IN (id, 0)",
                            (app_id or 0,)).fetchall():
        match = catalog.classify(app["norm_name"], hints)
        if not match:
            continue
        category, domain = match
        new = {"category": app["category"] or category, "website": app["website"] or (domain and f"https://{domain}"),
               "status": "ignored" if category == catalog.PLATFORM and app["status"] == "discovered" else app["status"]}
        changes = {k: {"from": app[k], "to": v} for k, v in new.items() if app[k] != v}
        if changes:
            conn.execute("UPDATE app SET category = ?, website = ?, status = ? WHERE id = ?",
                         (new["category"], new["website"], new["status"], app["id"]))
            db.audit(conn, actor, "app.classified", "app", app["id"], {"name": app["name"], "changes": changes})
            changed += 1
    return changed


def reconcile(conn, ts):
    found = {}

    def add(key, kind, severity, title, detail="", app_id=None, person_id=None):
        found[key] = (kind, severity, title, detail, app_id, person_id)

    marks = ",".join("?" * len(ACCESS_KINDS))
    for r in conn.execute(
            "SELECT p.id pid, p.email, p.status, app.id aid, app.name, GROUP_CONCAT(DISTINCT a.kind) kinds"
            " FROM account a JOIN person p ON p.id = a.person_id JOIN app ON app.id = a.app_id"
            f" WHERE a.state = 'active' AND p.status != 'active' AND app.status != 'ignored' AND a.kind IN ({marks})"
            " GROUP BY p.id, app.id", ACCESS_KINDS):
        add(f"leaver:{r['pid']}:{r['aid']}", "leaver_access", "high",
            f"{r['status'].capitalize()} person {r['email']} still has access to {r['name']}",
            f"Evidence: {r['kinds']}", r["aid"], r["pid"])

    for r in conn.execute(
            "SELECT a.id, a.email, a.external_id, a.kind, app.id aid, app.name FROM account a JOIN app ON app.id = a.app_id"
            " WHERE a.state = 'active' AND a.person_id IS NULL AND app.status != 'ignored'"
            " AND a.kind IN ('directory', 'license', 'sso_assignment', 'imported')"):
        add(f"orphan:{r['id']}", "orphan_account", "medium",
            f"Account {r['email'] or r['external_id']} in {r['name']} matches no known person",
            f"Evidence: {r['kind']}", r["aid"])

    for app in conn.execute("SELECT id, name, status FROM app WHERE status NOT IN ('sanctioned', 'ignored')").fetchall():
        rows = conn.execute("SELECT scopes FROM account WHERE app_id = ? AND kind = 'oauth_grant' AND state = 'active'"
                            " AND scopes IS NOT NULL", (app["id"],)).fetchall()
        risky = sorted({s for r in rows for s in risky_scopes(json.loads(r[0]))})
        if risky:
            add(f"risky:{app['id']}", "risky_scopes", "high",
                f"{app['status'].capitalize()} app {app['name']} has sensitive data access ({len(rows)} grant(s))",
                ", ".join(risky), app["id"])

    for r in conn.execute(
            "SELECT app.id, app.name, COUNT(DISTINCT a.person_id) users FROM app"
            " LEFT JOIN account a ON a.app_id = app.id AND a.state = 'active' WHERE app.status = 'discovered' GROUP BY app.id"):
        add(f"review:{r['id']}", "unreviewed_app", "info", f"New app {r['name']} needs a decision",
            f"{r['users']} user(s) with active evidence", r["id"])
    for r in conn.execute("SELECT id, name FROM app WHERE status = 'sanctioned' AND COALESCE(owner_email, '') = ''"):
        add(f"owner:{r['id']}", "no_owner", "low", f"Sanctioned app {r['name']} has no owner", "", r["id"])

    cutoff, today = ago(config.INACTIVITY_DAYS), ts[:10]
    soon = (dt.date.fromisoformat(today) + dt.timedelta(days=60)).isoformat()
    usage = app_usage(conn, cutoff)
    days = config.INACTIVITY_DAYS

    # Access that nobody uses: an unused grant to mail, files or the directory is pure attack surface.
    # Only provable inactivity counts (unknown usage or too short a history never raises this).
    for r in conn.execute(
            "SELECT a.person_id pid, p.email, app.id aid, app.name, a.scopes FROM account a"
            " JOIN person p ON p.id = a.person_id JOIN app ON app.id = a.app_id"
            " WHERE a.kind = 'oauth_grant' AND a.state = 'active' AND a.scopes IS NOT NULL"
            " AND p.status = 'active' AND app.status != 'ignored'"):  # leavers are already reported as leaver_access
        risky = risky_scopes(json.loads(r["scopes"]))
        if risky and usage.get(r["aid"], {}).get("states", {}).get(r["pid"]) == "inactive":
            add(f"dormant:{r['pid']}:{r['aid']}", "dormant_grant", "medium",
                f"{r['email']} has not used {r['name']} in {days} days but it still has access to sensitive data",
                "Revoke candidate. Scopes: " + ", ".join(risky), r["aid"], r["pid"])

    for app in conn.execute("SELECT id, name FROM app WHERE status != 'ignored'").fetchall():
        u = usage.get(app["id"])
        if u and u["coverage"] == "complete" and u["people"] and not u["active"]:
            add(f"unused:{app['id']}", "unused_app", "low",
                f"Nobody has used {app['name']} in {days} days; {u['people']} still have access",
                "Candidate to remove access or cancel. Based on activity reported by its sources.", app["id"])
    for s in conn.execute("SELECT s.*, app.name app_name FROM subscription s JOIN app ON app.id = s.app_id").fetchall():
        rows = seats(conn, s["id"])
        label = f"{s['app_name']} · {s['name']}"
        if s["quantity"] is not None and len(rows) > s["quantity"]:
            add(f"overalloc:{s['id']}", "over_allocated", "medium",
                f"{label}: {len(rows)} seats assigned, {s['quantity']} purchased", "", s["app_id"])
        if rows and usage.get(s["app_id"], {}).get("coverage") == "complete":  # inactivity only with full history
            idle = [r for r in rows if (r["last_activity"] or "") < cutoff]
            if idle:
                cost = annual_cost(s)
                add(f"idle:{s['id']}", "inactive_seats", "low",
                    f"{label}: {len(idle)} seat(s) with no activity in {config.INACTIVITY_DAYS} days",
                    "Reclaim candidates, not proof of waste."
                    + (f" Est. annual value {cost * len(idle):,.0f} {s['currency']}." if cost is not None else ""),
                    s["app_id"])
        if s["renewal_date"] and today <= s["renewal_date"] <= soon:
            add(f"renewal:{s['id']}:{s['renewal_date']}", "renewal_due", "info",
                f"{label} renews on {s['renewal_date']}", f"Owner: {s['owner_email'] or 'none'}", s["app_id"])

    # HR (Personio) against the directories. An employee may have several Personio records (rehires): a person only
    # counts as having left when none of their records is current.
    link_hr(conn)
    current_hr = "(h.leave_date IS NULL OR h.leave_date >= :today) AND h.status != 'inactive'"
    for r in conn.execute(
            "SELECT h.*, p.email account FROM hr_record h JOIN person p ON p.id = h.person_id WHERE h.removed_at IS NULL"
            " AND p.status = 'active' AND NOT (" + current_hr + ") AND NOT EXISTS (SELECT 1 FROM hr_record h2"
            " WHERE h2.person_id = h.person_id AND h2.removed_at IS NULL AND " + current_hr.replace("h.", "h2.") + ")",
            {"today": today}):
        when = f"on {r['leave_date']}" if r["leave_date"] else "(Personio status inactive)"
        add(f"hr_leaver:{r['person_id']}", "hr_leaver", "high", f"{r['name'] or r['email']} left {when} but {r['account']} is still active",
            "Personio says this person has left; their directory account is not suspended.", None, r["person_id"])
    for r in conn.execute("SELECT * FROM hr_record WHERE removed_at IS NULL AND status != 'inactive'"
                          " AND leave_date BETWEEN ? AND ?", (today, (dt.date.fromisoformat(today) + dt.timedelta(days=14)).isoformat())):
        add(f"hr_leaving:{r['personio_id']}:{r['leave_date']}", "hr_leaving_soon", "info",
            f"{r['name'] or r['email']} leaves on {r['leave_date']}", "Plan the offboarding.", None, r["person_id"])
    for r in conn.execute("SELECT * FROM hr_record WHERE removed_at IS NULL AND person_id IS NULL AND status != 'inactive'"
                          " AND (leave_date IS NULL OR leave_date >= ?)", (today,)):
        future = (r["hire_date"] or "") > today
        add(f"hr_unmatched:{r['personio_id']}", "hr_unmatched", "low" if future else "medium",
            f"Personio employee {r['name'] or r['personio_id']} matches no account",
            f"Starts {r['hire_date']}; no account yet." if future else
            f"Personio email {r['email'] or 'missing'} is not a known Google or Entra address or alias.")
    if conn.execute("SELECT last_success_at FROM integration_state WHERE name = 'personio'").fetchone():
        for r in conn.execute("SELECT id, email FROM person p WHERE status = 'active' AND kind = 'employee'"
                              " AND (google_id IS NOT NULL OR entra_id IS NOT NULL)"
                              " AND NOT EXISTS (SELECT 1 FROM hr_record h WHERE h.person_id = p.id AND h.removed_at IS NULL)"):
            add(f"no_hr:{r['id']}", "no_hr_record", "low", f"Active account {r['email']} has no Personio record",
                "A shared mailbox or service account (accept the issue), or someone missing from HR.", None, r["id"])

    stale_before = ago(config.SYNC_INTERVAL_HOURS * 2 / 24)
    for name in configured_integrations():
        st = conn.execute("SELECT * FROM integration_state WHERE name = ?", (name,)).fetchone()
        if not st or not st["last_success_at"] or st["last_success_at"] < stale_before:
            add(f"stale:{name}", "stale_connector", "medium", f"{name.capitalize()} connector has no recent successful sync",
                (st["last_error"] if st else None) or "Never synced successfully")

    existing = {r["key"]: r for r in conn.execute("SELECT * FROM issue")}
    opened = resolved = 0
    for key, (kind, severity, title, detail, app_id, person_id) in found.items():
        old = existing.get(key)
        if not old:
            conn.execute("INSERT INTO issue (key, kind, severity, title, detail, app_id, person_id, opened_at, last_seen)"
                         " VALUES (?,?,?,?,?,?,?,?,?)", (key, kind, severity, title, detail, app_id, person_id, ts, ts))
            opened += 1
            continue
        reopen = old["status"] == "resolved" or (
            old["status"] == "accepted" and old["accepted_until"] and old["accepted_until"] < today)
        conn.execute("UPDATE issue SET severity = ?, title = ?, detail = ?, app_id = ?, last_seen = ?, status = ?,"
                     " opened_at = ?, resolved_at = ? WHERE id = ?",
                     (severity, title, detail, app_id, ts, "open" if reopen else old["status"],
                      ts if reopen else old["opened_at"], None if reopen else old["resolved_at"], old["id"]))
        opened += reopen
    for key, old in existing.items():
        if key not in found and old["status"] != "resolved":
            conn.execute("UPDATE issue SET status = 'resolved', resolved_at = ? WHERE id = ?", (ts, old["id"]))
            resolved += 1
    return opened, resolved


# ---------------------------------------------------------------- orchestration

INTEGRATIONS = {"google": (lambda: config.google_sync, fetch_google, apply_google),
                "entra": (lambda: config.entra_sync, fetch_entra, apply_entra),
                "personio": (lambda: config.personio_sync, fetch_personio, apply_personio)}
_lock = threading.Lock()
_apply_lock = threading.Lock()


def configured_integrations():
    return [name for name, (enabled, *_) in INTEGRATIONS.items() if enabled()]


def run_sync(actor="system"):
    """Run every configured connector, then reconcile. Returns False if a sync is already running."""
    if not _lock.acquire(blocking=False):
        return False
    try:
        # Connectors fetch in parallel (network-bound); their write phases take turns (see _apply_lock).
        with ThreadPoolExecutor() as pool:
            list(pool.map(lambda name: _run_one(name, *INTEGRATIONS[name][1:], actor), configured_integrations()))
        conn = db.connect()
        with conn:
            opened, resolved = reconcile(conn, db.now())
            db.audit(conn, actor, "reconcile.completed", detail={"opened": opened, "resolved": resolved})
        conn.close()
    finally:
        _lock.release()
    return True


def _run_one(name, fetch, apply, actor):
    conn = db.connect()
    run = Run(db.now())
    with conn:
        run_id = run.run_id = conn.execute("INSERT INTO sync_run (integration, started_at, status) VALUES (?, ?, 'running')",
                                           (name, run.ts)).lastrowid
    try:
        data = fetch(conn, run)  # network only: other requests (sign-ins, edits) keep writing meanwhile
        run.progress("writing results")
        with _apply_lock, conn:  # one writer at a time, so neither waits out SQLite's busy timeout
            apply(conn, run, data)
            conn.execute("INSERT INTO integration_state (name, last_success_at) VALUES (?, ?) ON CONFLICT (name)"
                         " DO UPDATE SET last_success_at = excluded.last_success_at, last_error = NULL", (name, run.ts))
        status, error = "ok", None
    except Exception as e:  # one failing connector must not stop the others
        log.exception("sync %s failed", name)
        status, error = "error", f"{type(e).__name__}: {e}"[:500]
        with conn:
            conn.execute("INSERT INTO integration_state (name, last_error) VALUES (?, ?)"
                         " ON CONFLICT (name) DO UPDATE SET last_error = excluded.last_error", (name, error))
    with conn:
        conn.execute("UPDATE sync_run SET finished_at = ?, status = ?, stats = ?, warnings = ?, error = ? WHERE id = ?",
                     (db.now(), status, json.dumps(run.stats), json.dumps(run.warnings), error, run_id))
        db.audit(conn, actor, f"sync.{status}", "integration", name,
                 {"stats": dict(run.stats), "warnings": run.warnings, "error": error})
    conn.close()
