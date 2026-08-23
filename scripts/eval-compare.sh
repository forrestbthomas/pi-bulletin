#!/usr/bin/env bash
# pi-bulletin vs pi-teams — side-by-side eval (requires an interactive terminal).
#
# This eval cannot run headless: the pi-teams leg needs tmux (or iTerm2/WezTerm)
# and a human to drive the team lead from a terminal. Run it when tmux is
# installed and the Bitwarden vault is unlocked (bw unlock / BW_SESSION set).
#
# Usage:
#   ./eval-compare.sh <task> [team-name]
# Example:
#   ./eval-compare.sh "Review this repo: one agent hunts bugs, one hunts
#   complexity, one plays devil's advocate — then synthesize" research-review
#
# Output: eval-output/ with per-leg session notes + a measurement ledger.

set -euo pipefail

TASK="${1:?pass a task prompt}"
TEAM="${2:-compare-$(date +%Y%m%d-%H%M%S)}"
OUT="eval-output/${TEAM}"
mkdir -p "$OUT"

echo "== pi-bulletin vs pi-teams eval =="
echo "task: $TASK"
echo "team: $TEAM"
echo "output: $OUT"

# --- prerequisites ---------------------------------------------------------
for bin in pi bw; do command -v "$bin" >/dev/null || { echo "missing: $bin"; exit 1; }; done
if [[ -z "${BW_SESSION:-}" ]]; then echo "missing: BW_SESSION (run: bw unlock)"; exit 1; fi
if ! command -v tmux >/dev/null; then
  echo "WARNING: tmux not found — the pi-teams leg needs tmux (or iTerm2/WezTerm)."
  echo "         Install with: brew install tmux"
fi

echo "== 1/4 pi-bulletin leg =="
# NOTE: scaffolding-only — the authoritative protocol is docs/EVAL-PLAN.md (rev 2).
# Token capture is per-session Usage fields in .pi/sessions/*.jsonl, NOT the
# pi-run cost ledger (ad-hoc pi sessions do not write .pi/cost-ledger.jsonl).
echo "Prereq: pi-bulletin installed in the project's .pi packages and each of the"
echo "        5 sessions launched with PI_BULLETIN_AGENT=<name> and the same team."
echo "Drive:  follow skills/bulletin.md; each agent posts findings; the lead runs"
echo "        bulletin_conflicts + bulletin_sync once per round."
echo "Record: session notes -> $OUT/bulletin-leg.md ; tokens from .pi/sessions/*.jsonl"

echo "== 2/4 pi-teams leg =="
# Session files land in the worktree's .pi/sessions/ (given correct spawn cwd),
# NOT ~/.pi/agent/teams/ (that path is only in the cleanup tool description).
echo "Prereq: run inside tmux (or iTerm2) in the try-pi-teams worktree"
echo "        (.worktrees/try-pi-teams) so npm:pi-teams is loaded."
echo "Drive:  spawn the same 5 roles; use the same task prompt; let the team run"
echo "        to completion; capture the transcript and task board."
echo "Record: session notes -> $OUT/teams-leg.md ; tokens from .pi/sessions/*.jsonl"

echo "== 3/4 measurements (same for both legs) =="
cat > "$OUT/measurements.md" <<'EOF'
| metric | pi-bulletin | pi-teams |
|---|---|---|
| wall-clock (start→done) | | |
| total tokens (provider usage / cost ledger) | | |
| # coordination events (posts vs messages) | | |
| # LLM turns spent on coordination (digests vs inbox messages) | | |
| # conflicts detected (cheap check) | | |
| output quality (harness judge rubric, 0–1) | | |
| MAST-style failure-mode count (transcript) | | |
EOF

echo "== 4/4 quality + failure taxonomy =="
cat >> "$OUT/measurements.md" <<'EOF'
Quality rubric: factual accuracy, completeness (all requested aspects),
source/evidence quality, tool efficiency.
MAST failure modes to count (arXiv 2503.13657): step repetition, task
derailment, information withholding, ignoring other agents' input,
premature termination, incomplete/incorrect verification.
EOF

echo
echo "Done scaffolding. Fill in $OUT/measurements.md per leg and compare."
echo "Hypothesis (from the research note): bulletin uses fewer tokens (no"
echo "per-message context injection) with comparable or better quality."
