"""Thin, read-only API clients for Google Workspace, Microsoft Graph and Personio. They only fetch; discovery.py writes.
The only changes ever made to Google or Entra are in offboarding.py, with separate write credentials."""
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import httpx2
import requests
from google.auth.exceptions import RefreshError
from google.auth.transport.requests import AuthorizedSession
from google.oauth2 import service_account

from . import config


class NotAuthorized(Exception):
    """The credential lacks a scope/licence for this optional data set. Sync continues without it."""


def _retry_after(r, attempt):
    try:
        return min(float(r.headers.get("Retry-After", "")), 120)
    except ValueError:
        return min(2 ** attempt * 2, 60)


# ---------------------------------------------------------------- Google Workspace (domain-wide delegation)

G_DIRECTORY = "https://admin.googleapis.com/admin/directory/v1"
G_REPORTS = "https://admin.googleapis.com/admin/reports/v1/activity/users/all/applications"
G_LICENSING = "https://licensing.googleapis.com/apps/licensing/v1/product/Google-Apps/users"

G_SCOPE_USERS = "https://www.googleapis.com/auth/admin.directory.user.readonly"
G_SCOPE_TOKENS = "https://www.googleapis.com/auth/admin.directory.user.security"
G_SCOPE_REPORTS = "https://www.googleapis.com/auth/admin.reports.audit.readonly"
G_SCOPE_LICENSING = "https://www.googleapis.com/auth/apps.licensing"
GOOGLE_SCOPES = [G_SCOPE_USERS, G_SCOPE_TOKENS, G_SCOPE_REPORTS, G_SCOPE_LICENSING]


def g_session(scope, sa_file=None, subject=None):
    creds = service_account.Credentials.from_service_account_file(
        sa_file or config.GOOGLE_SA_FILE, scopes=[scope], subject=subject or config.GOOGLE_ADMIN_EMAIL
    )
    return AuthorizedSession(creds)


RATE_LIMIT_REASONS = {"rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"}


def _google_rate_limited(r):
    """Google signals rate limits with 403 (not 429); only the error reason tells them apart from a denied scope."""
    if r.status_code != 403:
        return False
    try:
        errors = r.json().get("error", {}).get("errors", [])
    except ValueError:
        return False
    return any(e.get("reason") in RATE_LIMIT_REASONS for e in errors)


def g_get(s, url, params=None):
    for attempt in range(6):
        try:
            r = s.get(url, params=params, timeout=(15, 120))
        except RefreshError as e:
            raise NotAuthorized(f"domain-wide delegation does not grant this scope ({e.args[0] if e.args else e})")
        except requests.RequestException:  # timeout or dropped connection: transient, retry with backoff
            if attempt == 5:
                raise
            time.sleep(min(2 ** attempt * 2, 60))
            continue
        if r.status_code in (429, 500, 502, 503, 504) or _google_rate_limited(r):
            time.sleep(_retry_after(r, attempt))
            continue
        if r.status_code in (401, 403):
            raise NotAuthorized(f"HTTP {r.status_code} from {url.split('?')[0]}")
        r.raise_for_status()
        return r.json()
    r.raise_for_status()
    raise RuntimeError(f"Google API kept returning {r.status_code}")


def g_pages(s, url, params, key):
    params = dict(params)
    while True:
        data = g_get(s, url, params)
        yield from data.get(key, [])
        if not data.get("nextPageToken"):
            return
        params["pageToken"] = data["nextPageToken"]


def g_users():
    return g_pages(g_session(G_SCOPE_USERS), f"{G_DIRECTORY}/users",
                   {"customer": "my_customer", "maxResults": 500, "projection": "full"}, "users")


def g_tokens(s, user_id):
    return g_get(s, f"{G_DIRECTORY}/users/{user_id}/tokens").get("items", [])


def g_activities(application, start):
    return g_pages(g_session(G_SCOPE_REPORTS), f"{G_REPORTS}/{application}",
                   {"startTime": start, "maxResults": 1000}, "items")


def g_parallel(scope, fn, items, workers=8):
    """Yield (item, fn(session, item)) in input order, running up to `workers` requests at once.
    Each worker thread gets its own session (requests sessions are not shared across threads)."""
    local = threading.local()

    def one(item):
        if not hasattr(local, "s"):
            local.s = g_session(scope)
        return item, fn(local.s, item)
    with ThreadPoolExecutor(workers) as pool:
        yield from pool.map(one, items)


def g_tokens_all(users):
    """Yield (user, grants) for every user, in parallel."""
    return g_parallel(G_SCOPE_TOKENS, lambda s, u: g_tokens(s, u["id"]), users)


def g_latest_activity(pairs, start):
    """Yield ((user, token), newest 'activity' time since start or None) per grant: one filtered request per grant."""
    def latest(s, pair):
        u, t = pair
        url = G_REPORTS.replace("/users/all/", f"/users/{u['id']}/") + "/token"
        items = g_get(s, url, {"startTime": start, "eventName": "activity",
                               "filters": f"client_id=={t['clientId']}", "maxResults": 1}).get("items", [])
        return items[0]["id"]["time"] if items else None
    return g_parallel(G_SCOPE_REPORTS, latest, pairs)


def g_licenses():
    return g_pages(g_session(G_SCOPE_LICENSING), G_LICENSING,
                   {"customerId": config.GOOGLE_CUSTOMER_DOMAIN, "maxResults": 1000}, "items")


def g_params(event):
    out = {}
    for p in event.get("parameters", []):
        for k in ("value", "multiValue", "intValue", "boolValue"):
            if k in p:
                out[p["name"]] = p[k]
                break
    return out


# ---------------------------------------------------------------- Microsoft Graph (app-only, read permissions)

GRAPH = "https://graph.microsoft.com/v1.0"
ENTRA_PERMISSIONS = ["User.Read.All", "Directory.Read.All", "Application.Read.All", "AuditLog.Read.All"]
# Apps owned by Microsoft's own tenants are platform plumbing, not third-party SaaS.
MICROSOFT_TENANTS = {"f8cdef31-a31e-4b4a-93e4-5f571e91255a", "72f988bf-86f1-41af-91ab-2d7cd011db47"}


class Graph:
    def __init__(self, client_id=None, client_secret=None):
        r = httpx2.post(
            f"https://login.microsoftonline.com/{config.ENTRA_TENANT_ID}/oauth2/v2.0/token",
            data={"grant_type": "client_credentials", "client_id": client_id or config.ENTRA_SYNC_CLIENT_ID,
                  "client_secret": client_secret or config.ENTRA_SYNC_CLIENT_SECRET,
                  "scope": "https://graph.microsoft.com/.default"},
            timeout=30,
        )
        if r.status_code in (400, 401):  # invalid/expired client secret or revoked consent
            raise NotAuthorized(f"Entra token request rejected: HTTP {r.status_code} {r.json().get('error', '')}")
        if r.status_code != 200:
            raise RuntimeError(f"Entra token request failed: HTTP {r.status_code} {r.json().get('error', '')}")
        # Audit-log queries can take well over a minute per page on Microsoft's side.
        self.http = httpx2.Client(headers={"Authorization": f"Bearer {r.json()['access_token']}"},
                                  timeout=httpx2.Timeout(180, connect=15))

    def get(self, url):
        url = url if url.startswith("https://") else GRAPH + url
        for attempt in range(6):
            try:
                r = self.http.get(url)
            except httpx2.TransportError:  # timeout or dropped connection: transient, retry with backoff
                if attempt == 5:
                    raise
                time.sleep(min(2 ** attempt * 2, 60))
                continue
            if r.status_code in (429, 500, 502, 503, 504):
                time.sleep(_retry_after(r, attempt))
                continue
            if r.status_code in (401, 403):
                msg = r.json().get("error", {}).get("message", "") if r.content else ""
                raise NotAuthorized(f"HTTP {r.status_code} from {url.split('?')[0]}: {msg[:200]}")
            r.raise_for_status()
            return r.json()
        r.raise_for_status()
        raise RuntimeError(f"Graph kept returning {r.status_code}")

    def all_pages(self, paths, workers=8):
        """Yield (path, list of items) for several paged queries at once. The httpx2 client is thread-safe."""
        with ThreadPoolExecutor(workers) as pool:
            yield from zip(paths, pool.map(lambda p: list(self.pages(p)), paths))

    def pages(self, path):
        url = path
        while url:
            data = self.get(url)
            yield from data.get("value", [])
            url = data.get("@odata.nextLink")


# ---------------------------------------------------------------- Personio (HR system of record)

PERSONIO = "https://api.personio.de"


def personio_get(s, path, params=None):
    for attempt in range(6):
        try:
            r = s.get(f"{PERSONIO}{path}", params=params, timeout=(15, 60))
        except requests.RequestException:
            if attempt == 5:
                raise
            time.sleep(min(2 ** attempt * 2, 60))
            continue
        if r.status_code in (429, 500, 502, 503, 504):
            time.sleep(_retry_after(r, attempt))
            continue
        if r.status_code in (401, 403):
            raise NotAuthorized(f"HTTP {r.status_code} from Personio {path}")
        r.raise_for_status()
        return r.json()
    r.raise_for_status()
    raise RuntimeError(f"Personio kept returning {r.status_code}")


def personio_employees():
    """All employees (v1 company/employees). The endpoint caps pages at 100 and its offset handling is known to
    overlap pages, so records are de-duplicated by id and paging stops when a page brings nothing new."""
    s = requests.Session()
    r = s.post(f"{PERSONIO}/v2/auth/token", timeout=(15, 30), data={
        "grant_type": "client_credentials", "client_id": config.PERSONIO_CLIENT_ID,
        "client_secret": config.PERSONIO_CLIENT_SECRET})
    if r.status_code in (400, 401, 403):
        raise NotAuthorized(f"Personio rejected the API credentials (HTTP {r.status_code})")
    r.raise_for_status()
    s.headers.update(authorization=f"Bearer {r.json()['access_token']}", accept="application/json")
    out, offset = {}, 0
    for _ in range(500):  # hard stop far above any real company size (50,000 employees)
        page = personio_get(s, "/v1/company/employees", {"limit": 100, "offset": offset}).get("data") or []
        new = {e["attributes"]["id"]["value"]: e for e in page if e.get("attributes", {}).get("id")}
        if not new.keys() - out.keys():
            break
        out.update(new)
        if len(page) < 100:
            break
        offset += 100
    return list(out.values())
