"""Security actions in Google Workspace: revoke OAuth grants, sign out, delete app passwords, remove/assign licences.

Off unless ACTIONS=true. Only SECURITY_OFFICERS (set in env, never from the UI) who also hold the admin role may use
them. Every action needs two different officers, each freshly re-authenticated with Google: one requests, the other
approves, and approval runs it immediately. Nothing runs on its own. Uses the discovery service account (its
admin.directory.user.security and apps.licensing scopes)."""
from . import config, db
from .connectors import G_DIRECTORY, G_SCOPE_LICENSING, G_SCOPE_TOKENS, g_session
from .offboarding import StepError, _call

KINDS = {
    "revoke_grant": "Revoke one app's OAuth access",
    "revoke_all_sign_out": "Revoke all OAuth access and sign out of all Google sessions",
    "delete_app_passwords": "Delete all app passwords",
    "remove_licence": "Remove a Google Workspace licence",
    "assign_licence": "Assign a Google Workspace licence",
}
NEEDS_TARGET = {"revoke_grant", "remove_licence", "assign_licence"}
EXPIRY_HOURS = 24
STEPUP_SECONDS = 300  # Google sign-in must be this recent when re-authenticating
STEPUP_VALID_SECONDS = 600  # a re-authentication then unlocks actions for this long
LICENSING = "https://licensing.googleapis.com/apps/licensing/v1/product/Google-Apps/sku"


def is_officer(user):
    return config.ACTIONS and user.is_admin and user.email in config.SECURITY_OFFICERS


def targets(conn, person):
    """What each targeted kind may act on for this person: only what discovery has observed, never free text."""
    grants = conn.execute(
        "SELECT DISTINCT substr(a.external_id, 1, instr(a.external_id, ':') - 1) AS id, ap.name FROM account a"
        " JOIN app ap ON ap.id = a.app_id WHERE a.person_id = ? AND a.source = 'google' AND a.kind = 'oauth_grant'"
        " AND a.state = 'active' ORDER BY ap.name", (person["id"],)).fetchall()
    held = conn.execute(
        "SELECT DISTINCT s.external_id AS id, s.name FROM account a JOIN subscription s ON s.id = a.subscription_id"
        " WHERE a.person_id = ? AND a.source = 'google' AND a.kind = 'license' AND a.state = 'active' ORDER BY s.name",
        (person["id"],)).fetchall()
    skus = conn.execute("SELECT external_id AS id, name FROM subscription WHERE source = 'google_license' ORDER BY name").fetchall()
    held_ids = {r["id"] for r in held}
    return {"revoke_grant": [dict(r) for r in grants], "remove_licence": [dict(r) for r in held],
            "assign_licence": [dict(r) for r in skus if r["id"] not in held_ids]}


def _delete_all(s, list_url, key, item_url):
    for item in _call(s, "GET", list_url).get("items", []):
        _call(s, "DELETE", item_url(item[key]))


def execute(kind, person, target):
    """Runs one action in Google. Raises StepError on failure."""
    user = f"{G_DIRECTORY}/users/{person['google_id']}"
    if kind == "revoke_grant":
        _call(g_session(G_SCOPE_TOKENS), "DELETE", f"{user}/tokens/{target}")
    elif kind == "revoke_all_sign_out":
        s = g_session(G_SCOPE_TOKENS)
        _delete_all(s, f"{user}/tokens", "clientId", lambda cid: f"{user}/tokens/{cid}")
        _call(s, "POST", f"{user}/signOut")
    elif kind == "delete_app_passwords":
        s = g_session(G_SCOPE_TOKENS)
        _delete_all(s, f"{user}/asps", "codeId", lambda code: f"{user}/asps/{code}")
    elif kind == "remove_licence":
        _call(g_session(G_SCOPE_LICENSING), "DELETE", f"{LICENSING}/{target}/user/{person['email']}")
    elif kind == "assign_licence":
        _call(g_session(G_SCOPE_LICENSING), "POST", f"{LICENSING}/{target}/user", json={"userId": person["email"]})
    else:
        raise StepError(f"Unknown action {kind}.")


def approve(conn_factory, action, person, actor):
    """Marks the action approved, audits, runs it, and records the outcome. Returns the final status."""
    conn = conn_factory()
    with conn:  # claim it first, so two approvers can never both run it
        claimed = conn.execute("UPDATE security_action SET status = 'running', decided_by = ?, decided_at = ?"
                               " WHERE id = ? AND status = 'pending'", (actor, db.now(), action["id"])).rowcount == 1
        if claimed:
            db.audit(conn, actor, "security_action.approved", "person", str(person["id"]),
                     {"id": action["id"], "kind": action["kind"], "target": action["target"]})
    if not claimed:
        conn.close()
        raise StepError("This action is no longer pending.")
    try:
        execute(action["kind"], person, action["target"])
        status, result = "done", None
    except StepError as e:
        status, result = "failed", str(e)
    except Exception as e:  # the outcome must be recorded whatever happens
        status, result = "failed", f"{type(e).__name__}: {e}"
    with conn:
        conn.execute("UPDATE security_action SET status = ?, result = ? WHERE id = ?", (status, result, action["id"]))
        db.audit(conn, actor, f"security_action.{status}", "person", str(person["id"]),
                 {"id": action["id"], "kind": action["kind"], "target": action["target"], "error": result})
    conn.close()
    return status, result
