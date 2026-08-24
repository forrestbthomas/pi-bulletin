#!/usr/bin/env python3
"""bulletin_watchdog.py — stall-signature detection for pi-bulletin teams.

Cheap, pure file I/O (no LLM, no writes to the bulletin): reads
events.jsonl, watermarks.json, and state.json from a bulletin root and
computes whether the lead agent shows the stall signature from issue #1:

    lead idle >= idle_min minutes  AND  unread non-lead events exist

Used by scripts/start-team.py to nudge a stalled lead, and runnable
standalone for inspection and tests:

    python3 scripts/bulletin_watchdog.py --root <dir> --lead <lead> [--idle-min 5]

Exit code is always 0 on success; the signature is printed as JSON.
Python stdlib only (matches the launcher constraint).

File formats (mirror src/store.ts):
  events.jsonl   — JSONL: {seq, ts (ISO), kind, from, data}
  watermarks.json — {"<agent>": <lastReadSeq>}
  state.json      — {lastDigestSeq, digest, digestAt, members}
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path


def _parse_ts(value: str) -> datetime:
    # store.ts writes new Date().toISOString() (trailing "Z"); Python's
    # fromisoformat only accepts "Z" natively on 3.11+, so normalize first.
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _minutes_between(now: datetime, ts: datetime) -> float:
    return max(0.0, (now - ts).total_seconds() / 60.0)


def _read_events(root) -> list:
    p = Path(root) / "events.jsonl"
    if not p.exists():
        return []
    out = []
    for line in p.read_text(encoding="utf8").splitlines():
        line = line.strip()
        if not line:
            continue
        ev = json.loads(line)
        ev["_ts"] = _parse_ts(ev["ts"])
        out.append(ev)
    return out


def _read_watermark(root, lead: str) -> int:
    p = Path(root) / "watermarks.json"
    if not p.exists():
        return 0
    try:
        w = json.loads(p.read_text(encoding="utf8"))
        return int(w.get(lead, 0) or 0)
    except (ValueError, json.JSONDecodeError):
        return 0


def _read_state(root):
    p = Path(root) / "state.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf8"))
    except json.JSONDecodeError:
        return None


def stall_signature(root, lead: str, idle_min: float = 5.0) -> dict:
    """Compute the lead stall signature for a bulletin root.

    stall == unread (non-lead) events exist AND the lead has been idle at
    least idle_min minutes. "Idle" is measured from the later of (a) the
    newest event the lead has covered with its read watermark and (b) the
    newest event authored by the lead (fallback: state.digestAt). If the
    lead has never acted at all, fall back to the team run start (oldest
    live event) so a never-observing lead is still caught.

    Pure read; never writes to the bulletin.
    """
    events = _read_events(root)
    now = _now()
    watermark = _read_watermark(root, lead)
    state = _read_state(root)

    # Unread from the lead's perspective: anything past its watermark that
    # it did not author itself (its own digest posts never count as unread).
    unread = [e for e in events if e["seq"] > watermark and e["from"] != lead]
    unread_events = [
        {
            "seq": e["seq"],
            "kind": e["kind"],
            "from": e["from"],
            "ref": (e.get("data") or {}).get("ref"),
        }
        for e in unread
    ]

    # When did the lead last read? Proxy: the newest event at or before its
    # watermark (the watermark file stores a seq, not a timestamp).
    read_ts = None
    if watermark > 0:
        covered = [e for e in events if e["seq"] <= watermark]
        if covered:
            read_ts = max(e["_ts"] for e in covered)

    # When did the lead last act? Newest authored event; fall back to the
    # last digest timestamp.
    action_ts = None
    lead_events = [e for e in events if e["from"] == lead]
    if lead_events:
        action_ts = max(e["_ts"] for e in lead_events)
    elif state and state.get("digestAt"):
        try:
            action_ts = _parse_ts(state["digestAt"])
        except ValueError:
            action_ts = None

    activity_ts = None
    for ts in (read_ts, action_ts):
        if ts is not None:
            activity_ts = ts if activity_ts is None else max(activity_ts, ts)

    if activity_ts is None and events:
        # Lead never observed nor acted: measure from team run start.
        activity_ts = min(e["_ts"] for e in events)

    raw_idle = _minutes_between(now, activity_ts) if activity_ts else 0.0
    stall = bool(unread) and raw_idle >= float(idle_min)

    return {
        "stall": stall,
        "unread_count": len(unread),
        "lead_idle_min": round(raw_idle, 1),
        "lead_watermark": watermark,
        "last_digest_seq": (state or {}).get("lastDigestSeq"),
        "last_digest_at": (state or {}).get("digestAt"),
        "unread_events": unread_events,
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="compute the lead stall signature for a pi-bulletin root"
    )
    ap.add_argument("--root", required=True,
                    help="bulletin root (dir containing events.jsonl / watermarks.json / state.json)")
    ap.add_argument("--lead", required=True, help="lead agent name")
    ap.add_argument("--idle-min", type=float, default=5.0,
                    help="stall threshold: lead idle minutes with unread events (default 5)")
    args = ap.parse_args(argv)

    sig = stall_signature(args.root, args.lead, args.idle_min)
    json.dump(sig, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
