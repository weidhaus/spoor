<p align="center"><img src="frontend/public/spoor.svg" width="112" alt="Spoor logo: two hoof tracks, the newer one in amber"></p>

# Spoor

Every sign-in leaves a track. Spoor reads those tracks in your identity provider and shows **which SaaS applications
your company uses, who uses them, how they got access, what licences they consume and where things look wrong**.
Data comes from Google Workspace, Microsoft Entra ID and CSV exports from any other app.

It is built for IT administrators and IAM managers who need that list quickly: connect the IdP, run a sync, and
the applications people signed in to or granted access to are on screen. Spoor is self-hosted and serves one company.

Discovery is **read-only**. Changes in Google or Microsoft happen only through offboarding or security actions, both off by default and never automatic.

## Try it in 2 minutes (demo data)

```bash
cp .env.example .env
# set SECRET_KEY and AUDIT_SIGNING_KEY (openssl rand -hex 32 for each), and DEMO_MODE=true
docker compose up --build
open http://localhost:8000      # "Enter demo as administrator"
```

Without Docker: `cd frontend && npm ci && npm run build`, then `uv run --env-file .env uvicorn app.main:app --port 8000`.
Frontend development with hot reload: keep uvicorn running and `cd frontend && npm run dev` (Vite proxies `/api` to port 8000).
Checks: `uv run pytest` (backend), `cd frontend && npm run typecheck && npm run lint && npm run build`.

The demo offers two logins: administrator, and auditor (read and export only).

Turn `DEMO_MODE` off before connecting real data. Demo mode allows sign-in without a password.

## What it does

| Area | What you get |
|---|---|
| **Discovery** | Google: users, third-party OAuth grants per user (shadow IT), OAuth app usage and SAML SSO logins from audit reports, Workspace licences. Entra: users and guests, M365 SKUs (purchased vs consumed), enterprise SSO apps and assignments (group-expanded), delegated OAuth consents (per user and admin consent), sign-in logs. CSV: user export of any app. |
| **Correlation** | One person across Google, Entra and app accounts, matched via primary email, aliases, UPN and proxy addresses. Email is never the primary key. The same product found from several sources is merged automatically by name, or manually with "Merge into". |
| **Evidence model** | Each row records how a person relates to an app (directory account, licence, OAuth grant, SSO assignment, SSO login, sign-in, import), together with its source, first seen, last observed and last activity. Nothing is deleted. Anything no longer seen is marked *removed* and kept as history. |
| **Classification** | When an app is first discovered, and for all apps at startup, a curated catalogue (`app/catalog.py`) fills in category and vendor website for known apps, marks Google Cloud default projects, `-prod`/`-dev` clients and names containing your own domain names (plus `INTERNAL_APP_HINTS`) as Internal, and moves OS/browser sign-in clients (Chrome, iOS Account Manager, Windows Sign In, ...) from Discovered to Ignored. It only fills blanks and never touches an admin's values or decisions; every change is in the audit log as `app.classified`. |
| **Icons** | Each app with a website shows the vendor's favicon. The server fetches it once from Google's favicon service (only that fixed host, never an address from discovered data; Google, as the IdP, already knows the app inventory), caches it in the database and serves it from this origin, so browsers never contact third parties. No icon: neutral initials. |
| **Usage** | Having access is not using it. Per person and app, usage is Active (activity within `INACTIVITY_DAYS`, default 90), Inactive, Usage unknown (no source reports activity for that app: never treated as inactive), or Not enough history (the activity log does not reach back the full window yet). Activity comes from Google's OAuth token log (API calls), Google SAML sign-ins, Entra sign-in logs (needs P1), directory last-login times and CSV `last_activity`. Google's token log covers grants with data scopes even when they show no calls; sign-in-only grants and Entra delegated consents stay "Usage unknown". The first Google scan reaches back 90 days (Google keeps about 6 months); Entra keeps sign-in logs for 30 days, so its history builds up over time. |
| **Licences** | Purchased → assigned → active are kept separate. "Active" only counts when an activity source exists for that app; otherwise the page shows "no data" and makes no utilisation claim. Cost, renewal date and owner per subscription. |
| **Issues** (recomputed after every sync, import or change) | Leaver still has access · orphan account · unsanctioned app with sensitive scopes (mail/drive/directory…) · unused grant to sensitive data (revoke candidate) · nobody uses this app · new app awaiting decision · sanctioned app without owner · seats over-allocated · inactive seats (reclaim candidates, only with a full window of history) · renewal in 60 days · stale connector. An issue resolves itself when its condition disappears. Admins can accept a risk, with a reason and an optional expiry. |
| **Access requests** | Grant or revoke requests per person and application, with decision (pending/approved/rejected/cancelled), execution (not started/completed/failed), observed access (present/absent/unknown, with freshness) and verification (matched/mismatch/awaiting/unavailable) kept separate. Connectors are read-only, so execution is recorded by hand after the change is made in the application; verification only accepts an observation made after that record. |
| **Offboarding** | From a person's page, an admin picks steps and confirms by typing the person's email. The steps run immediately in a fixed order and stop at the first failure: reset the Google password to a random value nobody sees, remove recovery email and phone, sign out of all Google sessions, revoke all third-party OAuth grants, disable the Entra account, revoke Microsoft sessions, set an out-of-office reply, forward new mail, transfer Drive files, suspend. Nothing is preselected, and nothing ever runs automatically (not from Personio, not from an issue). Every step and its outcome are in the audit log and in the person's offboarding history. Off unless write credentials are configured and `WORKFLOWS=true`. |
| **Security actions** | On a person's page: revoke one app's OAuth access, revoke all OAuth access and sign out, delete app passwords, remove or assign a Google Workspace licence. Off unless `ACTIONS=true`. Only `SECURITY_OFFICERS` (env only, never set from the UI) who also hold the admin role can use them. One officer requests (typing the person's email, with a reason); a different officer approves within 24 h, which runs it immediately. Requesting and approving each need a fresh Google sign-in (`auth_time` under 5 min, unlocks for 10 min). Targets are limited to grants and licences discovery has observed. Uses the discovery service account. |
| **Audit** | Every login, change, sync, import, export and verification is logged. The log is append-only (DB triggers) and HMAC-chained, with in-app verification. Export produces JSONL plus a signed manifest. CSV exports are available for apps, people, accounts, subscriptions and issues. |

## Security model

- **Sign-in**: OIDC with PKCE, nonce and signature/issuer validation via Authlib. Google requires `email_verified` and that `hd` is in `GOOGLE_ALLOWED_DOMAINS` (personal Gmail is rejected). Entra uses a single-tenant authority, checks `tid`, and uses the admin-controlled UPN rather than the optional `email` claim.
- **Authorisation**: deny by default. Someone who signs in successfully but has no role is rejected. Roles are `admin` (changes) and `auditor` (read and export everything). The role is re-read on every request, so revoking it takes effect immediately and also kills the user's sessions. `BOOTSTRAP_ADMINS` prevents lock-out.
- **Sessions**: server-side. The cookie holds only a random token (stored hashed), signed, `HttpOnly`, `SameSite=Lax` and `Secure` behind HTTPS. Sessions expire after 12 h, and the session is regenerated at login.
- **Web**: CSRF token on every POST, strict CSP (no inline scripts), `frame-ancestors 'none'`, nosniff, no-store, autoescaped templates, protection against CSV formula injection, upload limits, and API docs disabled.
- **Secrets**: kept in env and files only, never in the DB. The service-account key is mounted read-only.
- **Demo isolation**: the app refuses to start with `DEMO_MODE` plus any real credentials. Demo sessions and roles are purged at startup once demo mode is off.
- **Host check**: only the `BASE_URL` hostname (and loopback) is served, which blocks DNS rebinding. Exports refuse cross-site navigations.
- **Runtime**: binds to `127.0.0.1` only. The container runs as non-root with a read-only filesystem, all capabilities dropped and `no-new-privileges`, and installs dependencies from hash-pinned `requirements.txt`. Data lives in a `0700` directory with a `0600` SQLite file.
- **Write access**: only `app/offboarding.py` and `app/actions.py` (security actions, see above) change anything. Offboarding runs with its own credentials, always after an admin types the person's email to confirm. Recipients are limited to internal people. Each step is audited before the next starts.
- **Sync safety**: each connector step runs in one transaction. An empty user list is refused instead of being treated as "everyone left". A missing optional scope or licence produces a warning, not a failure.

**Known limits for a production rollout:** the DB is not encrypted at the application level, so rely on disk encryption (FileVault, or encrypted volumes on a server). Put it behind HTTPS (reverse proxy) before anyone other than you uses it. There is no login rate limiting; the IdPs handle credentials, so this is low risk. Back up `data/saas.db` and keep `AUDIT_SIGNING_KEY` safe. Someone with write access to the DB file could truncate the *newest* audit events undetected. Keep the `chain_head`/`row_count` from exported manifests somewhere else if that matters.

## Connecting Google Workspace

**Sign-in** (Google Cloud console, any project):
1. APIs & Services → OAuth consent screen → *Internal*.
2. Credentials → Create OAuth client ID → *Web application* → redirect URI `http://localhost:8000/auth/google/callback`.
3. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_ALLOWED_DOMAINS=example.com`.

**Discovery**:
1. Enable **Admin SDK API** and **Enterprise License Manager API** in the project.
2. Create a service account (it needs no IAM roles) → Keys → JSON → save as `secrets/google-sa.json`.
3. Admin console → Security → Access and data control → API controls → **Domain-wide delegation** → add the service account's client ID with these scopes:
   ```
   https://www.googleapis.com/auth/admin.directory.user.readonly,
   https://www.googleapis.com/auth/admin.directory.user.security,
   https://www.googleapis.com/auth/admin.reports.audit.readonly,
   https://www.googleapis.com/auth/apps.licensing
   ```
   `user.security` (needed to list OAuth tokens) and `apps.licensing` have no read-only variant. The app only issues GETs. Leave a scope out and that part is skipped with a warning.
4. Set `GOOGLE_ADMIN_EMAIL` to an admin the service account impersonates. Use a dedicated admin with a custom role (Users: read, Reports, Security → user security management) rather than a super admin.

## Connecting Microsoft Entra ID

**Sign-in**: Entra admin center → App registrations → New → *Single tenant* → Web redirect `http://localhost:8000/auth/microsoft/callback` → create a client secret. Set `ENTRA_TENANT_ID` (GUID), `ENTRA_CLIENT_ID` and `ENTRA_CLIENT_SECRET`. No extra API permissions are needed.

**Discovery**: create a *separate* app registration → API permissions → Microsoft Graph → **Application**: `User.Read.All`, `Directory.Read.All`, `Application.Read.All`, `AuditLog.Read.All` → *Grant admin consent* → client secret → set `ENTRA_SYNC_CLIENT_ID` and `ENTRA_SYNC_CLIENT_SECRET`. Sign-in logs and last sign-in need Entra ID P1/P2; everything else works without them.

People who only exist in Entra get their status from Entra. For everyone in Google, Google is authoritative for employment status.

## Connecting Personio (HR)

Personio is the source of truth for *who should have access*. It is read-only and kept apart from the directories: a person has an **account status** (Google/Entra) and an **HR status** (Personio), shown side by side.

Personio → Settings → Integrations → API credentials → *Generate new credential* with read access to employees, and allow the attributes `email`, `first_name`, `last_name`, `preferred_name`, `status`, `hire_date`, `termination_date`, `last_working_day`, `department`, `position`, `supervisor`. Set `PERSONIO_CLIENT_ID` and `PERSONIO_CLIENT_SECRET`. If leaving dates are not allowed, the sync completes with a warning.

HR records are matched to people by email or alias, also in ASCII spelling (Personio `jürgen@` = Google `juergen@`). New issues:

| Issue | Meaning |
|---|---|
| Left per HR, account still active (high) | The last working day has passed (or Personio says inactive) but the Google/Entra account is active. A rehire with a current record is not a leaver. |
| Leaving soon (info) | Last working day within 14 days: plan the offboarding. |
| HR employee without account (medium; low before the start date) | The Personio email matches no Google or Entra address. |
| Account without HR record (low) | An active account Personio does not know: a shared mailbox or service account (accept the issue), or someone missing from HR. |

## Enabling offboarding (write access)

Discovery never changes anything. Offboarding uses **separate** credentials, so a leak of the read credentials can't change accounts, and the app refuses to start if the write credentials are the same as the read ones.

**Google:** create a second service account (own project or key), enable *Admin SDK API*, *Gmail API* and *Data Transfer API*, and add its client ID under Security → API controls → Domain-wide delegation with exactly these scopes:

```
https://www.googleapis.com/auth/admin.directory.user,https://www.googleapis.com/auth/admin.directory.user.security,https://www.googleapis.com/auth/gmail.settings.basic,https://www.googleapis.com/auth/gmail.settings.sharing,https://www.googleapis.com/auth/admin.datatransfer
```

Put its key in `secrets/` (for example `secrets/google-write-sa.json`), then set `GOOGLE_WRITE_SA_FILE=/secrets/google-write-sa.json` and `GOOGLE_WRITE_ADMIN_EMAIL` to a super admin (it defaults to `GOOGLE_ADMIN_EMAIL`).

**Entra:** create a third app registration with the **Application** permissions `User.EnableDisableAccount.All` and `User.RevokeSessions.All`, grant admin consent, then set `ENTRA_WRITE_CLIENT_ID` and `ENTRA_WRITE_CLIENT_SECRET`. Disabling an account that holds an admin role additionally needs a privileged role, so Graph refuses it and the step fails with that message.

Things to know:
- **Suspension stops mail.** Google bounces mail sent to a suspended account, so forwarding and the out-of-office reply only work while the account is active. The app refuses to combine them with *suspend* in one run. Forward now, then suspend in a later run.
- **Forwarding and Drive transfers go only to internal recipients:** another active person with a Google account. If Gmail asks the recipient to confirm forwarding, the step fails and tells you; run it again after they confirm.
- **Drive transfer is asynchronous.** The step starts it, and Google emails both people when it finishes.
- **The new password is never stored or shown.** To hand the account over, reset the password in the Google Admin console.
- Account status and issues update after the next sync.

## Other applications (CSV)

Integrations → Import CSV. Use a header row with `email` (required) plus optional `name`, `role`, `plan`/`licence`, `status`, `last_activity`/`last_login` and `external_id`. Each import is a full snapshot for that app. Create the app's subscription first (Licences) so seats link to it.

## Not built (yet), on purpose

Spoor is discovery first. This version does **not** include automatic execution of access requests, provisioning, automatic deprovisioning (offboarding is admin-started only), access reviews, JML automation, SIEM/webhooks, expense/finance discovery, browser or endpoint discovery, or multi-tenancy. The data model (people ↔ evidence ↔ subscriptions, with history and an audit chain) is built so these can be added on top.

## Layout

```
frontend/           React + TypeScript + Vite, Refine (core, react-table, react-hook-form), shadcn/ui on Radix, Tailwind 4, Recharts, Lucide
  src/styles.css      design tokens (the only colour source) mapped onto shadcn variables
  src/components/     shared table (resource-table), state badges, missing-value labels, dialogs, shell
  src/lib/states.ts   explicit adapters from API values to labels and badge tones, one per state dimension
  src/pages/          overview, applications, people, licenses, requests, issues, audit, integrations, users
app/api.py          JSON API used by the UI (session cookie + X-CSRF-Token header); list filters shared with exports
app/connectors.py   Google + Graph API clients (GET only)
app/discovery.py    ingest, correlation, CSV import, reconciliation rules, sync orchestration
app/db.py, schema.sql   SQLite schema, HMAC-chained audit log
app/auth.py         OIDC, sessions, roles, CSRF
app/main.py         app setup, security headers, OIDC redirects, serves frontend/dist
app/demo.py         demo data (DEMO_MODE only)
tests/test_core.py  audit tamper detection, reconciliation, sync semantics, auth/CSRF/roles, request states, bulk results, export scope
```

## Interface decisions

Each deliberate:

- **Kept the Python backend** (OIDC, server-side sessions, audit chain). The UI calls a same-origin JSON API with the session
  cookie and a CSRF header; no tokens are stored in the browser.
- **Navigation includes "Issues" and "Users and roles"** (admin only).
- **CSP allows inline styles** (`style-src 'unsafe-inline'`), because Radix injects small `<style>` tags. Scripts stay `'self'` only.
- **Exports are generated synchronously.** The dialog shows the real request state (Generating, Ready, Failed), not a background job queue.
- **Selection covers the current page only.** "All matching records" is supported for exports, but not for bulk changes.

Acceptance cases, as checked with the demo data, the backend tests and headless Chrome on 13 pages × 9 widths (1440 down to 320 px):

| Case | Result |
|---|---|
| A01 approved, not started, unknown observation | Passed. Request #2 shows the three states separately, with no "granted" claim. "Queued" is not shown because no execution queue exists. |
| A02 completed, pre-operation observation | Passed. Request #3: Completed and Awaiting verification. Backend test confirms that only a later observation verifies. |
| A03 stale present access | Passed. Google evidence shows Present, Stale and the observation time. |
| A04 usage not supplied | Passed. Shown as "Not reported"; not counted as inactivity and not used for savings. |
| A05 read-only integration | Passed. Every connector states "supports reading access only"; execution reads "Automatic execution: Not supported". |
| A06 sync fails after success | Passed. Google shows the failure with the last successful sync time; earlier data stays visible. |
| A07 filter with no matches | Passed. Shows "No … match these filters" with Clear filters. |
| A08 page selection vs all matching | Passed for page scope. The reviewed id set is frozen when the bulk dialog opens. Bulk "all matching" is not supported (stated in the UI). |
| A09 partial / unknown bulk outcome | Passed. Results per target (completed, no change, failed); a lost response becomes "Outcome unknown" with "Check current status"; nothing is re-sent. |
| A10 filtered export beyond one page | Passed (backend test: 40 matches exported while the table shows 25). |
| A11 restricted operation | Passed. Auditor sees no write actions, `/users` shows Access denied, API returns 403. |
| A12 over-allocated plan | Passed. Figma and Microsoft 365 show "Over-allocated by N"; the source's consumed count is shown alongside, uncorrected. |
| A13 reauthentication required | Passed. Google shows Reauthentication required; observed access is unchanged. |
| A14 demo identification | Passed. Banner, header badge, "Demo fixture" on connectors. |
| A15 long names | Passed. Long person and app names wrap; no page overflow at 320 px. |
| A16 zero vs missing | Passed. 0 is shown as 0; missing values use explicit labels (Not reported, Unknown, Not applicable…). |
| A17 keyboard | Passed (automated). Skip link; rail tooltips on focus; drawer traps focus, Escape closes and focus returns; dialogs restore focus; table regions scroll with arrow keys; 2 px primary focus outline. |
| A18 390 / 320 px | Passed. No horizontal page overflow on any page; tables scroll inside their own region. |

Not verified: a screen-reader pass and a manual WCAG 2.2 AA audit. These checks are not proof of conformance.

Open product decisions (no rules were invented for these):

- Who may submit requests. Today only administrators can, on behalf of anyone, because employees have no role in the app.
- Whether an administrator may approve their own request (currently allowed), and any approver chain.
- Access expiry and automatic revocation (no expiry field exists).
- Whether `Present` should require a minimum evidence type per application (today any current evidence counts).

## Dependency policy

Everything runs on the newest stable release, except where a newer major isn't supported by the layer above it:

| Held back | At | Newest | Why |
|---|---|---|---|
| `@tanstack/react-table` | 8.21.3 (newest 8.x) | 9.x | Refine's table adapter (`@refinedev/react-table` 6.0.1, its newest) supports `^8` only |
| `react-router` | 7.18.4 (newest 7.x) | 8.x | Refine's router adapter (`@refinedev/react-router` 2.0.4, its newest) supports `^7` only |
| `typescript` | 6.0.3 | 7.0.2 | `typescript-eslint` (newest) supports TypeScript below 6.1 only |

Runtime images are Node 26.12.1 (build stage only) and Python 3.15.1, both pinned by digest in the `Dockerfile`.
The Python dependencies are hash-pinned in `requirements.txt`, and npm packages are locked with integrity hashes in `package-lock.json`.
Docker installs npm packages with `--ignore-scripts`.

To upgrade:
- Python: `uv lock --upgrade && uv export --no-dev --format requirements-txt --no-emit-project -o requirements.txt`.
- Frontend: `npm outdated`, then upgrade.
- Then run `npm audit` and `npm audit signatures` (verifies registry signatures and provenance attestations), followed by the
  checks above.

Supply-chain caution: compromised releases are usually caught within days of publishing. Prefer versions that have been public for a
week or more, and read the changelog of anything published in the last few days before deploying it.

## Licence

**[AGPL-3.0](LICENSE).** Use it, change it and run it for your own company. Anyone who offers a modified copy to
others over a network must publish their changes, so Spoor cannot be taken private as a closed paid service.
Copyright 2026 Justus-Constantin Weidhaus ([weidhaus.com](https://weidhaus.com)).
