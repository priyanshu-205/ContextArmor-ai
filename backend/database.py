"""
database.py — SQLite persistence layer for ContextArmor-ai.

All data is stored in backend/contextarmor.db (relative to this file).
"""

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(__file__).parent / "contextarmor.db"


# ---------------------------------------------------------------------------
# Connection helper
# ---------------------------------------------------------------------------

def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

def init_db() -> None:
    """Create the events table if it does not already exist."""
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS events (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp         TEXT NOT NULL,
                module            TEXT NOT NULL,        -- SCAN | OPTIMIZE | TRANSFER
                risk_score        REAL NOT NULL,
                action            TEXT NOT NULL,        -- ALLOW | WARN | BLOCK
                detected_entities TEXT NOT NULL,        -- JSON array
                tokens_saved      INTEGER NOT NULL DEFAULT 0,
                original_tokens   INTEGER NOT NULL DEFAULT 0,
                compressed_tokens INTEGER NOT NULL DEFAULT 0,
                details           TEXT NOT NULL         -- JSON object
            )
            """
        )
        conn.commit()


# ---------------------------------------------------------------------------
# Write helpers
# ---------------------------------------------------------------------------

def log_event(
    module: str,
    risk_score: float,
    action: str,
    detected_entities: list,
    tokens_saved: int,
    original_tokens: int,
    compressed_tokens: int,
    details_dict: dict,
) -> int:
    """Insert one event row and return the new row id."""
    timestamp = datetime.now(timezone.utc).isoformat()
    entities_json = json.dumps(detected_entities)
    details_json = json.dumps(details_dict)

    with _connect() as conn:
        cursor = conn.execute(
            """
            INSERT INTO events
                (timestamp, module, risk_score, action, detected_entities,
                 tokens_saved, original_tokens, compressed_tokens, details)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                timestamp,
                module,
                risk_score,
                action,
                entities_json,
                tokens_saved,
                original_tokens,
                compressed_tokens,
                details_json,
            ),
        )
        conn.commit()
        return cursor.lastrowid


# ---------------------------------------------------------------------------
# Analytics
# ---------------------------------------------------------------------------

def get_analytics() -> dict:
    """
    Return a summary dict consumed by the dashboard:

    {
        total_scans:        int,
        total_optimizations:int,
        total_transfers:    int,
        threats_blocked:    int,
        pii_redacted_count: int,   # total entity items across all rows
        total_tokens_saved: int,
        average_risk_score: float,
        category_breakdown: {entity_type: count, ...},
        recent_events:      [dict, ...],   # last 25, newest first
    }
    """
    with _connect() as conn:
        # --- simple aggregates ------------------------------------------
        def _scalar(sql, params=()):
            row = conn.execute(sql, params).fetchone()
            return row[0] if row else 0

        total_scans = _scalar(
            "SELECT COUNT(*) FROM events WHERE module = 'SCAN'"
        )
        total_optimizations = _scalar(
            "SELECT COUNT(*) FROM events WHERE module = 'OPTIMIZE'"
        )
        total_transfers = _scalar(
            "SELECT COUNT(*) FROM events WHERE module = 'TRANSFER'"
        )
        threats_blocked = _scalar(
            "SELECT COUNT(*) FROM events WHERE action = 'BLOCK'"
        )
        total_tokens_saved = _scalar(
            "SELECT COALESCE(SUM(tokens_saved), 0) FROM events"
        )
        avg_risk = _scalar(
            "SELECT COALESCE(AVG(risk_score), 0.0) FROM events"
        )

        # --- pii_redacted_count & category_breakdown --------------------
        # We must iterate over every row's detected_entities JSON array.
        all_entities_rows = conn.execute(
            "SELECT detected_entities FROM events"
        ).fetchall()

        pii_redacted_count = 0
        category_breakdown: dict[str, int] = {}

        for row in all_entities_rows:
            try:
                entities: list = json.loads(row[0])
            except (json.JSONDecodeError, TypeError):
                entities = []

            pii_redacted_count += len(entities)

            for entity in entities:
                # Each entity may be a plain string (the type name) or a dict
                # with a "type" key depending on which caller produced it.
                if isinstance(entity, dict):
                    key = entity.get("type", "UNKNOWN")
                elif isinstance(entity, str):
                    key = entity
                else:
                    key = "UNKNOWN"
                category_breakdown[key] = category_breakdown.get(key, 0) + 1

        # --- recent events (last 25, newest first) ----------------------
        raw_rows = conn.execute(
            """
            SELECT id, timestamp, module, risk_score, action,
                   detected_entities, tokens_saved, original_tokens,
                   compressed_tokens, details
            FROM events
            ORDER BY id DESC
            LIMIT 25
            """
        ).fetchall()

        recent_events = []
        for r in raw_rows:
            recent_events.append(
                {
                    "id": r["id"],
                    "timestamp": r["timestamp"],
                    "module": r["module"],
                    "risk_score": r["risk_score"],
                    "action": r["action"],
                    "detected_entities": _safe_json_loads(r["detected_entities"], []),
                    "tokens_saved": r["tokens_saved"],
                    "original_tokens": r["original_tokens"],
                    "compressed_tokens": r["compressed_tokens"],
                    "details": _safe_json_loads(r["details"], {}),
                }
            )

    return {
        "total_scans": total_scans,
        "total_optimizations": total_optimizations,
        "total_transfers": total_transfers,
        "threats_blocked": threats_blocked,
        "pii_redacted_count": pii_redacted_count,
        "total_tokens_saved": total_tokens_saved,
        "average_risk_score": round(float(avg_risk), 2),
        "category_breakdown": category_breakdown,
        "recent_events": recent_events,
    }


def _safe_json_loads(value, default):
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return default


# ---------------------------------------------------------------------------
# Demo data
# ---------------------------------------------------------------------------

_DEMO_EVENTS = [
    # module, risk_score, action, entities, tokens_saved, orig, comp, details
    (
        "SCAN", 75.0, "BLOCK",
        ["EMAIL", "CREDIT_CARD"],
        0, 512, 512,
        {"info": "Credit card and email detected in user prompt"},
    ),
    (
        "OPTIMIZE", 5.0, "ALLOW",
        [],
        340, 1200, 860,
        {"info": "Removed redundant whitespace and repeated context"},
    ),
    (
        "TRANSFER", 20.0, "WARN",
        ["EMAIL"],
        0, 800, 800,
        {"info": "Email found in outgoing payload to external API"},
    ),
    (
        "SCAN", 90.0, "BLOCK",
        ["OPENAI_KEY", "GITHUB_TOKEN"],
        0, 256, 256,
        {"info": "API secrets found; transfer blocked"},
    ),
    (
        "OPTIMIZE", 0.0, "ALLOW",
        [],
        520, 2048, 1528,
        {"info": "Chunked and de-duplicated conversation history"},
    ),
    (
        "SCAN", 30.0, "WARN",
        ["PHONE", "EMAIL"],
        0, 400, 400,
        {"info": "PII detected; user notified"},
    ),
    (
        "TRANSFER", 0.0, "ALLOW",
        [],
        0, 600, 600,
        {"info": "Clean payload forwarded to Claude"},
    ),
    (
        "SCAN", 60.0, "BLOCK",
        ["PROMPT_INJECTION"],
        0, 128, 128,
        {"info": "Jailbreak attempt detected and blocked"},
    ),
    (
        "OPTIMIZE", 10.0, "ALLOW",
        ["EMAIL"],
        180, 900, 720,
        {"info": "Compressed; email redacted before sending"},
    ),
    (
        "SCAN", 45.0, "WARN",
        ["IPV4", "PAN_CARD"],
        0, 350, 350,
        {"info": "Internal IP and PAN card found in prompt"},
    ),
    (
        "TRANSFER", 80.0, "BLOCK",
        ["AWS_KEY"],
        0, 512, 512,
        {"info": "AWS access key found in transfer payload"},
    ),
    (
        "SCAN", 15.0, "ALLOW",
        ["EMAIL"],
        0, 200, 200,
        {"info": "Low-risk email; allowed with audit log"},
    ),
    (
        "OPTIMIZE", 0.0, "ALLOW",
        [],
        760, 3000, 2240,
        {"info": "Aggressive context compression applied"},
    ),
    (
        "SCAN", 55.0, "WARN",
        ["CREDIT_CARD", "PHONE"],
        0, 480, 480,
        {"info": "Credit card and phone number in user message"},
    ),
    (
        "TRANSFER", 70.0, "BLOCK",
        ["PROMPT_INJECTION", "OPENAI_KEY"],
        0, 300, 300,
        {"info": "Injection attempt combined with leaked key; hard block"},
    ),
]


def seed_demo_data() -> None:
    """Insert 15 realistic baseline events so dashboards look populated."""
    base_ts = datetime(2025, 10, 1, 8, 0, 0, tzinfo=timezone.utc)
    with _connect() as conn:
        for i, (module, risk, action, entities, ts, orig, comp, details) in enumerate(
            _DEMO_EVENTS
        ):
            # Space events ~2 hours apart
            from datetime import timedelta
            ts_str = (base_ts + timedelta(hours=i * 2)).isoformat()
            conn.execute(
                """
                INSERT INTO events
                    (timestamp, module, risk_score, action, detected_entities,
                     tokens_saved, original_tokens, compressed_tokens, details)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    ts_str,
                    module,
                    risk,
                    action,
                    json.dumps(entities),
                    ts,
                    orig,
                    comp,
                    json.dumps(details),
                ),
            )
        conn.commit()


def reset_demo() -> None:
    """Wipe all events and re-seed with demo data."""
    with _connect() as conn:
        conn.execute("DELETE FROM events")
        conn.commit()
    seed_demo_data()


# ---------------------------------------------------------------------------
# Auto-init on import
# ---------------------------------------------------------------------------

init_db()
