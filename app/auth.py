"""OIDC sign-in (Google Workspace, Microsoft Entra), server-side sessions, roles and CSRF."""
import datetime as dt
import hashlib
import hmac
import secrets
from dataclasses import dataclass

from authlib.integrations.starlette_client import OAuth
from fastapi import HTTPException, Request

from . import config, db

oauth = OAuth()
if config.google_login:
    oauth.register("google", client_id=config.GOOGLE_CLIENT_ID, client_secret=config.GOOGLE_CLIENT_SECRET,
                   server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
                   client_kwargs={"scope": "openid email profile", "code_challenge_method": "S256"})
if config.entra_login:
    oauth.register("microsoft", client_id=config.ENTRA_CLIENT_ID, client_secret=config.ENTRA_CLIENT_SECRET,
                   server_metadata_url=f"https://login.microsoftonline.com/{config.ENTRA_TENANT_ID}/v2.0/.well-known/openid-configuration",
                   client_kwargs={"scope": "openid email profile", "code_challenge_method": "S256"})


def verified_email(provider, claims):
    """Return the signed-in email if the (already signature/nonce/issuer-validated) ID token is from our org, else None."""
    if not claims:
        return None
    if provider == "google":
        email = (claims.get("email") or "").lower()
        domain = email.rpartition("@")[2]
        if claims.get("email_verified") is True and claims.get("hd") == domain and domain in config.GOOGLE_ALLOWED_DOMAINS:
            return email
    elif provider == "microsoft":
        # Only our tenant; UPN is admin-controlled, unlike the optional `email` claim (cf. "nOAuth").
        if claims.get("tid", "").lower() == config.ENTRA_TENANT_ID:
            return (claims.get("preferred_username") or "").lower() or None
    return None


def role_of(conn, email):
    if email in config.BOOTSTRAP_ADMINS:
        return "admin"
    row = conn.execute("SELECT role FROM user_role WHERE email = ?", (email,)).fetchone()
    return row[0] if row else None


def _hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def start_session(request: Request, email, provider):
    token = secrets.token_urlsafe(32)
    expires = dt.datetime.now(dt.UTC) + dt.timedelta(hours=config.SESSION_HOURS)
    conn = db.connect()
    with conn:
        conn.execute("DELETE FROM session WHERE expires_at < ?", (db.now(),))
        conn.execute("INSERT INTO session (id_hash, email, provider, csrf, created_at, expires_at) VALUES (?,?,?,?,?,?)",
                     (_hash(token), email, provider, secrets.token_urlsafe(32), db.now(),
                      expires.isoformat(timespec="milliseconds").replace("+00:00", "Z")))
    conn.close()
    request.session.clear()  # drop pre-login state (session fixation)
    request.session["sid"] = token


def mark_stepup(request: Request, email):
    conn = db.connect()
    with conn:
        conn.execute("UPDATE session SET stepup_at = ? WHERE id_hash = ? AND email = ?",
                     (db.now(), _hash(request.session.get("sid", "")), email))
    conn.close()


def end_session(request: Request):
    token = request.session.get("sid")
    if token:
        conn = db.connect()
        with conn:
            conn.execute("DELETE FROM session WHERE id_hash = ?", (_hash(token),))
        conn.close()
    request.session.clear()


@dataclass
class User:
    email: str
    role: str
    csrf: str
    stepup_at: str | None = None

    @property
    def is_admin(self):
        return self.role == "admin"


def current_user(request: Request):
    """Role is re-read on every request, so revoking a role takes effect immediately."""
    token = request.session.get("sid")
    if not token:
        raise HTTPException(303, headers={"Location": "/login"})
    conn = db.connect()
    row = conn.execute("SELECT * FROM session WHERE id_hash = ? AND expires_at > ?", (_hash(token), db.now())).fetchone()
    role = role_of(conn, row["email"]) if row else None
    conn.close()
    if not row:
        request.session.clear()
        raise HTTPException(303, headers={"Location": "/login"})
    if not role:
        raise HTTPException(403, "Your account has no role in this application. Ask an administrator.")
    return User(row["email"], role, row["csrf"], row["stepup_at"])


async def admin_form(request: Request):
    """For every state-changing POST: require admin role and a valid CSRF token. Returns (user, form)."""
    user = current_user(request)
    if not user.is_admin:
        raise HTTPException(403, "Administrator role required.")
    form = await request.form(max_files=1, max_fields=50)
    if not hmac.compare_digest(str(form.get("csrf", "")), user.csrf):
        raise HTTPException(403, "Invalid or missing CSRF token. Reload the page and try again.")
    return user, form
