#!/usr/bin/env python3
"""Tests for bulletin_watchdog.stall_signature (stdlib unittest).

Hermetic: each test builds a bulletin root in a temp dir with explicit
timestamps relative to now. Run from the repo root:

    python3 scripts/test_bulletin_watchdog.py
"""

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import bulletin_watchdog as wd


def iso_at(minutes_ago: float) -> str:
    t = datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)
    return t.isoformat().replace("+00:00", "Z")


def make_event(seq: int, from_: str, kind: str = "finding",
               data=None, minutes_ago: float = 0.0) -> dict:
    return {
        "seq": seq,
        "ts": iso_at(minutes_ago),
        "kind": kind,
        "from": from_,
        "data": data or {},
    }


class BulletinFixture:
    def __init__(self):
        self.root = tempfile.mkdtemp(prefix="pi-bulletin-watchdog-")

    def events(self, *events):
        p = Path(self.root) / "events.jsonl"
        with p.open("a", encoding="utf8") as f:
            for ev in events:
                f.write(json.dumps(ev) + "\n")

    def watermark(self, lead: str, seq: int):
        Path(self.root, "watermarks.json").write_text(
            json.dumps({lead: seq}, indent=2) + "\n", encoding="utf8"
        )

    def state(self, digest_at: str, last_digest_seq: int = 0):
        Path(self.root, "state.json").write_text(
            json.dumps({"lastDigestSeq": last_digest_seq,
                        "digest": "d", "digestAt": digest_at, "members": []},
                       indent=2) + "\n",
            encoding="utf8",
        )


class StallSignatureTest(unittest.TestCase):
    def setUp(self):
        self.fx = BulletinFixture()

    def test_empty_bulletin_is_not_a_stall(self):
        sig = wd.stall_signature(self.fx.root, "lead")
        self.assertFalse(sig["stall"])
        self.assertEqual(sig["unread_count"], 0)
        self.assertEqual(sig["lead_idle_min"], 0.0)

    def test_stall_when_lead_idle_with_unread(self):
        # Teammates posted 10m ago; the lead has read nothing and acted
        # nothing since (watermark 0, no lead events, no digest).
        self.fx.events(
            make_event(1, "alice", minutes_ago=10),
            make_event(2, "bob", minutes_ago=8),
        )
        sig = wd.stall_signature(self.fx.root, "lead", idle_min=5)
        self.assertTrue(sig["stall"])
        self.assertEqual(sig["unread_count"], 2)
        self.assertGreaterEqual(sig["lead_idle_min"], 8.0)
        self.assertEqual([e["seq"] for e in sig["unread_events"]], [1, 2])

    def test_no_stall_when_lead_is_current(self):
        # Teammate posted 10m ago but the lead has read it (watermark 2).
        self.fx.events(make_event(1, "alice", minutes_ago=10))
        self.fx.watermark("lead", 1)
        sig = wd.stall_signature(self.fx.root, "lead", idle_min=5)
        self.assertFalse(sig["stall"])
        self.assertEqual(sig["unread_count"], 0)

    def test_no_stall_when_lead_acted_recently(self):
        # Unread exists but the lead posted a digest 1m ago.
        self.fx.events(
            make_event(1, "alice", minutes_ago=10),
            make_event(2, "lead", "digest", {"digest": "d"}, minutes_ago=1),
        )
        sig = wd.stall_signature(self.fx.root, "lead", idle_min=5)
        self.assertFalse(sig["stall"])
        self.assertEqual(sig["unread_count"], 1)  # only alice's event
        self.assertLess(sig["lead_idle_min"], 5.0)

    def test_lead_own_events_never_unread(self):
        # Lead's own digest must not count as unread even with watermark 0.
        self.fx.events(
            make_event(1, "alice", minutes_ago=10),
            make_event(2, "lead", "digest", {"digest": "d"}, minutes_ago=9),
        )
        sig = wd.stall_signature(self.fx.root, "lead", idle_min=5)
        self.assertTrue(sig["stall"])  # idle 9m, 1 unread
        self.assertEqual(sig["unread_count"], 1)
        self.assertEqual(sig["unread_events"][0]["from"], "alice")

    def test_compaction_safe_when_watermark_covers_live_log(self):
        # Everything live has been read (watermark == last seq).
        self.fx.events(
            make_event(6, "alice", minutes_ago=10),
            make_event(7, "bob", minutes_ago=8),
        )
        self.fx.watermark("lead", 7)
        sig = wd.stall_signature(self.fx.root, "lead", idle_min=5)
        self.assertFalse(sig["stall"])
        self.assertEqual(sig["unread_count"], 0)

    def test_watermark_referencing_archived_seq_still_works(self):
        # Watermark points at an archived seq (5) not in the live log; live
        # events 6-7 are unread, so this is a stall if the lead is idle.
        self.fx.events(
            make_event(6, "alice", minutes_ago=10),
            make_event(7, "bob", minutes_ago=8),
        )
        self.fx.watermark("lead", 5)
        sig = wd.stall_signature(self.fx.root, "lead", idle_min=5)
        self.assertTrue(sig["stall"])
        self.assertEqual(sig["unread_count"], 2)

    def test_digest_at_fallback_for_lead_activity(self):
        # No lead-authored events, but the last digest is 9m old.
        self.fx.events(make_event(1, "alice", minutes_ago=10))
        self.fx.state(digest_at=iso_at(9), last_digest_seq=1)
        sig = wd.stall_signature(self.fx.root, "lead", idle_min=5)
        self.assertTrue(sig["stall"])
        self.assertEqual(sig["last_digest_seq"], 1)

    def test_fresh_team_is_not_a_stall(self):
        # Teammates just started posting 2m ago; the lead hasn't acted yet.
        self.fx.events(make_event(1, "alice", minutes_ago=2))
        sig = wd.stall_signature(self.fx.root, "lead", idle_min=5)
        self.assertFalse(sig["stall"])

    def test_boundary_at_idle_threshold(self):
        self.fx.events(make_event(1, "alice", minutes_ago=5.0))
        sig = wd.stall_signature(self.fx.root, "lead", idle_min=5)
        self.assertTrue(sig["stall"])
        sig2 = wd.stall_signature(self.fx.root, "lead", idle_min=6)
        self.assertFalse(sig2["stall"])


class CliTest(unittest.TestCase):
    def test_cli_prints_json(self):
        fx = BulletinFixture()
        fx.events(make_event(1, "alice", minutes_ago=10))
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = wd.main(["--root", fx.root, "--lead", "lead", "--idle-min", "5"])
        self.assertEqual(rc, 0)
        sig = json.loads(buf.getvalue())
        self.assertTrue(sig["stall"])
        self.assertEqual(sig["unread_count"], 1)


if __name__ == "__main__":
    unittest.main()
