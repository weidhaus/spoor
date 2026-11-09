"""Sample data for DEMO_MODE, written through the same ingest functions the real connectors use."""
import json
import random

from . import db
from . import discovery as d

PEOPLE = [
    ("Anna Becker", "Engineering"), ("Ben Schulz", "Engineering"), ("Clara Wagner", "Engineering"),
    ("David Hoffmann", "Engineering"), ("Eva Koch", "Product"), ("Felix Richter", "Product"),
    ("Greta Klein", "Design"), ("Hannah Wolf", "Design"), ("Jonas Neumann", "Sales"), ("Katrin Schwarz", "Sales"),
    ("Lukas Zimmermann", "Sales"), ("Mia Braun", "Marketing"), ("Noah Krüger", "Marketing"), ("Olivia Hartmann", "Finance"),
    ("Paul Lange", "Finance"), ("Rosa Schmitt", "People"), ("Simon Werner", "Customer Success"),
    ("Maximiliane Alexandra von Hohenzollern-Sigmaringen", "Business Development and Strategic Partnerships"),
    ("Tina Krause", "Customer Success"), ("Uwe Meier", "Operations"), ("Vera Lehmann", "Operations"),
]
SUSPENDED = {"Ben Schulz", "Katrin Schwarz"}  # leavers
DORMANT = {"Grammarly": (100, 170), "Loom": (95, 160)}  # granted, but last used this many days ago
G = "https://www.googleapis.com/auth/"
OAUTH_APPS = [  # name, scopes, share of people, status, owner
    ("Slack", ["openid", "email", "profile"], 0.95, "sanctioned", "uwe.meier@example.com"),
    ("Notion", ["openid", "email", G + "drive.readonly"], 0.6, "tolerated", None),
    ("Zoom", ["openid", "email", G + "calendar.events"], 0.7, "sanctioned", None),
    ("Miro", ["openid", "email"], 0.35, "discovered", None),
    ("Grammarly", ["openid", "email", G + "gmail.modify"], 0.2, "discovered", None),
    ("Superhuman", ["https://mail.google.com/", "openid", "email"], 0.1, "unsanctioned", None),
    ("ChatGPT", ["openid", "email", G + "drive.readonly"], 0.4, "discovered", None),
    ("Loom", ["openid", "email", G + "drive.file"], 0.3, "discovered", None),
]


def seed_if_empty():
    conn = db.connect()
    try:
        if conn.execute("SELECT COUNT(*) FROM person").fetchone()[0] == 0:
            with conn:
                seed(conn)
    finally:
        conn.close()


def seed(conn):
    rnd = random.Random(7)
    ts = db.now()
    gts = d.ago(2)  # Google evidence is two days old: the demo Google connector needs reauthentication
    for role in ("admin", "auditor"):
        conn.execute("INSERT OR IGNORE INTO user_role (email, role, granted_by, granted_at) VALUES (?, ?, 'demo', ?)",
                     (f"demo.{role}@example.com", role, ts))
    gw = d.ensure_app(conn, gts, "builtin", "google_workspace", "Google Workspace", status="sanctioned", category="Productivity")
    m365 = d.ensure_app(conn, ts, "builtin", "microsoft_365", "Microsoft 365 / Entra ID", status="sanctioned", category="Productivity")
    gsub = d.ensure_subscription(conn, gts, gw, "google_license", "1010020028", "Google Workspace Business Standard")
    conn.execute("UPDATE subscription SET quantity = 22, unit_cost = 13.6, renewal_date = '2027-01-15', owner_email = ? WHERE id = ?",
                 ("uwe.meier@example.com", gsub))
    msub = d.ensure_subscription(conn, ts, m365, "entra_sku", "3b555118-da6a-4418-894f-7df1e2096870", "O365_BUSINESS_ESSENTIALS",
                                 quantity=6, consumed=6)

    people = []
    for i, (name, dept) in enumerate(PEOPLE):
        email = name.lower().replace(" ", ".").replace("ü", "ue") + "@example.com"
        status = "suspended" if name in SUSPENDED else "active"
        pid = d.upsert_person(conn, gts, email, name=name, department=dept, status=status, status_source="google",
                              google_id=f"demo-g{i}", kind="employee")
        people.append((pid, email, name, f"demo-g{i}"))
        idle = name in SUSPENDED or rnd.random() < 0.1
        d.upsert_account(conn, gts, gw, "google", "directory", f"demo-g{i}", person_id=pid, email=email, display_name=name,
                         role="Super Admin" if i == 18 else "User", state="disabled" if status != "active" else "active",
                         last_activity_at=d.ago(rnd.randint(100, 200) if idle else rnd.randint(0, 5)))
        d.upsert_account(conn, gts, gw, "google", "license", f"1010020028:{email}", person_id=pid, email=email,
                         role="Google Workspace Business Standard", subscription_id=gsub)

    # A few people also exist in Entra (Microsoft licences for specific users), plus an external guest.
    for n, (pid, email, name, _) in enumerate(people[13:21]):
        d.upsert_person(conn, ts, email, status="active", status_source="entra", entra_id=f"demo-e{n}")
        d.upsert_account(conn, ts, m365, "entra", "directory", f"demo-e{n}", person_id=pid, email=email, display_name=name,
                         role="Member", last_activity_at=d.ago(rnd.randint(0, 120)))
        d.upsert_account(conn, ts, m365, "entra", "license", f"o365:{n}", person_id=pid, email=email,
                         role="O365_BUSINESS_ESSENTIALS", subscription_id=msub)
    guest = d.upsert_person(conn, ts, "auditor@external-audit.de", name="External Auditor", kind="guest", status="active",
                            status_source="entra", entra_id="demo-guest")
    d.upsert_account(conn, ts, m365, "entra", "directory", "demo-guest", person_id=guest, email="auditor@external-audit.de",
                     role="Guest", last_activity_at=d.ago(12))

    active_or_leaver = [p for p in people if p[2] in SUSPENDED or rnd.random() < 0.95]
    for name, scopes, share, status, owner in OAUTH_APPS:
        app = d.ensure_app(conn, gts, "google_oauth", f"demo-{name.lower()}.apps.googleusercontent.com", name)
        conn.execute("UPDATE app SET status = ?, owner_email = ? WHERE id = ?", (status, owner, app))
        for pid, email, pname, gid in active_or_leaver:
            if rnd.random() < share or (pname in SUSPENDED and name == "Slack"):
                d.upsert_account(conn, gts, app, "google", "oauth_grant", f"demo-{name}:{gid}", person_id=pid, email=email,
                                 scopes=json.dumps(sorted(scopes)), last_activity_at=d.ago(rnd.randint(*DORMANT.get(name, (0, 60)))))

    for name, share in [("HubSpot", 0.3), ("Personio", 0.9), ("1Password", 0.8)]:
        app = d.ensure_app(conn, gts, "google_saml", name, name)
        conn.execute("UPDATE app SET status = 'sanctioned', category = ? WHERE id = ?", ("SSO", app))
        for pid, email, pname, gid in people:
            if rnd.random() < share:
                d.upsert_account(conn, gts, app, "google", "sso_login", f"{name}:{gid}", person_id=pid, email=email,
                                 last_activity_at=d.ago(rnd.randint(0, 100)))

    pipedrive = d.ensure_app(conn, ts, "entra_sp", "demo-pipedrive-appid", "Pipedrive")
    conn.execute("UPDATE app SET status = 'sanctioned', owner_email = 'jonas.neumann@example.com', category = 'CRM' WHERE id = ?", (pipedrive,))
    for pid, email, pname, gid in people:
        if dict(PEOPLE)[pname] == "Sales":
            d.upsert_account(conn, ts, pipedrive, "entra", "sso_assignment", f"pd:{gid}", person_id=pid, email=email,
                             role="via group Sales")
            if pname == "Jonas Neumann":  # Entra sign-in log entry; the log only reaches back 20 days
                d.upsert_account(conn, ts, pipedrive, "entra", "sign_in", f"demo-pipedrive-appid:{gid}", person_id=pid,
                                 email=email, last_activity_at=d.ago(5))
    acrobat = d.ensure_app(conn, ts, "entra_sp", "demo-acrobat-sign", "Adobe Acrobat Sign")
    d.upsert_account(conn, ts, acrobat, "entra", "oauth_grant", "demo-acrobat-sign:all", display_name="All users (admin consent)",
                     scopes=json.dumps(["Files.ReadWrite.All", "User.Read", "openid"]))

    figma = d.ensure_app(conn, ts, "manual", "figma", "Figma")
    conn.execute("UPDATE app SET status = 'sanctioned', category = 'Design' WHERE id = ?", (figma,))
    conn.execute("INSERT INTO subscription (app_id, name, quantity, unit_cost, currency, billing_period, renewal_date)"
                 " VALUES (?, 'Professional', 5, 15, 'EUR', 'month', date('now', '+40 days'))", (figma,))
    rows = ["email,name,role,plan,last_activity",
            "greta.klein@example.com,Greta Klein,Editor,Professional," + d.ago(2)[:10],
            "hannah.wolf@example.com,Hannah Wolf,Editor,Professional," + d.ago(1)[:10],
            "eva.koch@example.com,Eva Koch,Editor,Professional," + d.ago(130)[:10],
            "felix.richter@example.com,Felix Richter,Viewer,Professional," + d.ago(20)[:10],
            "ben.schulz@example.com,Ben Schulz,Editor,Professional," + d.ago(150)[:10],
            "freelancer@pixel-agency.com,Pixel Agency,Editor,Professional," + d.ago(4)[:10]]
    d.import_csv(conn, "demo", figma, "figma-members.csv", "\n".join(rows).encode())

    # An app with no evidence from any source, and one with a long name.
    d.ensure_app(conn, ts, "manual", "linear", "Linear")
    d.ensure_app(conn, ts, "manual", "confluence", "Atlassian Confluence Cloud Enterprise (EU data residency, Frankfurt)")

    # Connector history: Google synced two days ago, then failed with 401; Entra synced with a warning.
    conn.executemany(
        "INSERT INTO sync_run (integration, started_at, finished_at, status, stats, warnings, error) VALUES (?,?,?,?,?,?,?)",
        [("google", gts, gts, "ok", '{"users": 21}', "[]", None),
         ("entra", ts, ts, "ok", '{"users": 9}', '["Sign-in logs skipped (needs AuditLog.Read.All + Entra ID P1)"]', None),
         ("google", ts, ts, "error", "{}", "[]",
          "NotAuthorized: HTTP 401 from https://admin.googleapis.com/admin/directory/v1/users")])
    # Google audit history reaches back 200 days (usage fully observed); Entra sign-in logs only 20 days.
    conn.executemany("INSERT INTO integration_state (name, last_success_at, last_error, activity_since) VALUES (?, ?, ?, ?)",
                     [("google", gts, "NotAuthorized: HTTP 401 from https://admin.googleapis.com/admin/directory/v1/users",
                       d.ago(200)),
                      ("entra", ts, None, d.ago(20))])

    # Access requests in each state. Execution is recorded by hand; connectors never change access.
    pid = {email: p for p, email, _, _ in people}
    apps = {r["name"]: r["id"] for r in conn.execute("SELECT id, name FROM app")}
    yesterday = d.ago(1)
    for person, app, kind, access, why, decision, execution, executed_at in [
        ("eva.koch@example.com", "Miro", "grant", None, "Workshop facilitation for the Q4 planning", "pending", "not_started", None),
        ("anna.becker@example.com", "Linear", "grant", "Member", "Engineering issue tracking pilot", "approved", "not_started", None),
        ("ben.schulz@example.com", "Slack", "revoke", None, "Leaver: last working day passed", "approved", "completed", ts),
        ("ben.schulz@example.com", "Figma", "revoke", None, "Leaver: reclaim Professional seat", "approved", "completed", yesterday),
        ("jonas.neumann@example.com", "Pipedrive", "grant", None, "New account executive", "approved", "completed", yesterday),
        ("mia.braun@example.com", "Superhuman", "grant", None, "Faster email triage", "rejected", "not_started", None),
    ]:
        decided = None if decision == "pending" else yesterday
        conn.execute(
            "INSERT INTO access_request (person_id, app_id, type, requested_access, justification, requested_by, requested_at,"
            " decision, decided_by, decided_at, decision_note, execution, executed_by, executed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (pid[person], apps[app], kind, access, why, "demo.admin@example.com", d.ago(3), decision,
             decided and "demo.admin@example.com", decided,
             "Sensitive mailbox access; unsanctioned app" if decision == "rejected" else None,
             execution, executed_at and "demo.admin@example.com", executed_at))
    d.reconcile(conn, ts)
    db.audit(conn, "demo", "demo.seeded")
