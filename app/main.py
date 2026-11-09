import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse

from authlib.integrations.starlette_client import OAuthError
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.sessions import SessionMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import actions, auth, config, db, discovery
from .api import router
from .auth import oauth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("app")
config.validate()
db.init()

# Built web UI (npm run build in frontend/). Served from the same origin, so no CORS is ever needed.
WEB_DIR = Path(__file__).resolve().parent.parent / "frontend" / "dist"


async def scheduler():
    await asyncio.sleep(5)
    while True:
        try:
            await run_in_threadpool(discovery.run_sync)
        except Exception:
            log.exception("scheduled sync failed")
        await asyncio.sleep(config.SYNC_INTERVAL_HOURS * 3600)


@asynccontextmanager
async def lifespan(_app):
    conn = db.connect()
    with conn:  # a run cut off by a restart would otherwise show "Syncing" forever
        conn.execute("UPDATE sync_run SET status = 'error', finished_at = ?, error = 'Interrupted: the app restarted"
                     " during this sync' WHERE status = 'running'", (db.now(),))
        # apply catalogue / INTERNAL_APP_HINTS changes without waiting for a sync; group add-ons with their provider
        if discovery.classify_apps(conn) + discovery.group_addons(conn):
            discovery.reconcile(conn, db.now())
    conn.close()
    if config.DEMO_MODE:
        log.warning("DEMO_MODE is on: sample data and a password-less demo login are enabled. Never expose this instance.")
        from . import demo
        demo.seed_if_empty()
    else:  # never let demo access survive into a real deployment that reuses the data directory
        conn = db.connect()
        with conn:
            conn.execute("DELETE FROM session WHERE provider = 'demo'")
            # also roles the password-less demo admin handed out
            conn.execute("DELETE FROM user_role WHERE granted_by IN ('demo', 'demo.admin@example.com', 'demo.auditor@example.com')")
        conn.close()
    task = asyncio.create_task(scheduler())
    yield
    task.cancel()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(SessionMiddleware, secret_key=config.SECRET_KEY, session_cookie="gsm_session",
                   max_age=config.SESSION_HOURS * 3600, same_site="lax", https_only=config.HTTPS)
# Blocks DNS-rebinding: only our own hostname (plus loopback for the container healthcheck) is served.
app.add_middleware(TrustedHostMiddleware, allowed_hosts=[urlparse(config.BASE_URL).hostname, "localhost", "127.0.0.1"])
app.include_router(router)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    # 'unsafe-inline' for styles only: Radix primitives inject small <style> tags (scroll lock). Scripts stay strict.
    resp.headers["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self';"
        " font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none';"
        " form-action 'self'")
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "same-origin"
    resp.headers["Cache-Control"] = resp.headers.get("Cache-Control", "no-store")
    if config.HTTPS:
        resp.headers["Strict-Transport-Security"] = "max-age=31536000"
    return resp


@app.exception_handler(StarletteHTTPException)
async def http_error(request: Request, exc):
    if exc.status_code == 303:
        return RedirectResponse(exc.headers["Location"], 303)
    return JSONResponse({"detail": exc.detail if exc.status_code != 404 else "Not found."}, exc.status_code)


# ---------------------------------------------------------------- sign-in (OIDC redirects stay server-side)

@app.get("/login/{provider}")
async def login(request: Request, provider: str):
    client = oauth.create_client(provider)
    if not client:
        raise HTTPException(404)
    return await client.authorize_redirect(request, f"{config.BASE_URL}/auth/{provider}/callback")


@app.get("/login/google/stepup")
async def stepup(request: Request, next: str = "/"):
    """Fresh Google sign-in for security actions. Google must report a sign-in within STEPUP_SECONDS (auth_time)."""
    client = oauth.create_client("google")
    if not client or not config.ACTIONS:
        raise HTTPException(404)
    user = auth.current_user(request)
    if not next.startswith("/") or next.startswith("//"):
        next = "/"
    request.session["stepup"] = {"email": user.email, "next": next}
    return await client.authorize_redirect(request, f"{config.BASE_URL}/auth/google/callback", max_age=0,
                                           login_hint=user.email,
                                           claims=json.dumps({"id_token": {"auth_time": {"essential": True}}}))


@app.get("/auth/{provider}/callback")
async def auth_callback(request: Request, provider: str):
    client = oauth.create_client(provider)
    if not client:
        raise HTTPException(404)
    stepup = request.session.pop("stepup", None)
    try:
        token = await client.authorize_access_token(request)
    except OAuthError as e:
        log.warning("OIDC error from %s: %s", provider, e.error)
        return RedirectResponse(f"{stepup['next']}?stepup=failed" if stepup else "/login?error=failed", 303)
    email = auth.verified_email(provider, token.get("userinfo"))
    if stepup:  # re-authentication of the signed-in user, not a new sign-in
        auth_time = (token.get("userinfo") or {}).get("auth_time")
        fresh = (provider == "google" and email == stepup["email"] and isinstance(auth_time, (int, float))
                 and time.time() - auth_time < actions.STEPUP_SECONDS)
        if fresh:
            auth.mark_stepup(request, email)
        conn = db.connect()
        with conn:
            db.audit(conn, email or "unknown", "auth.stepup" if fresh else "auth.stepup_denied", "user", stepup["email"],
                     {"auth_time": auth_time})
        conn.close()
        return RedirectResponse(stepup["next"] + ("" if fresh else "?stepup=failed"), 303)
    conn = db.connect()
    role = auth.role_of(conn, email) if email else None
    with conn:
        db.audit(conn, email or "unknown", "auth.login" if role else "auth.denied", "user", email,
                 {"provider": provider, "reason": None if role else ("not in allowed organisation" if not email else "no role")})
    conn.close()
    if not email:
        return RedirectResponse("/login?error=organisation", 303)
    if not role:
        return RedirectResponse("/login?error=role", 303)
    auth.start_session(request, email, provider)
    return RedirectResponse("/", 303)


@app.get("/healthz")
def healthz():
    return {"ok": True}


# ---------------------------------------------------------------- web UI

@app.get("/{path:path}", include_in_schema=False)
def web(path: str):
    if path.startswith("api/"):
        raise HTTPException(404)
    if not (WEB_DIR / "index.html").exists():
        raise HTTPException(503, "Web UI not built. Run `npm ci && npm run build` in frontend/.")
    file = (WEB_DIR / path).resolve()
    if path and file.is_file() and file.is_relative_to(WEB_DIR):
        return FileResponse(file)
    return FileResponse(WEB_DIR / "index.html")  # client-side route
