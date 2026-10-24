"""
test_dashboard_metrics.py - Verification tests for Guardrails / ContextArmor AI Dashboard metrics
and Online/Offline status flow.
"""

import unittest
import tempfile
import sqlite3
import json
from pathlib import Path
from datetime import datetime, timezone, timedelta

# Import modules from backend
import database
from database import init_db, log_event, get_analytics, reset_demo, get_settings, save_settings
from guardrails_engine import GuardrailsEngine
from compressor_engine import CompressorEngine
from transfer_engine import TransferEngine
from fastapi.testclient import TestClient
from main import app


class TestDashboardMetricsAndStatus(unittest.TestCase):
    def setUp(self):
        # Create an isolated temporary SQLite database for each test
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "test_contextarmor.db"
        self._orig_db_path = database.DB_PATH
        database.DB_PATH = self.db_path
        init_db()
        self.client = TestClient(app)

    def tearDown(self):
        database.DB_PATH = self._orig_db_path
        self.temp_dir.cleanup()

    # -----------------------------------------------------------------------
    # Requirement 1: Empty database returns legitimate zeros
    # -----------------------------------------------------------------------
    def test_empty_database_returns_legitimate_zeros(self):
        """Empty database must return clean, genuine zeros and empty arrays without errors or NaNs."""
        analytics = get_analytics()
        self.assertEqual(analytics["total_scans"], 0)
        self.assertEqual(analytics["total_optimizations"], 0)
        self.assertEqual(analytics["total_transfers"], 0)
        self.assertEqual(analytics["threats_blocked"], 0)
        self.assertEqual(analytics["pii_redacted_count"], 0)
        self.assertEqual(analytics["total_tokens_saved"], 0)
        self.assertEqual(analytics["average_risk_score"], 0.0)
        self.assertEqual(analytics["severity_distribution"], {
            "CRITICAL": 0,
            "HIGH": 0,
            "MEDIUM": 0,
            "LOW": 0,
        })
        self.assertEqual(analytics["category_breakdown"], {})
        self.assertEqual(analytics["recent_events"], [])

    # -----------------------------------------------------------------------
    # Requirement 2 & 3: Recorded events produce correct nonzero metrics
    # -----------------------------------------------------------------------
    def test_recorded_events_produce_correct_nonzero_metrics(self):
        """Logged events must increment the specific module metrics accurately."""
        # 1. Log a clean scan
        log_event(
            module="SCAN",
            risk_score=10.0,
            action="ALLOW",
            detected_entities=[],
            tokens_saved=0,
            original_tokens=50,
            compressed_tokens=50,
            details_dict={"status": "clean"},
        )

        # 2. Log a blocked threat scan with findings
        log_event(
            module="SCAN",
            risk_score=95.0,
            action="BLOCK",
            detected_entities=["OPENAI_KEY", "CREDIT_CARD"],
            tokens_saved=0,
            original_tokens=100,
            compressed_tokens=100,
            details_dict={"reason": "high_entropy_secret"},
        )

        # 3. Log an optimization event
        log_event(
            module="OPTIMIZE",
            risk_score=0.0,
            action="ALLOW",
            detected_entities=[],
            tokens_saved=120,
            original_tokens=300,
            compressed_tokens=180,
            details_dict={"mode": "lossless"},
        )

        # 4. Log a transfer event
        log_event(
            module="TRANSFER",
            risk_score=0.0,
            action="ALLOW",
            detected_entities=[],
            tokens_saved=45,
            original_tokens=150,
            compressed_tokens=105,
            details_dict={"compression_ratio": 0.30},
        )

        analytics = get_analytics()
        self.assertEqual(analytics["total_scans"], 2)
        self.assertEqual(analytics["total_optimizations"], 1)
        self.assertEqual(analytics["total_transfers"], 1)
        self.assertEqual(analytics["threats_blocked"], 1)
        self.assertEqual(analytics["pii_redacted_count"], 2)
        self.assertEqual(analytics["total_tokens_saved"], 165)  # 120 + 45
        # Average risk: (10 + 95 + 0 + 0) / 4 = 105 / 4 = 26.25
        self.assertEqual(analytics["average_risk_score"], 26.25)
        self.assertEqual(analytics["category_breakdown"].get("OPENAI_KEY"), 1)
        self.assertEqual(analytics["category_breakdown"].get("CREDIT_CARD"), 1)
        self.assertEqual(len(analytics["recent_events"]), 4)

    # -----------------------------------------------------------------------
    # Requirement 4: Prevent duplicate event writes during typing
    # -----------------------------------------------------------------------
    def test_prevent_duplicate_event_writes_during_typing(self):
        """
        When log_event=False (typing preview in content script),
        the scan runs but does NOT write an event to the database.
        When log_event=True, an event IS written.
        """
        # Typing preview: log_event = False
        resp1 = self.client.post("/api/scan", json={
            "text": "My email is test@company.com and I need assistance.",
            "log_event": False,
        })
        self.assertEqual(resp1.status_code, 200)
        self.assertTrue(resp1.json()["risk_score"] > 0)
        self.assertEqual(get_analytics()["total_scans"], 0)

        # Actual submission: log_event = True (or omitted)
        resp2 = self.client.post("/api/scan", json={
            "text": "My email is test@company.com and I need assistance.",
            "log_event": True,
        })
        self.assertEqual(resp2.status_code, 200)
        self.assertEqual(get_analytics()["total_scans"], 1)

    # -----------------------------------------------------------------------
    # Requirement 5: Dashboard refresh does not cause duplicate counts
    # -----------------------------------------------------------------------
    def test_dashboard_refresh_idempotent(self):
        """Refreshing dashboard metrics repeatedly must not create duplicate counts or state mutations."""
        log_event("SCAN", 25.0, "WARN", ["EMAIL"], 0, 100, 100, {})
        initial = get_analytics()

        # Simulate 5 consecutive dashboard refreshes
        for _ in range(5):
            refreshed = get_analytics()
            self.assertEqual(refreshed["total_scans"], initial["total_scans"])
            self.assertEqual(refreshed["threats_blocked"], initial["threats_blocked"])
            self.assertEqual(refreshed["total_tokens_saved"], initial["total_tokens_saved"])
            self.assertEqual(len(refreshed["recent_events"]), 1)

    # -----------------------------------------------------------------------
    # Requirement 6: Date and Module filtering
    # -----------------------------------------------------------------------
    def test_date_and_module_filtering(self):
        """Analytics date range and module filtering returns proper subsets."""
        # Old event: 10 days ago
        old_time = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
        with database._connect() as conn:
            conn.execute(
                """
                INSERT INTO events (timestamp, module, risk_score, action, detected_entities, tokens_saved, original_tokens, compressed_tokens, details)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (old_time, "SCAN", 80.0, "BLOCK", json.dumps(["EMAIL"]), 0, 50, 50, "{}")
            )
            conn.commit()

        # Recent event: now
        log_event("OPTIMIZE", 0.0, "ALLOW", [], 50, 100, 50, {})

        # Filter last 2 days: should only see recent event
        recent_analytics = get_analytics(days=2)
        self.assertEqual(recent_analytics["total_scans"], 0)
        self.assertEqual(recent_analytics["total_optimizations"], 1)
        self.assertEqual(recent_analytics["total_tokens_saved"], 50)

        # Filter all time: should see both
        all_analytics = get_analytics()
        self.assertEqual(all_analytics["total_scans"], 1)
        self.assertEqual(all_analytics["total_optimizations"], 1)

    # -----------------------------------------------------------------------
    # Requirement 7: Health check and status model
    # -----------------------------------------------------------------------
    def test_health_check_endpoint(self):
        """GET / returns valid health check payload representing an online service."""
        resp = self.client.get("/")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data.get("status"), "running")
        self.assertIn("/api/analytics", data.get("endpoints", []))

    # -----------------------------------------------------------------------
    # Requirement 8: Reset demo restores deterministic fixtures
    # -----------------------------------------------------------------------
    def test_reset_demo_populates_deterministic_fixtures(self):
        """Reset demo endpoint seeds standard demo data upon request without startup side-effects."""
        self.assertEqual(get_analytics()["total_scans"], 0)
        resp = self.client.post("/api/reset-demo")
        self.assertEqual(resp.status_code, 200)
        after = get_analytics()
        self.assertGreater(after["total_scans"], 0)
        self.assertGreater(after["total_optimizations"], 0)
        self.assertGreater(after["total_transfers"], 0)


if __name__ == "__main__":
    unittest.main()
