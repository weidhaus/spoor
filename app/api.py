"""JSON API for the web UI (frontend/). It shares the server-side session created by the OIDC sign-in.

Every state-changing call needs the X-CSRF-Token header. A custom header also forces a CORS preflight that
this API never answers, so other sites cannot send these requests at all.

State semantics follow the UI contract: observed access (present/absent/unknown), freshness
(current/stale/unknown) and request decision, execution and verification are reported independently."""
import asyncio
import csv
import hashlib
import hmac
import io
import json
import re
import zipfile
from contextlib import closing
from typing import Literal
from urllib.parse import urlparse

import requests
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator
from starlette.concurrency import run_in_threadpool

from . import actions, auth, config, db, discovery, offboarding
from .connectors import ENTRA_PERMISSIONS, GOOGLE_SCOPES
from .discovery import ACCESS_KINDS, ago, annual_cost, risky_scopes

router = APIRouter(prefix="/api")

APP_STATUSES = ("discovered", "sanctioned", "tolerated", "unsanctioned", "ignored")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
SEVERITY_ORDER = "CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END"
AUDIT_FAILURES = ("auth.denied", "sync.error")
CONNECTOR_SOURCES = ("google", "entra", "personio")
MARKS = ",".join("?" * len(ACCESS_KINDS))
NO_CATEGORY = "(none)"  # category filter value for apps nobody has categorised


def stale_before():
    return ago(config.SYNC_INTERVAL_HOURS * 2 / 24)


FRESHNESS_POLICY = (f"Connector evidence is current when it was observed within {config.SYNC_INTERVAL_HOURS * 2:g} hours "
                    "(twice the sync interval). CSV imports and manual records have no freshness policy.")


def freshness(source, observed_at, cutoff):
    if source not in CONNECTOR_SOURCES or not observed_at:
        return "unknown"
    return "current" if observed_at >= cutoff else "stale"


# ---------------------------------------------------------------- auth dependencies

def reader(request: Request):
    """Any signed-in user with a role (admin or auditor)."""
    try:
        return auth.current_user(request)
    except HTTPException as e:
        if e.status_code == 303:
            raise HTTPException(401, "Not signed in.")
        raise


def _check_csrf(request, user):
    if not hmac.compare_digest(request.headers.get("x-csrf-token", ""), user.csrf):
        raise HTTPException(403, "Invalid or missing CSRF token. Reload the page and try again.")


def member(request: Request):
    """State-changing call that any role may make (sign-out, audit verification, exports)."""
    user = reader(request)
    _check_csrf(request, user)
    return user


def workflows_on():
    if not config.WORKFLOWS:
        raise HTTPException(404, "Workflows are disabled.")


def officer(request: Request):
    """Security actions: ACTIONS on, admin role, listed in SECURITY_OFFICERS, CSRF, and a fresh Google re-sign-in."""
    if not config.ACTIONS:
        raise HTTPException(404, "Security actions are disabled.")
    user = admin(request)
    if not actions.is_officer(user):
        raise HTTPException(403, "Security officer role required.")
    if not user.stepup_at or user.stepup_at < ago(actions.STEPUP_VALID_SECONDS / 86400):
        raise HTTPException(401, "stepup_required")
    return user


def admin(request: Request):
    user = reader(request)
    if not user.is_admin:
        raise HTTPException(403, "Administrator role required.")
    _check_csrf(request, user)
    return user


def connect():
    return closing(db.connect())


def one(conn, sql, *args):
    row = conn.execute(sql, args).fetchone()
    if row is None:
        raise HTTPException(404, "Not found.")
    return row


def rows(conn, sql, *args):
    return [dict(r) for r in conn.execute(sql, args)]


# ---------------------------------------------------------------- input models

def _email(v):
    v = (v or "").strip().lower()
    if v and not EMAIL_RE.match(v):
        raise ValueError("not a valid email address")
    return v or None


def _text(v, limit):
    return (v or "").strip()[:limit] or None


class AppPatch(BaseModel):
    status: Literal[APP_STATUSES]
    owner_email: str | None = None
    category: str | None = None
    website: str | None = None
    notes: str | None = None

    @field_validator("owner_email")
    @classmethod
    def check_owner(cls, v):
        return _email(v)

    @field_validator("category")
    @classmethod
    def check_category(cls, v):
        return _text(v, 100)

    @field_validator("notes")
    @classmethod
    def check_notes(cls, v):
        return _text(v, 4000)

    @field_validator("website")
    @classmethod
    def check_website(cls, v):
        v = _text(v, 300)
        if v and not v.startswith(("https://", "http://")):
            raise ValueError("must start with https://")
        return v


class BulkStatus(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=500)
    status: Literal[APP_STATUSES]


class Merge(BaseModel):
    target_id: int


class LicenseIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    quantity: int | None = Field(None, ge=0)
    unit_cost: float | None = Field(None, ge=0)
    currency: str = Field("EUR", pattern=r"^[A-Z]{3}$")
    billing_period: Literal["month", "year"] = "month"
    renewal_date: str | None = None
    owner_email: str | None = None
    notes: str | None = None

    @field_validator("owner_email")
    @classmethod
    def check_owner(cls, v):
        return _email(v)

    @field_validator("notes")
    @classmethod
    def check_notes(cls, v):
        return _text(v, 2000)

    @field_validator("renewal_date")
    @classmethod
    def check_date(cls, v):
        v = _text(v, 10)
        if v and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
            raise ValueError("must be YYYY-MM-DD")
        return v


class LicenseCreate(LicenseIn):
    app_id: int


class RequestIn(BaseModel):
    person_id: int
    app_id: int
    type: Literal["grant", "revoke"]
    requested_access: str | None = None
    justification: str = Field(min_length=5, max_length=2000)

    @field_validator("requested_access")
    @classmethod
    def check_access(cls, v):
        return _text(v, 200)


class DecisionIn(BaseModel):
    decision: Literal["approved", "rejected"]
    note: str | None = Field(None, max_length=2000)


class ExecutionIn(BaseModel):
    outcome: Literal["completed", "failed"]
    note: str | None = Field(None, max_length=2000)


class AcceptIn(BaseModel):
    reason: str = Field(min_length=5, max_length=1000)
    until: str | None = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")


class ActionIn(BaseModel):
    kind: Literal[tuple(actions.KINDS)]
    target: str | None = None
    reason: str = Field(min_length=1, max_length=1000)
    confirm: str


class OffboardIn(BaseModel):
    steps: list[Literal[tuple(offboarding.LABEL)]] = Field(min_length=1)
    recipient_email: str | None = None
    message: str | None = Field(None, max_length=2000)
    confirm: str

    @field_validator("recipient_email")
    @classmethod
    def check_recipient(cls, v):
        return _email(v)


class RoleIn(BaseModel):
    email: str
    role: Literal["admin", "auditor"]

    @field_validator("email")
    @classmethod
    def check_email(cls, v):
        return _email(v)


class ExportIn(BaseModel):
    resource: str
    filters: dict[str, str] = {}
    ids: list[int] | None = Field(None, max_length=10_000)
    fields: list[str] | None = None


class DemoLogin(BaseModel):
    role: Literal["admin", "auditor"] = "admin"


# ---------------------------------------------------------------- list queries (shared by tables and exports)
# Each builder returns (sql, args) for a sub-select with an `id` column. Sorting uses a whitelist.

def _where(parts):
    return (" WHERE " + " AND ".join(parts)) if parts else ""


def q_applications(f):
    where, args = [], []
    status = f.get("status", "")
    if status == "":
        where.append("app.status != 'ignored'")
    elif status != "all":
        where.append("app.status = ?")
        args.append(status)
    if f.get("q"):
        where.append("(app.name LIKE ? OR app.category LIKE ? OR app.owner_email LIKE ?)")
        args += [f"%{f['q']}%"] * 3
    if f.get("category") == NO_CATEGORY:
        where.append("COALESCE(app.category, '') = ''")
    elif f.get("category"):
        where.append("app.category = ?")
        args.append(f["category"])
    if f.get("source"):
        where.append("EXISTS (SELECT 1 FROM app_source s WHERE s.app_id = app.id AND s.source = ?)")
        args.append(f["source"])
    return f"""SELECT app.id, app.name, app.status, app.category, app.owner_email, app.website, app.first_seen,
        (SELECT COUNT(DISTINCT COALESCE(a.person_id, 'acc' || a.id)) FROM account a
          WHERE a.app_id = app.id AND a.state != 'removed') AS people,
        (SELECT COUNT(*) FROM subscription s WHERE s.app_id = app.id) AS plans,
        (SELECT GROUP_CONCAT(DISTINCT source) FROM app_source WHERE app_id = app.id) AS sources,
        (SELECT MAX(last_seen) FROM account a WHERE a.app_id = app.id) AS last_observed,
        (SELECT COUNT(*) FROM issue i WHERE i.app_id = app.id AND i.status = 'open') AS open_issues
        FROM app{_where(where)}""", args


# The person's current Personio record: rehires have several, and a record that has not ended wins over the latest hire.
HR_ORDER = "h.status = 'inactive', h.hire_date DESC"
HR_LATEST = f"(SELECT h.{{}} FROM hr_record h WHERE h.person_id = p.id AND h.removed_at IS NULL ORDER BY {HR_ORDER} LIMIT 1)"


def q_people(f):
    where, args = [], []
    for key in ("status", "kind"):
        if f.get(key):
            where.append(f"p.{key} = ?")
            args.append(f[key])
    if f.get("hr") == "none":
        where.append(f"{HR_LATEST.format('status')} IS NULL")
    elif f.get("hr"):
        where.append(f"{HR_LATEST.format('status')} = ?")
        args.append(f["hr"])
    if f.get("q"):
        where.append("(p.email LIKE ? OR p.name LIKE ? OR p.department LIKE ?"
                     " OR EXISTS (SELECT 1 FROM person_email e WHERE e.person_id = p.id AND e.email LIKE ?))")
        args += [f"%{f['q']}%"] * 4
    return f"""SELECT p.id, p.name, p.email, p.department, p.title, p.kind, p.status, p.status_source,
        p.first_seen, p.last_seen, {HR_LATEST.format('status')} AS hr_status, {HR_LATEST.format('leave_date')} AS hr_leave_date,
        (SELECT COUNT(DISTINCT app_id) FROM account WHERE person_id = p.id AND state != 'removed') AS apps,
        (SELECT COUNT(*) FROM issue WHERE person_id = p.id AND status = 'open') AS open_issues
        FROM person p{_where(where)}""", args


def q_accounts(f):
    where, args = [], []
    for key in ("app_id", "person_id"):
        if f.get(key):
            where.append(f"a.{key} = ?")
            args.append(int(f[key]))
    if f.get("state") == "current":
        where.append("a.state != 'removed'")
    if f.get("q"):
        where.append("(COALESCE(p.email, a.email) LIKE ? OR p.name LIKE ? OR app.name LIKE ?)")
        args += [f"%{f['q']}%"] * 3
    return f"""SELECT a.id, a.app_id, app.name AS app_name, a.person_id, p.name AS person_name,
        COALESCE(p.email, a.email) AS email, p.status AS person_status, a.source, a.kind, a.external_id,
        a.display_name, a.role, a.scopes, a.subscription_id, s.name AS plan, a.state, a.first_seen, a.last_seen,
        a.removed_at, a.last_activity_at
        FROM account a JOIN app ON app.id = a.app_id LEFT JOIN person p ON p.id = a.person_id
        LEFT JOIN subscription s ON s.id = a.subscription_id{_where(where)}""", args


def q_licenses(f):
    where, args = [], [ago(config.INACTIVITY_DAYS)]
    if f.get("app_id"):
        where.append("s.app_id = ?")
        args.append(int(f["app_id"]))
    if f.get("q"):
        where.append("(app.name LIKE ? OR s.name LIKE ?)")
        args += [f"%{f['q']}%"] * 2
    inner = f"""SELECT s.id, s.app_id, app.name AS app_name, s.name, s.source, s.external_id, s.quantity,
        s.observed_consumed, s.unit_cost, s.currency, s.billing_period, s.renewal_date, s.owner_email, s.notes,
        s.last_seen,
        (SELECT COUNT(*) FROM account a WHERE a.subscription_id = s.id AND a.state = 'active') AS assigned,
        CASE WHEN EXISTS (SELECT 1 FROM account b WHERE b.app_id = s.app_id AND b.last_activity_at IS NOT NULL) THEN
          (SELECT COUNT(*) FROM account a WHERE a.subscription_id = s.id AND a.state = 'active'
             AND COALESCE((SELECT MAX(b.last_activity_at) FROM account b WHERE b.app_id = a.app_id
                           AND b.person_id = a.person_id), a.last_activity_at) >= ?) END AS active
        FROM subscription s JOIN app ON app.id = s.app_id{_where(where)}"""
    return f"""SELECT x.*, CASE WHEN x.quantity IS NULL THEN NULL ELSE x.quantity - x.assigned END AS available
        FROM ({inner}) x""", args


def q_requests(f):
    where, args = [], []
    for key in ("decision", "execution", "type"):
        if f.get(key):
            where.append(f"r.{key} = ?")
            args.append(f[key])
    for key in ("person_id", "app_id"):
        if f.get(key):
            where.append(f"r.{key} = ?")
            args.append(int(f[key]))
    if f.get("q"):
        where.append("(p.email LIKE ? OR p.name LIKE ? OR app.name LIKE ? OR r.requested_by LIKE ?)")
        args += [f"%{f['q']}%"] * 4
    return f"""SELECT r.id, r.type, r.person_id, p.name AS person_name, p.email AS person_email, r.app_id,
        app.name AS app_name, r.requested_access, r.justification, r.requested_by, r.requested_at, r.decision,
        r.decided_by, r.decided_at, r.decision_note, r.execution, r.executed_by, r.executed_at, r.execution_note
        FROM access_request r JOIN person p ON p.id = r.person_id JOIN app ON app.id = r.app_id{_where(where)}""", args


def q_issues(f):
    where, args = [], []
    status = f.get("status", "open")
    if status != "all":
        where.append("i.status = ?")
        args.append(status)
    for key in ("severity", "kind"):
        if f.get(key):
            where.append(f"i.{key} = ?")
            args.append(f[key])
    for key in ("app_id", "person_id"):
        if f.get(key):
            where.append(f"i.{key} = ?")
            args.append(int(f[key]))
    if f.get("q"):
        where.append("i.title LIKE ?")
        args.append(f"%{f['q']}%")
    return f"""SELECT i.id, i.kind, i.severity, {SEVERITY_ORDER.replace('severity', 'i.severity')} AS severity_rank,
        i.title, i.detail, i.status, i.app_id, app.name AS app_name, i.person_id, p.email AS person_email,
        i.opened_at, i.last_seen, i.resolved_at, i.accepted_by, i.accepted_reason, i.accepted_until
        FROM issue i LEFT JOIN app ON app.id = i.app_id LEFT JOIN person p ON p.id = i.person_id{_where(where)}""", args


def q_audit(f):
    where, args = [], []
    fail = ",".join("?" * len(AUDIT_FAILURES))
    if f.get("from"):
        where.append("occurred_at >= ?")
        args.append(f["from"])
    if f.get("to"):
        where.append("occurred_at < date(?, '+1 day')")
        args.append(f["to"])
    if f.get("actor"):
        where.append("actor LIKE ?")
        args.append(f"%{f['actor']}%")
    if f.get("action"):
        where.append("action LIKE ?")
        args.append(f"{f['action']}%")
    if f.get("target_type"):
        where.append("target_type = ?")
        args.append(f["target_type"])
    if f.get("target_id"):
        where.append("target_id = ?")
        args.append(f["target_id"])
    if f.get("outcome") in ("failed", "completed"):
        where.append(f"action {'' if f['outcome'] == 'failed' else 'NOT '}IN ({fail})")
        args += AUDIT_FAILURES
    return f"""SELECT id, event_id, occurred_at, actor, action, target_type, target_id, detail, prev_hash, hash,
        CASE WHEN action IN ({fail}) THEN 'failed' ELSE 'completed' END AS outcome,
        CASE WHEN actor IN ('system', 'demo') THEN 'system' ELSE 'user' END AS origin
        FROM audit_event{_where(where)}""", [*AUDIT_FAILURES, *args]


RESOURCES = {  # name: (builder, sortable columns, default sort, export fields)
    "applications": (q_applications, {"name", "status", "people", "last_observed", "open_issues", "first_seen"},
                     "people DESC, name",
                     ["id", "name", "status", "category", "owner_email", "website", "people", "plans", "sources",
                      "first_seen", "last_observed", "open_issues"]),
    "people": (q_people, {"name", "email", "department", "status", "hr_status", "apps", "last_seen", "open_issues"},
               "status != 'active' DESC, email",
               ["id", "email", "name", "department", "title", "kind", "status", "status_source", "hr_status", "hr_leave_date", "apps",
                "first_seen", "last_seen", "open_issues"]),
    "accounts": (q_accounts, {"app_name", "email", "kind", "source", "state", "last_seen", "last_activity_at"},
                 "state = 'removed', email, kind",
                 ["id", "app_name", "email", "person_name", "person_status", "source", "kind", "external_id", "role",
                  "plan", "scopes", "state", "first_seen", "last_seen", "removed_at", "last_activity_at"]),
    "licenses": (q_licenses, {"app_name", "name", "quantity", "assigned", "available", "renewal_date"},
                 "app_name, name",
                 ["id", "app_name", "name", "source", "quantity", "assigned", "available", "active",
                  "observed_consumed", "unit_cost", "currency", "billing_period", "renewal_date", "owner_email"]),
    "requests": (q_requests, {"requested_at", "decision", "execution", "app_name", "person_email"},
                 "decision != 'pending', requested_at DESC",
                 ["id", "type", "person_email", "person_name", "app_name", "requested_access", "justification",
                  "requested_by", "requested_at", "decision", "decided_by", "decided_at", "decision_note",
                  "execution", "executed_by", "executed_at", "execution_note"]),
    "issues": (q_issues, {"severity_rank", "opened_at", "kind", "status"}, "severity_rank, opened_at DESC",
               ["id", "kind", "severity", "status", "title", "detail", "app_name", "person_email", "opened_at",
                "resolved_at", "accepted_by", "accepted_reason", "accepted_until"]),
    "audit": (q_audit, {"occurred_at", "actor", "action"}, "id DESC",
              ["event_id", "occurred_at", "actor", "action", "target_type", "target_id", "outcome", "detail",
               "prev_hash", "hash"]),
}
LIST_PARAMS = {"page", "page_size", "sort", "order"}


def list_resource(conn, name, request):
    builder, sortable, default, _ = RESOURCES[name]
    qp = request.query_params
    filters = {k: v.strip() for k, v in qp.items() if k not in LIST_PARAMS and v.strip()}
    try:
        page = max(1, int(qp.get("page", 1)))
        size = min(100, max(1, int(qp.get("page_size", 25))))
        sql, args = builder(filters)
    except ValueError:
        raise HTTPException(400, "Invalid filter or paging value.")
    sort = qp.get("sort")
    order = f"{sort} {'DESC' if qp.get('order') == 'desc' else 'ASC'}, id" if sort in sortable else default
    total = conn.execute(f"SELECT COUNT(*) FROM ({sql})", args).fetchone()[0]
    data = rows(conn, f"SELECT * FROM ({sql}) ORDER BY {order} LIMIT ? OFFSET ?", *args, size, (page - 1) * size)
    return data, total


# ---------------------------------------------------------------- derived state

def observed_access(conn, person_id, app_id, cutoff):
    """What the sources last reported for this person and app. Absence only counts when a source that
    covers this app has reported at least one snapshot; otherwise the answer is unknown."""
    r = conn.execute(f"SELECT source, MAX(last_seen) AS t FROM account WHERE person_id = ? AND app_id = ?"
                     f" AND state != 'removed' AND kind IN ({MARKS}) GROUP BY source ORDER BY t DESC LIMIT 1",
                     (person_id, app_id, *ACCESS_KINDS)).fetchone()
    state = "present"
    if not r:
        state = "absent"
        r = conn.execute(f"SELECT source, MAX(COALESCE(removed_at, last_seen)) AS t FROM account WHERE app_id = ?"
                         f" AND kind IN ({MARKS}) GROUP BY source ORDER BY t DESC LIMIT 1",
                         (app_id, *ACCESS_KINDS)).fetchone()
    if not r:
        return {"state": "unknown", "observed_at": None, "source": None, "freshness": "unknown"}
    return {"state": state, "observed_at": r["t"], "source": r["source"], "freshness": freshness(r["source"], r["t"], cutoff)}


def verification(req, obs):
    """Compare the requested state with an observation made after the recorded execution."""
    if req["decision"] != "approved" or req["execution"] != "completed":
        return "not_applicable"
    if obs["state"] == "unknown" or not obs["observed_at"] or obs["observed_at"] <= req["executed_at"]:
        return "awaiting"
    if req["type"] == "grant" and req["requested_access"]:
        return "unavailable"  # account presence does not prove a specific role or licence
    return "matched" if obs["state"] == ("present" if req["type"] == "grant" else "absent") else "mismatch"


def with_request_state(conn, reqs):
    cutoff = stale_before()
    for r in reqs:
        r["observed"] = observed_access(conn, r["person_id"], r["app_id"], cutoff)
        r["verification"] = verification(r, r["observed"])
    return reqs


def with_account_state(accounts):
    cutoff = stale_before()
    for a in accounts:
        removed = a["state"] == "removed"
        a["observed"] = "absent" if removed else "present"
        a["observed_at"] = a["removed_at"] if removed else a["last_seen"]
        a["freshness"] = freshness(a["source"], a["observed_at"], cutoff)
        a["risky_scopes"] = risky_scopes(json.loads(a["scopes"])) if a["scopes"] else []
    return accounts


def usage_summary(u):
    return {"coverage": u["coverage"], "since": u["since"], "active": u["active"], "people": u["people"]}


def with_app_usage(conn, apps):
    usage = discovery.app_usage(conn, ago(config.INACTIVITY_DAYS), [a["id"] for a in apps])
    for a in apps:
        a["usage"] = usage_summary(usage[a["id"]])
    return apps


def with_account_usage(conn, accounts):
    """Usage state of the person on that app (all evidence combined), so each row shows whether access is used."""
    usage = discovery.app_usage(conn, ago(config.INACTIVITY_DAYS), sorted({a["app_id"] for a in accounts}))
    for a in accounts:
        key = a["person_id"] if a["person_id"] is not None else f"acc{a['id']}"
        u = usage[a["app_id"]]
        a["usage"] = {"state": u["states"].get(key, "unknown"), "last": u["last"].get(key), "since": u["since"]}
    return accounts


def with_license_state(conn, subs):
    usage = discovery.app_usage(conn, ago(config.INACTIVITY_DAYS), sorted({s["app_id"] for s in subs}))
    for s in subs:
        u = usage[s["app_id"]]
        # Usage counts only mean something with a full window of history; otherwise say since when it is observed.
        s["usage_coverage"], s["usage_since"] = u["coverage"], u["since"]
        if u["coverage"] == "none":
            s["active"] = None
        cost = annual_cost(s)
        billed = s["quantity"] if s["quantity"] is not None else s["assigned"]
        s["annual_cost"] = cost * billed if cost is not None else None
    return subs


GOOGLE_CAPS = ["Users, aliases and suspension status", "Third-party OAuth grants per user",
               "OAuth app usage and SAML sign-ins (audit reports)", "Workspace licence assignments"]
PERSONIO_CAPS = ["Employees with status, hire and leaving dates", "Department, position and supervisor",
                 "Leavers whose accounts are still active", "Accounts with no HR record"]
PERSONIO_PERMISSIONS = ["Employees: read", "Attributes: email, status, hire_date, termination_date, last_working_day,"
                        " department, position, supervisor, first_name, last_name, preferred_name"]
ENTRA_CAPS = ["Users and guests", "Last sign-in per user (Entra ID P1)", "Licence SKUs and assignments",
              "Enterprise apps and SSO assignments (group-expanded)", "Delegated OAuth consents",
              "Sign-in logs (Entra ID P1)"]


def integrations_state(conn):
    cutoff, out = stale_before(), []
    for name, label, configured, caps, perms in (
            ("google", "Google Workspace", config.google_sync, GOOGLE_CAPS,
             GOOGLE_SCOPES + (offboarding.GOOGLE_WRITE_SCOPES if config.google_write else [])),
            ("entra", "Microsoft Entra ID", config.entra_sync, ENTRA_CAPS,
             ENTRA_PERMISSIONS + (offboarding.ENTRA_WRITE_PERMISSIONS if config.entra_write else [])),
            ("personio", "Personio (HR)", config.personio_sync, PERSONIO_CAPS, PERSONIO_PERMISSIONS)):
        st = conn.execute("SELECT * FROM integration_state WHERE name = ?", (name,)).fetchone()
        run = conn.execute("SELECT * FROM sync_run WHERE integration = ? ORDER BY id DESC LIMIT 1", (name,)).fetchone()
        enabled = configured or (config.DEMO_MODE and st is not None)
        error = st["last_error"] if st else None
        if not enabled:
            connection = "not_configured"
        elif error and error.startswith("NotAuthorized"):
            connection = "reauth_required"
        else:
            connection = "connected"
        if not run:
            sync = "not_synced"
        elif run["status"] == "running":
            sync = "syncing"
        elif run["status"] == "error":
            sync = "failed"
        else:
            sync = "partial" if json.loads(run["warnings"] or "[]") else "successful"
        last_success = st["last_success_at"] if st else None
        fresh = "unknown" if not last_success else "current" if last_success >= cutoff else "stale"
        out.append({
            "name": name, "label": label, "connection": connection, "sync": sync, "freshness": fresh,
            "last_success_at": last_success, "last_error": error,
            "last_run": dict(run) if run else None, "capabilities": {"read": caps, "write": [label for _, label, system in offboarding.STEPS
                                                      if system == name and offboarding.configured(system)]},
            "permissions": perms, "demo_fixture": enabled and not configured,
            "needs_attention": enabled and (connection != "connected" or sync in ("failed", "partial", "not_synced")
                                            or fresh == "stale"),
        })
    return out


# ---------------------------------------------------------------- session

@router.get("/auth/methods")
def auth_methods():
    return {"google": config.google_login, "microsoft": config.entra_login, "demo": config.DEMO_MODE}


@router.get("/session")
def session(user=Depends(reader)):
    return {"email": user.email, "role": user.role, "csrf": user.csrf, "demo": config.DEMO_MODE,
            "workflows": config.WORKFLOWS, "security_officer": actions.is_officer(user)}


@router.post("/auth/demo")
def demo_login(request: Request, body: DemoLogin):
    if not config.DEMO_MODE:
        raise HTTPException(404, "Not found.")
    if request.headers.get("x-requested-with") != "fetch":  # custom header: forces a preflight cross-site
        raise HTTPException(403, "Missing request header.")
    email = f"demo.{body.role}@example.com"
    with connect() as conn, conn:
        conn.execute("INSERT OR IGNORE INTO user_role (email, role, granted_by, granted_at) VALUES (?, ?, 'demo', ?)",
                     (email, body.role, db.now()))
        db.audit(conn, email, "auth.login", "user", email, {"provider": "demo"})
    auth.start_session(request, email, "demo")
    return {"ok": True}


@router.post("/auth/logout")
def logout(request: Request, user=Depends(member)):
    with connect() as conn, conn:
        db.audit(conn, user.email, "auth.logout")
    auth.end_session(request)
    return {"ok": True}


# ---------------------------------------------------------------- overview

@router.get("/overview")
def overview(user=Depends(reader)):
    with connect() as conn:
        integ = integrations_state(conn)
        sql, args = q_requests({"decision": "pending"})
        pending = with_request_state(conn, rows(conn, f"SELECT * FROM ({sql}) ORDER BY requested_at LIMIT 6", *args))
        return {
            "cards": {
                "applications": conn.execute("SELECT COUNT(*) FROM app WHERE status != 'ignored'").fetchone()[0],
                "people": conn.execute("SELECT COUNT(*) FROM person WHERE kind = 'employee' AND status = 'active'").fetchone()[0],
                "pending_requests": conn.execute(
                    "SELECT COUNT(*) FROM access_request WHERE decision = 'pending'").fetchone()[0],
                "integration_issues": sum(i["needs_attention"] for i in integ),
                "integrations_enabled": sum(i["connection"] != "not_configured" for i in integ),
            },
            "pending_requests": pending,
            "integrations": integ,
            "findings": rows(conn, f"SELECT * FROM ({q_issues({})[0]}) ORDER BY severity_rank, opened_at DESC LIMIT 8",
                             *q_issues({})[1]),
            "findings_total": conn.execute("SELECT COUNT(*) FROM issue WHERE status = 'open'").fetchone()[0],
            "top_apps": rows(conn, f"SELECT id, name, people FROM ({q_applications({})[0]}) WHERE people > 0"
                                   " ORDER BY people DESC, name LIMIT 10"),
            "generated_at": db.now(),
        }


# ---------------------------------------------------------------- applications

@router.get("/applications")
def applications(request: Request, user=Depends(reader)):
    with connect() as conn:
        data, total = list_resource(conn, "applications", request)
        data = with_app_usage(conn, data)
        sources = [r[0] for r in conn.execute("SELECT DISTINCT source FROM app_source ORDER BY source")]
        categories = [r[0] for r in conn.execute("SELECT DISTINCT category FROM app WHERE COALESCE(category, '') != ''"
                                                 " ORDER BY category COLLATE NOCASE")]
    return {"data": data, "total": total, "sources": sources, "categories": categories,
            "no_category": NO_CATEGORY, "inactivity_days": config.INACTIVITY_DAYS}


def _connector_of(source, external_id):
    key = f"{source}:{external_id}"
    return "google" if "google" in key else "entra" if ("entra" in key or "microsoft" in key) else None


@router.get("/applications/{app_id}")
def application(app_id: int, user=Depends(reader)):
    cutoff = stale_before()
    with connect() as conn:
        app = dict(one(conn, "SELECT * FROM app WHERE id = ?", app_id))
        sources = rows(conn, "SELECT * FROM app_source WHERE app_id = ? ORDER BY source", app_id)
        for s in sources:
            s["freshness"] = freshness(_connector_of(s["source"], s["external_id"]), s["last_seen"], cutoff)
        summary = with_app_usage(conn, [dict(one(conn, f"SELECT * FROM ({q_applications({'status': 'all'})[0]}) WHERE id = ?",
                                                 app_id))])[0]
        lic_sql, lic_args = q_licenses({"app_id": app_id})
        return {
            "app": app, "sources": sources, "summary": summary,
            "licenses": with_license_state(conn, rows(conn, f"SELECT * FROM ({lic_sql})", *lic_args)),
            "issues": rows(conn, f"SELECT * FROM ({q_issues({'status': 'all', 'app_id': app_id})[0]})"
                                 " WHERE status != 'resolved' ORDER BY severity_rank", app_id),
            "events": rows(conn, "SELECT * FROM audit_event WHERE target_type = 'app' AND target_id = ?"
                                 " ORDER BY id DESC LIMIT 50", str(app_id)),
            "merge_targets": rows(conn, "SELECT id, name FROM app WHERE id != ? ORDER BY name", app_id),
            "freshness_policy": FRESHNESS_POLICY, "inactivity_days": config.INACTIVITY_DAYS,
        }


ICON_TYPES = {"image/png", "image/x-icon", "image/vnd.microsoft.icon", "image/jpeg", "image/gif", "image/webp"}


def _fetch_icon(domain):
    """Favicon via Google's favicon service: Google already holds this tenant's app inventory as the IdP, and the
    server only ever calls this one fixed host (no request goes to an address taken from discovered data).
    SVG is refused because it can carry script."""
    try:
        r = requests.get("https://www.google.com/s2/favicons", params={"domain": domain, "sz": 64}, timeout=(5, 10))
    except requests.RequestException:
        return None, None
    ctype = r.headers.get("Content-Type", "").split(";")[0].strip()
    if r.status_code != 200 or ctype not in ICON_TYPES or not 0 < len(r.content) <= 100_000:
        return None, None  # 404 = Google has no icon for the domain
    return r.content, ctype


@router.get("/applications/{app_id}/icon")
def application_icon(app_id: int, user=Depends(reader)):
    with connect() as conn:
        website = one(conn, "SELECT website FROM app WHERE id = ?", app_id)["website"]
        domain = (urlparse(website).hostname or "").lower() if website else ""
        cached = conn.execute("SELECT * FROM app_icon WHERE app_id = ?", (app_id,)).fetchone()
    if not domain:
        raise HTTPException(404)
    if cached and cached["domain"] == domain and (cached["data"] or cached["fetched_at"] > ago(30)):
        data, ctype = cached["data"], cached["content_type"]
    else:  # network call outside any transaction; a missing icon is retried after 30 days
        data, ctype = _fetch_icon(domain)
        with connect() as conn, conn:
            conn.execute("INSERT OR REPLACE INTO app_icon (app_id, domain, data, content_type, fetched_at)"
                         " VALUES (?,?,?,?,?)", (app_id, domain, data, ctype, db.now()))
    if not data:
        raise HTTPException(404)
    return Response(data, media_type=ctype, headers={"Cache-Control": "private, max-age=86400"})


@router.patch("/applications/{app_id}")
def application_update(app_id: int, body: AppPatch, user=Depends(admin)):
    new = body.model_dump()
    with connect() as conn, conn:
        old = one(conn, "SELECT * FROM app WHERE id = ?", app_id)
        changes = {k: {"from": old[k], "to": v} for k, v in new.items() if old[k] != v}
        if changes:
            conn.execute(f"UPDATE app SET {', '.join(f'{k} = ?' for k in new)}, updated_at = ? WHERE id = ?",
                         (*new.values(), db.now(), app_id))
            db.audit(conn, user.email, "app.updated", "app", app_id, {"name": old["name"], "changes": changes})
            discovery.reconcile(conn, db.now())
    return {"changed": sorted(changes)}


@router.post("/applications/bulk-status")
def applications_bulk_status(body: BulkStatus, user=Depends(admin)):
    """Applies to exactly the listed ids. Each target commits on its own, so one failure never undoes another.
    Setting a status is idempotent, so re-sending the same request cannot create duplicate changes."""
    results = []
    with connect() as conn:
        for app_id in dict.fromkeys(body.ids):
            with conn:
                row = conn.execute("SELECT name, status FROM app WHERE id = ?", (app_id,)).fetchone()
                if not row:
                    results.append({"id": app_id, "outcome": "failed", "message": "Application no longer exists."})
                elif row["status"] == body.status:
                    results.append({"id": app_id, "name": row["name"], "outcome": "unchanged",
                                    "message": f"Already {body.status}."})
                else:
                    conn.execute("UPDATE app SET status = ?, updated_at = ? WHERE id = ?", (body.status, db.now(), app_id))
                    db.audit(conn, user.email, "app.updated", "app", app_id,
                             {"name": row["name"], "changes": {"status": {"from": row["status"], "to": body.status}},
                              "bulk": True})
                    results.append({"id": app_id, "name": row["name"], "outcome": "completed", "message": None})
        with conn:
            discovery.reconcile(conn, db.now())
    return {"status": body.status, "results": results}


@router.post("/applications/{app_id}/merge")
def application_merge(app_id: int, body: Merge, user=Depends(admin)):
    with connect() as conn:
        try:
            with conn:
                one(conn, "SELECT id FROM app WHERE id = ?", app_id)
                one(conn, "SELECT id FROM app WHERE id = ?", body.target_id)
                discovery.merge_apps(conn, user.email, app_id, body.target_id)
        except ValueError as e:
            raise HTTPException(400, str(e))
    return {"id": body.target_id}


@router.get("/accounts")
def accounts(request: Request, user=Depends(reader)):
    with connect() as conn:
        data, total = list_resource(conn, "accounts", request)
        data = with_account_usage(conn, with_account_state(data))
    return {"data": data, "total": total, "freshness_policy": FRESHNESS_POLICY, "inactivity_days": config.INACTIVITY_DAYS}


# ---------------------------------------------------------------- people

@router.get("/people")
def people(request: Request, user=Depends(reader)):
    with connect() as conn:
        data, total = list_resource(conn, "people", request)
    return {"data": data, "total": total}


@router.get("/people/{person_id}")
def person(person_id: int, user=Depends(reader)):
    with connect() as conn:
        p = dict(one(conn, "SELECT * FROM person WHERE id = ?", person_id))
        sql, args = q_requests({"person_id": person_id})
        return {
            "person": p,
            "emails": [r[0] for r in conn.execute("SELECT email FROM person_email WHERE person_id = ? ORDER BY email",
                                                  (person_id,))],
            "hr": rows(conn, f"SELECT * FROM hr_record h WHERE person_id = ? ORDER BY h.removed_at IS NOT NULL, {HR_ORDER}", person_id),
            "requests": with_request_state(conn, rows(conn, f"SELECT * FROM ({sql}) ORDER BY requested_at DESC", *args)),
            "issues": rows(conn, f"SELECT * FROM ({q_issues({'status': 'all'})[0]}) WHERE person_id = ?"
                                 " AND status != 'resolved' ORDER BY severity_rank", person_id),
            "freshness_policy": FRESHNESS_POLICY,
            "offboarding": offboarding_state(conn, p),
            "security_actions": security_action_state(conn, p, user),
        }


def security_action_state(conn, p, user):
    if not config.ACTIONS:
        return None
    return {"kinds": actions.KINDS, "needs_target": sorted(actions.NEEDS_TARGET),
            "targets": actions.targets(conn, p) if actions.is_officer(user) else {},
            "expiry_hours": actions.EXPIRY_HOURS,
            "history": rows(conn, "SELECT * FROM security_action WHERE person_id = ? ORDER BY id DESC LIMIT 100", p["id"])}


@router.post("/people/{person_id}/security-actions")
def security_action_request(person_id: int, body: ActionIn, user=Depends(officer)):
    """Records a pending action. It runs only when a different officer approves it."""
    with connect() as conn, conn:
        p = dict(one(conn, "SELECT * FROM person WHERE id = ?", person_id))
        if not p["google_id"]:
            raise HTTPException(422, "This person has no Google account.")
        if body.confirm.strip().lower() != p["email"]:
            raise HTTPException(422, f"Type {p['email']} to confirm.")
        target = None
        if body.kind in actions.NEEDS_TARGET:
            if body.target not in {t["id"] for t in actions.targets(conn, p)[body.kind]}:
                raise HTTPException(422, "Choose one of the listed targets.")
            target = body.target
        aid = conn.execute("INSERT INTO security_action (person_id, kind, target, reason, requested_by, requested_at)"
                           " VALUES (?,?,?,?,?,?) RETURNING id",
                           (person_id, body.kind, target, body.reason.strip(), user.email, db.now())).fetchone()[0]
        db.audit(conn, user.email, "security_action.requested", "person", str(person_id),
                 {"id": aid, "kind": body.kind, "target": target, "reason": body.reason.strip()})
    return {"id": aid}


def _pending_action(conn, action_id):
    a = dict(one(conn, "SELECT * FROM security_action WHERE id = ?", action_id))
    if a["status"] != "pending":
        raise HTTPException(409, "This action is no longer pending.")
    return a


@router.post("/security-actions/{action_id}/approve")
async def security_action_approve(action_id: int, user=Depends(officer)):
    with connect() as conn:
        a = _pending_action(conn, action_id)
        if a["requested_by"] == user.email:
            raise HTTPException(403, "A different security officer must approve this action.")
        if a["requested_at"] < ago(actions.EXPIRY_HOURS / 24):
            raise HTTPException(409, f"Requests expire after {actions.EXPIRY_HOURS} hours. Request it again.")
        p = dict(one(conn, "SELECT * FROM person WHERE id = ?", a["person_id"]))
    try:
        status, result = await run_in_threadpool(actions.approve, db.connect, a, p, user.email)
    except actions.StepError as e:
        raise HTTPException(409, str(e))
    return {"status": status, "result": result}


@router.post("/security-actions/{action_id}/reject")
def security_action_reject(action_id: int, user=Depends(admin)):
    """Any officer (including the requester, to withdraw it) may reject. No re-sign-in needed to stop something."""
    if not config.ACTIONS or not actions.is_officer(user):
        raise HTTPException(403, "Security officer role required.")
    with connect() as conn, conn:
        a = _pending_action(conn, action_id)
        conn.execute("UPDATE security_action SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?",
                     (user.email, db.now(), action_id))
        db.audit(conn, user.email, "security_action.rejected", "person", str(a["person_id"]), {"id": action_id})
    return {"ok": True}


def offboarding_state(conn, p):
    hr = conn.execute(f"SELECT supervisor_email FROM hr_record h WHERE person_id = ? AND removed_at IS NULL"
                      f" ORDER BY {HR_ORDER} LIMIT 1", (p["id"],)).fetchone()
    return {"steps": offboarding.available_steps(p),
            "default_recipient": p["manager_email"] or (hr["supervisor_email"] if hr else None),
            "history": rows(conn, "SELECT occurred_at, actor, action, detail FROM audit_event WHERE target_type = 'person'"
                                  " AND target_id = ? AND action LIKE 'offboarding.%' ORDER BY id DESC LIMIT 100",
                            str(p["id"]))}


@router.post("/people/{person_id}/offboard", dependencies=[Depends(workflows_on)])
def person_offboard(person_id: int, body: OffboardIn, user=Depends(admin)):
    """Runs the chosen steps now, in a fixed order, stopping at the first failure. Never triggered automatically."""
    with connect() as conn:
        p = dict(one(conn, "SELECT * FROM person WHERE id = ?", person_id))
        recipient = None
        if body.recipient_email:  # internal people only, so mail and files can never leave the company
            r = conn.execute("SELECT p.* FROM person p JOIN person_email e ON e.person_id = p.id WHERE e.email = ?",
                             (body.recipient_email,)).fetchone()
            if not r or not r["google_id"] or r["status"] != "active" or r["id"] == person_id:
                raise HTTPException(422, f"{body.recipient_email} is not another active person with a Google account.")
            recipient = dict(r)
    if body.confirm.strip().lower() != p["email"]:
        raise HTTPException(422, f"Type {p['email']} to confirm.")
    unavailable = [s["label"] for s in offboarding.available_steps(p) if s["key"] in body.steps and not s["available"]]
    if unavailable:
        raise HTTPException(422, f"These steps cannot run for this person: {', '.join(unavailable)}.")
    if "suspend" in body.steps and offboarding.MAIL_STEPS & set(body.steps):
        raise HTTPException(422, "Google bounces mail sent to a suspended account, so forwarding and the out-of-office"
                                 " reply would stop working. Run them now and suspend in a later run.")
    if offboarding.NEEDS_RECIPIENT & set(body.steps) and not recipient:
        raise HTTPException(422, "Forwarding mail and transferring Drive files need a recipient.")
    message = _text(body.message, 2000)
    if "out_of_office" in body.steps and not message:
        raise HTTPException(422, "Write the out-of-office message.")
    try:
        results = offboarding.run(p, set(body.steps), recipient, message, user.email)
    except offboarding.StepError as e:
        raise HTTPException(409, str(e))
    return {"results": results}


# ---------------------------------------------------------------- licences

@router.get("/licenses")
def licenses(request: Request, user=Depends(reader)):
    with connect() as conn:
        data, total = list_resource(conn, "licenses", request)
        data = with_license_state(conn, data)
    return {"data": data, "total": total, "inactivity_days": config.INACTIVITY_DAYS}


@router.get("/licenses/{sub_id}")
def license_detail(sub_id: int, user=Depends(reader)):
    with connect() as conn:
        sql, args = q_licenses({})
        sub = with_license_state(conn, [dict(one(conn, f"SELECT * FROM ({sql}) WHERE id = ?", *args, sub_id))])[0]
        seats = [dict(r) for r in discovery.seats(conn, sub_id)]
        return {"license": sub, "seats": seats, "has_activity": sub["usage_coverage"] != "none",
                "inactivity_days": config.INACTIVITY_DAYS, "cutoff": ago(config.INACTIVITY_DAYS)}


@router.post("/licenses")
def license_create(body: LicenseCreate, user=Depends(admin)):
    fields = body.model_dump(exclude={"app_id", "name"})
    with connect() as conn, conn:
        one(conn, "SELECT id FROM app WHERE id = ?", body.app_id)
        sub_id = conn.execute(
            "INSERT INTO subscription (app_id, name, source, quantity, unit_cost, currency, billing_period, renewal_date,"
            " owner_email, notes) VALUES (?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?)",
            (body.app_id, body.name.strip(), *fields.values())).lastrowid
        db.audit(conn, user.email, "subscription.created", "subscription", sub_id,
                 {"app_id": body.app_id, "name": body.name, **fields})
        discovery.reconcile(conn, db.now())
    return {"id": sub_id}


@router.patch("/licenses/{sub_id}")
def license_update(sub_id: int, body: LicenseIn, user=Depends(admin)):
    fields = body.model_dump(exclude={"name"})
    with connect() as conn, conn:
        old = one(conn, "SELECT * FROM subscription WHERE id = ?", sub_id)
        if old["source"] != "manual":  # purchased quantity is authoritative from the source
            fields["quantity"] = old["quantity"]
        changes = {k: {"from": old[k], "to": v} for k, v in fields.items() if old[k] != v}
        if changes:
            conn.execute(f"UPDATE subscription SET {', '.join(f'{k} = ?' for k in fields)} WHERE id = ?",
                         (*fields.values(), sub_id))
            db.audit(conn, user.email, "subscription.updated", "subscription", sub_id, {"name": old["name"], "changes": changes})
            discovery.reconcile(conn, db.now())
    return {"changed": sorted(changes)}


@router.delete("/licenses/{sub_id}")
def license_delete(sub_id: int, user=Depends(admin)):
    with connect() as conn, conn:
        old = one(conn, "SELECT * FROM subscription WHERE id = ?", sub_id)
        if old["source"] != "manual":
            raise HTTPException(400, "Only manually created plans can be deleted.")
        conn.execute("DELETE FROM subscription WHERE id = ?", (sub_id,))
        db.audit(conn, user.email, "subscription.deleted", "subscription", sub_id, dict(old))
        discovery.reconcile(conn, db.now())
    return {"ok": True}


# ---------------------------------------------------------------- access requests

@router.get("/requests", dependencies=[Depends(workflows_on)])
def requests_list(request: Request, user=Depends(reader)):
    with connect() as conn:
        data, total = list_resource(conn, "requests", request)
        return {"data": with_request_state(conn, data), "total": total}


@router.get("/requests/{req_id}", dependencies=[Depends(workflows_on)])
def request_detail(req_id: int, user=Depends(reader)):
    with connect() as conn:
        sql, args = q_requests({})
        req = with_request_state(conn, [dict(one(conn, f"SELECT * FROM ({sql}) WHERE id = ?", *args, req_id))])[0]
        events = rows(conn, "SELECT * FROM audit_event WHERE target_type = 'request' AND target_id = ? ORDER BY id",
                      str(req_id))
        return {"request": req, "events": events, "freshness_policy": FRESHNESS_POLICY,
                "execution_capability": "unsupported"}


@router.post("/requests", dependencies=[Depends(workflows_on)])
def request_create(body: RequestIn, user=Depends(admin)):
    with connect() as conn, conn:
        person_ = one(conn, "SELECT email FROM person WHERE id = ?", body.person_id)
        app = one(conn, "SELECT name FROM app WHERE id = ?", body.app_id)
        req_id = conn.execute(
            "INSERT INTO access_request (person_id, app_id, type, requested_access, justification, requested_by,"
            " requested_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (body.person_id, body.app_id, body.type, body.requested_access, body.justification.strip(), user.email,
             db.now())).lastrowid
        db.audit(conn, user.email, "request.created", "request", req_id,
                 {"type": body.type, "person": person_["email"], "app": app["name"],
                  "requested_access": body.requested_access})
    return {"id": req_id}


def _transition(user, req_id, sql, args, action, detail, conflict):
    with connect() as conn, conn:
        one(conn, "SELECT id FROM access_request WHERE id = ?", req_id)
        if conn.execute(sql, (*args, req_id)).rowcount != 1:
            raise HTTPException(409, conflict)
        db.audit(conn, user.email, action, "request", req_id, detail)
    return request_detail(req_id, user)


@router.post("/requests/{req_id}/decision", dependencies=[Depends(workflows_on)])
def request_decide(req_id: int, body: DecisionIn, user=Depends(admin)):
    return _transition(user, req_id, "UPDATE access_request SET decision = ?, decided_by = ?, decided_at = ?,"
                       " decision_note = ? WHERE decision = 'pending' AND id = ?",
                       (body.decision, user.email, db.now(), _text(body.note, 2000)),
                       f"request.{body.decision}", {"note": body.note},
                       "This request has already been decided or cancelled. Reload to see its current state.")


@router.post("/requests/{req_id}/execution", dependencies=[Depends(workflows_on)])
def request_execution(req_id: int, body: ExecutionIn, user=Depends(admin)):
    """Records the outcome of a change made by hand in the source system; nothing is executed here."""
    if body.outcome == "failed" and not _text(body.note, 2000):
        raise HTTPException(422, "Describe what failed.")
    return _transition(user, req_id, "UPDATE access_request SET execution = ?, executed_by = ?, executed_at = ?,"
                       " execution_note = ? WHERE decision = 'approved' AND execution != 'completed' AND id = ?",
                       (body.outcome, user.email, db.now(), _text(body.note, 2000)),
                       f"request.execution_{body.outcome}", {"note": body.note},
                       "Execution can only be recorded for an approved request that is not completed yet.")


@router.post("/requests/{req_id}/cancel", dependencies=[Depends(workflows_on)])
def request_cancel(req_id: int, user=Depends(admin)):
    return _transition(user, req_id, "UPDATE access_request SET decision = 'cancelled', decided_by = ?, decided_at = ?"
                       " WHERE decision = 'pending' AND id = ?", (user.email, db.now()),
                       "request.cancelled", None, "Only pending requests can be cancelled.")


@router.get("/options")
def options(user=Depends(reader)):
    """Small id/name lists for form selects. Fine for a few thousand records."""
    with connect() as conn:
        return {"apps": rows(conn, "SELECT id, name, status FROM app ORDER BY name"),
                "people": rows(conn, "SELECT id, name, email, status FROM person ORDER BY COALESCE(name, email)")}


# ---------------------------------------------------------------- issues

@router.get("/issues")
def issues(request: Request, user=Depends(reader)):
    with connect() as conn:
        data, total = list_resource(conn, "issues", request)
        kinds = dict(conn.execute("SELECT kind, COUNT(*) FROM issue WHERE status = 'open' GROUP BY kind").fetchall())
    return {"data": data, "total": total, "open_by_kind": kinds}


@router.post("/issues/{issue_id}/accept")
def issue_accept(issue_id: int, body: AcceptIn, user=Depends(admin)):
    with connect() as conn, conn:
        issue = one(conn, "SELECT * FROM issue WHERE id = ?", issue_id)
        conn.execute("UPDATE issue SET status = 'accepted', accepted_reason = ?, accepted_by = ?, accepted_until = ?"
                     " WHERE id = ?", (body.reason.strip(), user.email, body.until, issue_id))
        db.audit(conn, user.email, "issue.accepted", "issue", issue_id,
                 {"title": issue["title"], "reason": body.reason, "until": body.until})
    return {"ok": True}


@router.post("/issues/{issue_id}/reopen")
def issue_reopen(issue_id: int, user=Depends(admin)):
    with connect() as conn, conn:
        issue = one(conn, "SELECT * FROM issue WHERE id = ?", issue_id)
        conn.execute("UPDATE issue SET status = 'open', accepted_until = NULL WHERE id = ?", (issue_id,))
        db.audit(conn, user.email, "issue.reopened", "issue", issue_id, {"title": issue["title"]})
        discovery.reconcile(conn, db.now())
    return {"ok": True}


# ---------------------------------------------------------------- integrations & import

@router.get("/integrations")
def integrations(user=Depends(reader)):
    with connect() as conn:
        return {"integrations": integrations_state(conn),
                "runs": rows(conn, "SELECT * FROM sync_run ORDER BY id DESC LIMIT 20"),
                "running": discovery._lock.locked(), "interval_hours": config.SYNC_INTERVAL_HOURS,
                "freshness_policy": FRESHNESS_POLICY, "google_admin": config.GOOGLE_ADMIN_EMAIL or None,
                "entra_tenant": config.ENTRA_TENANT_ID or None}


@router.post("/integrations/sync")
async def sync_now(user=Depends(admin)):
    if discovery._lock.locked():
        raise HTTPException(409, "A sync is already running.")
    if not discovery.configured_integrations():
        raise HTTPException(400, "No connector is configured. Add Google or Entra credentials in .env first.")
    asyncio.get_running_loop().run_in_executor(None, discovery.run_sync, user.email)
    return {"started": True}


@router.post("/import")
async def import_csv(request: Request, user=Depends(admin)):
    form = await request.form(max_files=1, max_fields=10)
    upload = form.get("file")
    if not hasattr(upload, "read"):
        raise HTTPException(422, "Choose a CSV file.")
    data = await upload.read(5 * 1024 * 1024 + 1)
    if len(data) > 5 * 1024 * 1024:
        raise HTTPException(413, "File too large (max 5 MB).")
    new_name = (form.get("new_app") or "").strip()[:200]

    def work():
        with connect() as conn:
            try:
                with conn:
                    if new_name:
                        app_id = discovery.ensure_app(conn, db.now(), "manual", discovery.norm(new_name), new_name)
                    else:
                        try:
                            app_id = one(conn, "SELECT id FROM app WHERE id = ?", int(form.get("app_id") or 0))[0]
                        except ValueError:
                            raise HTTPException(422, "Choose an application.")
                    imported, skipped = discovery.import_csv(conn, user.email, app_id,
                                                             (upload.filename or "upload.csv")[:200], data)
            except ValueError as e:
                raise HTTPException(422, str(e))
        return {"app_id": app_id, "imported": imported, "skipped": skipped}
    return await run_in_threadpool(work)


# ---------------------------------------------------------------- audit & exports

@router.get("/audit")
def audit_list(request: Request, user=Depends(reader)):
    with connect() as conn:
        data, total = list_resource(conn, "audit", request)
        actions = [r[0] for r in conn.execute("SELECT DISTINCT action FROM audit_event ORDER BY action")]
    return {"data": data, "total": total, "actions": actions}


@router.post("/audit/verify")
def audit_verify(user=Depends(member)):
    with connect() as conn:
        ok, n, bad = db.verify_audit(conn)
        with conn:
            db.audit(conn, user.email, "audit.verified", detail={"ok": ok, "events": n, "first_bad": bad})
    return {"ok": ok, "events": n, "first_bad_event": bad, "checked_at": db.now()}


@router.post("/audit/archive")
def audit_archive(user=Depends(member)):
    """Zip with events.jsonl + manifest.json (SHA-256 of the events file, HMAC signature of the manifest)."""
    with connect() as conn:
        with conn:
            db.audit(conn, user.email, "audit.exported", detail={"scope": "all events"})
        events = rows(conn, "SELECT * FROM audit_event ORDER BY id")
        ok, n, bad = db.verify_audit(conn)
    body = "".join(json.dumps(r, separators=(",", ":")) + "\n" for r in events).encode()
    manifest = {"export_schema_version": "1.0", "generated_at": db.now(), "generated_by": user.email, "format": "jsonl",
                "scope": "all audit events", "row_count": len(events), "file_sha256": hashlib.sha256(body).hexdigest(),
                "first_event_id": events[0]["event_id"] if events else None,
                "last_event_id": events[-1]["event_id"] if events else None,
                "chain_head": events[-1]["hash"] if events else None, "chain_verified": ok,
                "signing": "HMAC-SHA256(AUDIT_SIGNING_KEY)"}
    manifest["signature"] = hmac.new(config.AUDIT_SIGNING_KEY.encode(),
                                     json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode(),
                                     hashlib.sha256).hexdigest()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("events.jsonl", body)
        z.writestr("manifest.json", json.dumps(manifest, indent=2))
    return Response(buf.getvalue(), media_type="application/zip", headers={
        "Content-Disposition": f'attachment; filename="audit-{manifest["generated_at"][:10]}.zip"',
        "X-Export-Count": str(len(events)), "X-Export-Generated-At": manifest["generated_at"]})


def _csv_cell(v):
    s = "" if v is None else str(v)
    return "'" + s if s[:1] in ("=", "+", "-", "@", "\t", "\r") else s  # block spreadsheet formula injection


@router.get("/exports/fields")
def export_fields(user=Depends(reader)):
    return {name: spec[3] for name, spec in RESOURCES.items() if name != "requests" or config.WORKFLOWS}


@router.post("/exports")
def export(body: ExportIn, user=Depends(member)):
    """CSV of every record matching the filters (or exactly the listed ids), never just the loaded page."""
    if body.resource not in RESOURCES or (body.resource == "requests" and not config.WORKFLOWS):
        raise HTTPException(404, "Unknown resource.")
    builder, _, default, allowed = RESOURCES[body.resource]
    fields = [f for f in (body.fields or allowed) if f in allowed]
    if not fields:
        raise HTTPException(422, "Choose at least one field.")
    try:
        sql, args = builder({k: v.strip() for k, v in body.filters.items() if v.strip()})
    except ValueError:
        raise HTTPException(400, "Invalid filter value.")
    if body.ids is not None:
        sql = f"SELECT * FROM ({sql}) WHERE id IN ({','.join('?' * len(body.ids))})"
        args = [*args, *body.ids]
    with connect() as conn:
        cur = conn.execute(f"SELECT {', '.join(fields)} FROM ({sql}) ORDER BY {default}", args)
        out = io.StringIO()
        w = csv.writer(out)
        w.writerow(fields)
        count = 0
        for row in cur:
            w.writerow([_csv_cell(v) for v in row])
            count += 1
        generated = db.now()
        with conn:
            db.audit(conn, user.email, "data.exported", "export", body.resource,
                     {"filters": body.filters, "ids": len(body.ids) if body.ids is not None else None,
                      "fields": fields, "rows": count})
    return Response(out.getvalue(), media_type="text/csv", headers={
        "Content-Disposition": f'attachment; filename="{body.resource}-{generated[:10]}.csv"',
        "X-Export-Count": str(count), "X-Export-Generated-At": generated})


# ---------------------------------------------------------------- user administration

@router.get("/users")
def users(user=Depends(reader)):
    if not user.is_admin:
        raise HTTPException(403, "Administrator role required.")
    with connect() as conn:
        return {"roles": rows(conn, "SELECT * FROM user_role ORDER BY role, email"),
                "bootstrap": config.BOOTSTRAP_ADMINS}


@router.post("/users")
def users_grant(body: RoleIn, user=Depends(admin)):
    if not body.email:
        raise HTTPException(422, "Email is required.")
    with connect() as conn, conn:
        conn.execute("INSERT INTO user_role (email, role, granted_by, granted_at) VALUES (?, ?, ?, ?) ON CONFLICT (email)"
                     " DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by, granted_at = excluded.granted_at",
                     (body.email, body.role, user.email, db.now()))
        db.audit(conn, user.email, "role.granted", "user", body.email, {"role": body.role})
    return {"ok": True}


@router.delete("/users/{email}")
def users_revoke(email: str, user=Depends(admin)):
    email = email.strip().lower()
    if email == user.email:
        raise HTTPException(400, "You cannot revoke your own role.")
    with connect() as conn, conn:
        conn.execute("DELETE FROM user_role WHERE email = ?", (email,))
        conn.execute("DELETE FROM session WHERE email = ?", (email,))
        db.audit(conn, user.email, "role.revoked", "user", email)
    return {"ok": True}
