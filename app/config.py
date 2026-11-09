"""All settings come from environment variables (see .env.example). Secrets never live in the database."""
import os
from pathlib import Path


def _list(name):
    return [x.strip().lower() for x in os.getenv(name, "").split(",") if x.strip()]


def _bool(name):
    return os.getenv(name, "").lower() in ("1", "true", "yes")


DATA_DIR = Path(os.getenv("DATA_DIR", "./data"))
DB_PATH = DATA_DIR / "saas.db"
SECRET_KEY = os.getenv("SECRET_KEY", "")
AUDIT_SIGNING_KEY = os.getenv("AUDIT_SIGNING_KEY", "")
BASE_URL = os.getenv("BASE_URL", "http://localhost:8000").rstrip("/")
HTTPS = BASE_URL.startswith("https://")
SESSION_HOURS = int(os.getenv("SESSION_HOURS", "12"))
BOOTSTRAP_ADMINS = _list("BOOTSTRAP_ADMINS")
DEMO_MODE = _bool("DEMO_MODE")
# Access requests and offboarding. Off = report-only: their API answers 404 and the UI hides them.
WORKFLOWS = _bool("WORKFLOWS")
# Security actions (app/actions.py). Officers are set here only, never from the UI, and must also hold the admin role.
ACTIONS = _bool("ACTIONS")
SECURITY_OFFICERS = _list("SECURITY_OFFICERS")

# Sign-in (OIDC)
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "")
GOOGLE_ALLOWED_DOMAINS = _list("GOOGLE_ALLOWED_DOMAINS")
ENTRA_TENANT_ID = os.getenv("ENTRA_TENANT_ID", "").lower()
ENTRA_CLIENT_ID = os.getenv("ENTRA_CLIENT_ID", "")
ENTRA_CLIENT_SECRET = os.getenv("ENTRA_CLIENT_SECRET", "")

# Discovery (read-only)
GOOGLE_SA_FILE = os.getenv("GOOGLE_SA_FILE", "")
GOOGLE_ADMIN_EMAIL = os.getenv("GOOGLE_ADMIN_EMAIL", "")
GOOGLE_CUSTOMER_DOMAIN = os.getenv("GOOGLE_CUSTOMER_DOMAIN", "")
ENTRA_SYNC_CLIENT_ID = os.getenv("ENTRA_SYNC_CLIENT_ID", "") or ENTRA_CLIENT_ID
ENTRA_SYNC_CLIENT_SECRET = os.getenv("ENTRA_SYNC_CLIENT_SECRET", "") or ENTRA_CLIENT_SECRET
# Personio API credential (Settings > Integrations > API credentials), read access to employee attributes
PERSONIO_CLIENT_ID = os.getenv("PERSONIO_CLIENT_ID", "")
PERSONIO_CLIENT_SECRET = os.getenv("PERSONIO_CLIENT_SECRET", "")

# Offboarding (write). Separate credentials, so discovery can never change anything. Unset = offboarding disabled.
GOOGLE_WRITE_SA_FILE = os.getenv("GOOGLE_WRITE_SA_FILE", "")
GOOGLE_WRITE_ADMIN_EMAIL = os.getenv("GOOGLE_WRITE_ADMIN_EMAIL", "") or GOOGLE_ADMIN_EMAIL
ENTRA_WRITE_CLIENT_ID = os.getenv("ENTRA_WRITE_CLIENT_ID", "")
ENTRA_WRITE_CLIENT_SECRET = os.getenv("ENTRA_WRITE_CLIENT_SECRET", "")

SYNC_INTERVAL_HOURS = float(os.getenv("SYNC_INTERVAL_HOURS", "6"))
INACTIVITY_DAYS = int(os.getenv("INACTIVITY_DAYS", "90"))
LOOKBACK_DAYS = int(os.getenv("LOOKBACK_DAYS", "30"))
# Extra name fragments (besides your own domain names) that mark a discovered app as built in-house, e.g. "petolo,faircare"
INTERNAL_APP_HINTS = [h.replace("-", "") for h in _list("INTERNAL_APP_HINTS")]

google_login = bool(GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET and GOOGLE_ALLOWED_DOMAINS)
entra_login = bool(ENTRA_TENANT_ID and ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET)
google_sync = bool(GOOGLE_SA_FILE and GOOGLE_ADMIN_EMAIL)
personio_sync = bool(PERSONIO_CLIENT_ID and PERSONIO_CLIENT_SECRET)
entra_sync = bool(ENTRA_TENANT_ID and ENTRA_SYNC_CLIENT_ID and ENTRA_SYNC_CLIENT_SECRET)
google_write = bool(GOOGLE_WRITE_SA_FILE and GOOGLE_WRITE_ADMIN_EMAIL)
entra_write = bool(ENTRA_TENANT_ID and ENTRA_WRITE_CLIENT_ID and ENTRA_WRITE_CLIENT_SECRET)


def validate():
    if len(SECRET_KEY) < 32 or len(AUDIT_SIGNING_KEY) < 32:
        raise SystemExit("SECRET_KEY and AUDIT_SIGNING_KEY must each be at least 32 characters (see README).")
    if DEMO_MODE and (google_login or entra_login or google_sync or entra_sync or personio_sync
                      or google_write or entra_write):
        raise SystemExit("DEMO_MODE cannot be combined with real sign-in or discovery credentials. Use a separate .env.")
    if not (google_login or entra_login or DEMO_MODE):
        raise SystemExit("No sign-in method configured: set Google or Entra OIDC settings (or DEMO_MODE=true).")
    if ACTIONS and not (google_login and google_sync and len(SECURITY_OFFICERS) >= 2):
        raise SystemExit("ACTIONS needs Google sign-in (for re-authentication), Google discovery and at least two"
                         " SECURITY_OFFICERS (every action is approved by a second officer).")
    if google_write and GOOGLE_WRITE_SA_FILE == GOOGLE_SA_FILE:
        raise SystemExit("GOOGLE_WRITE_SA_FILE must be a different service account than GOOGLE_SA_FILE (see README).")
    if entra_write and ENTRA_WRITE_CLIENT_ID in (ENTRA_SYNC_CLIENT_ID, ENTRA_CLIENT_ID):
        raise SystemExit("ENTRA_WRITE_CLIENT_ID must be a separate app registration (see README).")
