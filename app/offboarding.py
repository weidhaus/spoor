"""Offboarding: the only code that changes anything in Google Workspace or Entra ID.

Uses its own credentials (GOOGLE_WRITE_SA_FILE, ENTRA_WRITE_CLIENT_*), separate from discovery. Nothing here runs on
its own: an admin picks the steps and confirms by typing the person's email. Steps run in a fixed order and stop at
the first failure; each step is audited with its outcome before the next one starts."""
import secrets
import threading

import httpx2
import requests
from google.auth.exceptions import RefreshError

from . import config, db
from .connectors import G_DIRECTORY, GRAPH, Graph, NotAuthorized, g_session

G_SCOPE_USER = "https://www.googleapis.com/auth/admin.directory.user"
G_SCOPE_SECURITY = "https://www.googleapis.com/auth/admin.directory.user.security"
G_SCOPE_GMAIL_BASIC = "https://www.googleapis.com/auth/gmail.settings.basic"
G_SCOPE_GMAIL_SHARING = "https://www.googleapis.com/auth/gmail.settings.sharing"
G_SCOPE_TRANSFER = "https://www.googleapis.com/auth/admin.datatransfer"
GOOGLE_WRITE_SCOPES = [G_SCOPE_USER, G_SCOPE_SECURITY, G_SCOPE_GMAIL_BASIC, G_SCOPE_GMAIL_SHARING, G_SCOPE_TRANSFER]
ENTRA_WRITE_PERMISSIONS = ["User.EnableDisableAccount.All", "User.RevokeSessions.All"]
GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me/settings"
TRANSFER = "https://admin.googleapis.com/admin/datatransfer/v1"

# (key, label, system). Run order: lock the person out first, set up mail and files, suspend last.
STEPS = [
    ("reset_password", "Reset the Google password to a random value", "google"),
    ("clear_recovery", "Remove recovery email and phone", "google"),
    ("sign_out", "Sign out of all Google sessions", "google"),
    ("revoke_tokens", "Revoke all third-party app access (OAuth grants)", "google"),
    ("entra_disable", "Block Microsoft sign-in (disable the Entra account)", "entra"),
    ("entra_revoke", "Revoke all Microsoft sign-in sessions", "entra"),
    ("out_of_office", "Turn on an out-of-office reply", "google"),
    ("forward_mail", "Forward new mail to the recipient", "google"),
    ("transfer_drive", "Transfer Drive files to the recipient", "google"),
    ("suspend", "Suspend the Google account", "google"),
]
LABEL = {k: label for k, label, _ in STEPS}
SYSTEM = {k: system for k, _, system in STEPS}
NEEDS_RECIPIENT = {"forward_mail", "transfer_drive"}
# Google bounces mail sent to a suspended account, so forwarding and auto-replies would silently stop working.
MAIL_STEPS = {"out_of_office", "forward_mail"}

_running = threading.Lock()  # ponytail: one offboarding at a time; per-person locks if this ever becomes a bottleneck


class StepError(Exception):
    pass


def configured(system):
    return {"google": config.google_write, "entra": config.entra_write}.get(system, False)


def available_steps(person):
    """Every step with whether it can run for this person, and why not."""
    out = []
    for key, label, system in STEPS:
        has_account = person["google_id"] if system == "google" else person["entra_id"]
        reason = (None if configured(system) and has_account else
                  "write access not configured" if not configured(system) else
                  f"no {'Google' if system == 'google' else 'Entra'} account")
        out.append({"key": key, "label": label, "system": system, "available": reason is None, "reason": reason})
    return out


def _google(scope, subject=None):
    return g_session(scope, config.GOOGLE_WRITE_SA_FILE, subject or config.GOOGLE_WRITE_ADMIN_EMAIL)


def _call(s, method, url, **kw):
    try:
        r = s.request(method, url, timeout=(15, 60), **kw)
    except requests.RequestException as e:
        raise StepError(f"Could not reach Google ({type(e).__name__}). Nothing was changed by this step; run it again.")
    except RefreshError as e:
        raise StepError("Google refused the write service account for this scope or user. Check its domain-wide"
                        f" delegation scopes ({e.args[0] if e.args else e}).")
    if r.status_code >= 400:
        try:
            msg = r.json().get("error", {}).get("message", "")
        except ValueError:
            msg = r.text[:200]
        raise StepError(f"HTTP {r.status_code} from {url.split('?')[0]}: {msg}")
    return r.json() if r.content else {}


def _graph(method, path, **kw):
    try:
        r = Graph(config.ENTRA_WRITE_CLIENT_ID, config.ENTRA_WRITE_CLIENT_SECRET).http.request(method, GRAPH + path, **kw)
    except (NotAuthorized, RuntimeError) as e:
        raise StepError(str(e))
    except httpx2.TransportError as e:
        raise StepError(f"Could not reach Microsoft Graph ({type(e).__name__}). Run this step again.")
    if r.status_code >= 400:
        msg = r.json().get("error", {}).get("message", "") if r.content else ""
        raise StepError(f"HTTP {r.status_code} from Microsoft Graph {path}: {msg[:300]}")


def run_step(key, person, primary, recipient, message):
    """Execute one step. Returns a short description of what changed. Raises StepError."""
    gid, user_url = person["google_id"], f"{G_DIRECTORY}/users/{person['google_id']}"
    if key == "reset_password":  # never stored or shown: nobody should sign in again
        _call(_google(G_SCOPE_USER), "PATCH", user_url,
              json={"password": secrets.token_urlsafe(32), "changePasswordAtNextLogin": True})
        return "Password replaced with a random value that nobody knows."
    if key == "clear_recovery":
        _call(_google(G_SCOPE_USER), "PATCH", user_url, json={"recoveryEmail": "", "recoveryPhone": ""})
        return "Recovery email and phone removed."
    if key == "sign_out":
        _call(_google(G_SCOPE_SECURITY), "POST", f"{user_url}/signOut")
        return "Signed out of all web and device sessions."
    if key == "revoke_tokens":
        s = _google(G_SCOPE_SECURITY)
        tokens = _call(s, "GET", f"{user_url}/tokens").get("items", [])
        for t in tokens:
            _call(s, "DELETE", f"{user_url}/tokens/{t['clientId']}")
        return f"Revoked {len(tokens)} app grant(s): {', '.join(t.get('displayText') or t['clientId'] for t in tokens) or 'none'}."
    if key == "entra_disable":
        _graph("PATCH", f"/users/{person['entra_id']}", json={"accountEnabled": False})
        return "Entra account disabled."
    if key == "entra_revoke":
        _graph("POST", f"/users/{person['entra_id']}/revokeSignInSessions")
        return "Microsoft sign-in sessions and refresh tokens revoked."
    if key == "out_of_office":
        _call(_google(G_SCOPE_GMAIL_BASIC, primary), "PUT", f"{GMAIL}/vacation", json={
            "enableAutoReply": True, "responseSubject": "No longer with the company",
            "responseBodyPlainText": message, "restrictToContacts": False, "restrictToDomain": False})
        return "Out-of-office reply turned on."
    if key == "forward_mail":
        s = _google(G_SCOPE_GMAIL_SHARING, primary)
        try:
            fwd = _call(s, "POST", f"{GMAIL}/forwardingAddresses", json={"forwardingEmail": recipient["email"]})
        except StepError as e:
            if "HTTP 409" not in str(e):
                raise
            fwd = _call(s, "GET", f"{GMAIL}/forwardingAddresses/{recipient['email']}")
        if fwd.get("verificationStatus") != "accepted":
            raise StepError(f"Gmail requires {recipient['email']} to confirm the forwarding request first (status:"
                            f" {fwd.get('verificationStatus')}). Run this step again after they confirm.")
        _call(s, "PUT", f"{GMAIL}/autoForwarding",
              json={"enabled": True, "emailAddress": recipient["email"], "disposition": "leaveInInbox"})
        return f"New mail is forwarded to {recipient['email']} (a copy stays in the mailbox)."
    if key == "transfer_drive":
        s = _google(G_SCOPE_TRANSFER)
        apps = _call(s, "GET", f"{TRANSFER}/applications", params={"customerId": "my_customer"}).get("applications", [])
        drive = next((a for a in apps if "Drive" in a.get("name", "")), None)
        if not drive:
            raise StepError(f"Google's data transfer API lists no Drive application (found: {[a.get('name') for a in apps]}).")
        t = _call(s, "POST", f"{TRANSFER}/transfers", json={
            "oldOwnerUserId": gid, "newOwnerUserId": recipient["google_id"],
            "applicationDataTransfers": [{"applicationId": drive["id"], "applicationTransferParams": [
                {"key": "PRIVACY_LEVEL", "value": ["PRIVATE", "SHARED"]}]}]})
        return (f"Drive transfer to {recipient['email']} started (transfer {t.get('id')}, status"
                f" {t.get('overallTransferStatusCode')}). Google emails both when it completes.")
    if key == "suspend":
        _call(_google(G_SCOPE_USER), "PATCH", user_url, json={"suspended": True})
        return "Google account suspended."
    raise StepError(f"Unknown step {key}")


def run(person, steps, recipient, message, actor):
    """Run the chosen steps in STEPS order. Returns one result per step: done | failed | not_run."""
    if not _running.acquire(blocking=False):
        raise StepError("Another offboarding is running. Wait for it to finish.")
    try:
        ordered = [k for k, _, _ in STEPS if k in steps]
        conn = db.connect()
        with conn:
            db.audit(conn, actor, "offboarding.started", "person", person["id"],
                     {"email": person["email"], "steps": ordered, "recipient": recipient and recipient["email"]})
        primary = person["email"]
        if any(SYSTEM[k] == "google" for k in ordered):
            try:  # Gmail impersonation needs the current primary address, which may have changed since the last sync
                primary = _call(_google(G_SCOPE_USER), "GET", f"{G_DIRECTORY}/users/{person['google_id']}",
                                params={"fields": "primaryEmail"})["primaryEmail"]
            except StepError as e:
                with conn:
                    db.audit(conn, actor, "offboarding.failed", "person", person["id"], {"error": str(e)})
                conn.close()
                raise StepError(f"Could not look up the Google account, nothing was changed: {e}")
        results, failed = [], False
        for key in ordered:
            if failed:
                results.append({"step": key, "label": LABEL[key], "status": "not_run", "detail": None})
                continue
            try:
                detail, status = run_step(key, person, primary, recipient, message), "done"
            except StepError as e:
                detail, status, failed = str(e), "failed", True
            results.append({"step": key, "label": LABEL[key], "status": status, "detail": detail})
            with conn:
                db.audit(conn, actor, f"offboarding.step_{status}", "person", person["id"],
                         {"step": key, "label": LABEL[key], "detail": detail})
        conn.close()
        return results
    finally:
        _running.release()
