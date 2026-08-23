#!/usr/bin/env python3
"""Sum token/cost usage from Pi session JSONL files (per-leg capture).

Parses the same fields pi-run `cost` reads (see internal/cli/cost.go):
records where type == "message" and message.usage.cost is present.
Malformed/partial lines are skipped — best-effort, like the Go parser.

Usage:
    python3 tokens.py <sessions-dir> [--json]

Prints per-file totals and a grand total (tokens in/out/total + cost USD).
"""
import argparse
import json
import sys
from pathlib import Path


def scan_file(path: Path):
    samples = []
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue  # partial write / schema drift
            msg = rec.get("message") or {}
            usage = msg.get("usage") or {}
            cost = usage.get("cost") or {}
            if rec.get("type") != "message" or not usage or cost.get("total") is None:
                continue
            samples.append(
                {
                    "provider": msg.get("provider"),
                    "model": msg.get("model"),
                    "input": usage.get("input") or 0,
                    "output": usage.get("output") or 0,
                    "total": usage.get("totalTokens") or 0,
                    "cost": cost.get("total") or 0.0,
                }
            )
    return samples


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("sessions_dir")
    ap.add_argument("--json", action="store_true", help="emit JSON summary")
    args = ap.parse_args()

    root = Path(args.sessions_dir)
    if not root.is_dir():
        print(f"tokens.py: {root} is not a directory", file=sys.stderr)
        return 1

    files = sorted(root.rglob("*.jsonl"))
    rows = []
    for f in files:
        samples = scan_file(f)
        if not samples:
            continue
        rows.append(
            {
                "file": str(f.relative_to(root)),
                "messages": len(samples),
                "input": sum(s["input"] for s in samples),
                "output": sum(s["output"] for s in samples),
                "total": sum(s["total"] for s in samples),
                "cost": round(sum(s["cost"] for s in samples), 6),
                "models": sorted({s["model"] for s in samples if s["model"]}),
            }
        )

    grand = {
        "files": len(rows),
        "messages": sum(r["messages"] for r in rows),
        "input": sum(r["input"] for r in rows),
        "output": sum(r["output"] for r in rows),
        "total": sum(r["total"] for r in rows),
        "cost": round(sum(r["cost"] for r in rows), 6),
    }

    if args.json:
        print(json.dumps({"files": rows, "total": grand}, indent=2))
        return 0

    if not rows:
        print("tokens.py: no usage samples found (empty or wrong schema?)")
        return 0
    for r in rows:
        print(
            f"{r['file']}: {r['messages']:>3} msgs  in {r['input']:>9,}  "
            f"out {r['output']:>9,}  total {r['total']:>10,}  ${r['cost']:.4f}"
            f"{'  [' + ','.join(r['models']) + ']' if r['models'] else ''}"
        )
    print(
        f"TOTAL: {grand['messages']} msgs  in {grand['input']:,}  "
        f"out {grand['output']:,}  total {grand['total']:,}  ${grand['cost']:.4f}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
