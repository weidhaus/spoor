import datetime as dt
import hashlib
import hmac
import json
import os
import sqlite3
import uuid
from pathlib import Path

from . import config


def now():
    return dt.datetime.now(dt.UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def connect():
    conn = sqlite3.connect(config.DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 15000")
    return conn


def init():
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(config.DATA_DIR, 0o700)
    conn = connect()
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript((Path(__file__).parent / "schema.sql").read_text())
    # Databases created before activity_since existed get the column; NULL means "history start unknown".
    if "activity_since" not in {r[1] for r in conn.execute("PRAGMA table_info(integration_state)")}:
        conn.execute("ALTER TABLE integration_state ADD COLUMN activity_since TEXT")
    if "stepup_at" not in {r[1] for r in conn.execute("PRAGMA table_info(session)")}:
        conn.execute("ALTER TABLE session ADD COLUMN stepup_at TEXT")
    conn.close()
    os.chmod(config.DB_PATH, 0o600)


def _mac(prev_hash, fields):
    payload = prev_hash + json.dumps(fields, sort_keys=True, separators=(",", ":"))
    return hmac.new(config.AUDIT_SIGNING_KEY.encode(), payload.encode(), hashlib.sha256).hexdigest()


def _fields(row):
    return {k: row[k] for k in ("event_id", "occurred_at", "actor", "action", "target_type", "target_id", "detail")}


def audit(conn, actor, action, target_type=None, target_id=None, detail=None):
    """Append an audit event inside the caller's transaction. Each event is HMAC-chained to the previous one."""
    if not conn.in_transaction:  # take the write lock before reading the chain head, so concurrent writers can't fork it
        conn.execute("BEGIN IMMEDIATE")
    prev = conn.execute("SELECT hash FROM audit_event ORDER BY id DESC LIMIT 1").fetchone()
    fields = {
        "event_id": "evt_" + uuid.uuid4().hex,
        "occurred_at": now(),
        "actor": actor,
        "action": action,
        "target_type": target_type,
        "target_id": None if target_id is None else str(target_id),
        "detail": json.dumps(detail, sort_keys=True, separators=(",", ":"), default=str) if detail else None,
    }
    prev_hash = prev["hash"] if prev else ""
    conn.execute(
        "INSERT INTO audit_event (event_id, occurred_at, actor, action, target_type, target_id, detail, prev_hash, hash)"
        " VALUES (:event_id, :occurred_at, :actor, :action, :target_type, :target_id, :detail, :prev_hash, :hash)",
        {**fields, "prev_hash": prev_hash, "hash": _mac(prev_hash, fields)},
    )


def verify_audit(conn):
    """Returns (ok, events_checked, first_bad_event_id)."""
    prev_hash, n = "", 0
    for row in conn.execute("SELECT * FROM audit_event ORDER BY id"):
        n += 1
        if row["prev_hash"] != prev_hash or not hmac.compare_digest(row["hash"], _mac(prev_hash, _fields(row))):
            return False, n, row["event_id"]
        prev_hash = row["hash"]
    return True, n, None
