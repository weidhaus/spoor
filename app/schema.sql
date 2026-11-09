-- Person = workforce subject. Account = one piece of observed evidence that a person (or nobody) has
-- access to an app, from one source. Rows are never deleted by syncs; they move to state 'removed'.

CREATE TABLE IF NOT EXISTS person (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT, department TEXT, title TEXT, manager_email TEXT,
  kind TEXT NOT NULL DEFAULT 'employee',          -- employee | guest
  status TEXT NOT NULL DEFAULT 'active',          -- active | suspended | deleted
  status_source TEXT,
  google_id TEXT UNIQUE, entra_id TEXT UNIQUE,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS person_email (
  email TEXT PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS app (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL, norm_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'discovered',      -- discovered | sanctioned | tolerated | unsanctioned | ignored
  category TEXT, owner_email TEXT, website TEXT, notes TEXT,
  first_seen TEXT NOT NULL, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS app_norm ON app(norm_name);

-- Every external identifier that maps to an app (OAuth client id, SAML app name, Entra appId, ...)
CREATE TABLE IF NOT EXISTS app_source (
  source TEXT NOT NULL, external_id TEXT NOT NULL,
  app_id INTEGER NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  label TEXT, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
  PRIMARY KEY (source, external_id)
);

CREATE TABLE IF NOT EXISTS subscription (
  id INTEGER PRIMARY KEY,
  app_id INTEGER NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual', external_id TEXT,
  quantity INTEGER, observed_consumed INTEGER,
  unit_cost REAL, currency TEXT NOT NULL DEFAULT 'EUR', billing_period TEXT NOT NULL DEFAULT 'month',
  renewal_date TEXT, owner_email TEXT, notes TEXT, last_seen TEXT,
  UNIQUE (source, external_id)
);

CREATE TABLE IF NOT EXISTS account (
  id INTEGER PRIMARY KEY,
  app_id INTEGER NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  person_id INTEGER REFERENCES person(id),
  source TEXT NOT NULL,
  kind TEXT NOT NULL,       -- directory | license | oauth_grant | sso_assignment | sso_login | sign_in | imported
  external_id TEXT NOT NULL,
  email TEXT, display_name TEXT, role TEXT, scopes TEXT,
  subscription_id INTEGER REFERENCES subscription(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'active',           -- active | disabled | removed
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, removed_at TEXT,
  last_activity_at TEXT,
  UNIQUE (app_id, source, kind, external_id)
);
CREATE INDEX IF NOT EXISTS account_person ON account(person_id);
CREATE INDEX IF NOT EXISTS account_sub ON account(subscription_id);

-- activity_since: start of the activity history this source has delivered (audit or sign-in logs only reach back
-- so far). Inactivity is only claimed when this history covers the whole inactivity window.
CREATE TABLE IF NOT EXISTS integration_state (
  name TEXT PRIMARY KEY, cursor TEXT, last_success_at TEXT, last_error TEXT, activity_since TEXT
);

CREATE TABLE IF NOT EXISTS sync_run (
  id INTEGER PRIMARY KEY, integration TEXT NOT NULL,
  started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL,
  stats TEXT, warnings TEXT, error TEXT
);

CREATE TABLE IF NOT EXISTS issue (
  id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL, severity TEXT NOT NULL, title TEXT NOT NULL, detail TEXT,
  app_id INTEGER REFERENCES app(id) ON DELETE CASCADE,
  person_id INTEGER REFERENCES person(id),
  status TEXT NOT NULL DEFAULT 'open',            -- open | resolved | accepted
  accepted_reason TEXT, accepted_by TEXT, accepted_until TEXT,
  opened_at TEXT NOT NULL, last_seen TEXT NOT NULL, resolved_at TEXT
);

-- Access requests record decisions and the manually reported execution outcome. Connectors are read-only,
-- so nothing here changes access in Google, Microsoft or any other app.
CREATE TABLE IF NOT EXISTS access_request (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES person(id),
  app_id INTEGER NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('grant', 'revoke')),
  requested_access TEXT,                          -- NULL = any access to the app
  justification TEXT NOT NULL,
  requested_by TEXT NOT NULL, requested_at TEXT NOT NULL,
  decision TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by TEXT, decided_at TEXT, decision_note TEXT,
  execution TEXT NOT NULL DEFAULT 'not_started' CHECK (execution IN ('not_started', 'completed', 'failed')),
  executed_by TEXT, executed_at TEXT, execution_note TEXT
);
CREATE INDEX IF NOT EXISTS request_person ON access_request(person_id);

CREATE TABLE IF NOT EXISTS user_role (
  email TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('admin', 'auditor')),
  granted_by TEXT, granted_at TEXT
);

CREATE TABLE IF NOT EXISTS session (
  id_hash TEXT PRIMARY KEY, email TEXT NOT NULL, provider TEXT NOT NULL,
  csrf TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  stepup_at TEXT  -- last fresh Google re-authentication, required for security actions
);

-- Security actions (app/actions.py): requested by one officer, approved and run by another.
CREATE TABLE IF NOT EXISTS security_action (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES person(id),
  kind TEXT NOT NULL, target TEXT, reason TEXT NOT NULL,
  requested_by TEXT NOT NULL, requested_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'rejected', 'running', 'done', 'failed')),
  decided_by TEXT, decided_at TEXT, result TEXT
);
CREATE INDEX IF NOT EXISTS security_action_person ON security_action(person_id);

-- Append-only, HMAC-chained audit trail.
CREATE TABLE IF NOT EXISTS audit_event (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE, occurred_at TEXT NOT NULL,
  actor TEXT NOT NULL, action TEXT NOT NULL,
  target_type TEXT, target_id TEXT, detail TEXT,
  prev_hash TEXT NOT NULL UNIQUE, hash TEXT NOT NULL   -- '' for the first event
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_event
BEGIN SELECT RAISE(ABORT, 'audit_event is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_event
BEGIN SELECT RAISE(ABORT, 'audit_event is append-only'); END;

-- Cached favicon per app, looked up from the app's website. data NULL = looked up, none available.
CREATE TABLE IF NOT EXISTS app_icon (
  app_id INTEGER PRIMARY KEY REFERENCES app(id) ON DELETE CASCADE,
  domain TEXT NOT NULL, data BLOB, content_type TEXT, fetched_at TEXT NOT NULL
);

-- One row per Personio employee: what HR says, kept apart from what the directories say (person.status).
-- person_id NULL = no directory account matched. leave_date = last working day, else termination date.
CREATE TABLE IF NOT EXISTS hr_record (
  personio_id TEXT PRIMARY KEY,
  person_id INTEGER REFERENCES person(id) ON DELETE SET NULL,
  email TEXT, name TEXT,
  status TEXT NOT NULL,                           -- active | onboarding | leave | inactive (Personio's values)
  hire_date TEXT, leave_date TEXT,
  department TEXT, title TEXT, supervisor_email TEXT,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, removed_at TEXT
);
CREATE INDEX IF NOT EXISTS hr_record_person ON hr_record(person_id);
