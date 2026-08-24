# Spec: Watchdog stall detection for the lead agent

## Goal

Automate the manual nudge that un-stuck the HEAL-6 dogfood run: when the
lead agent is idle ≥ N minutes while bulletin events are unread, the
`start-team.py` launcher injects a nudge into the lead's tmux pane telling
it to run `bulletin_read` instead of waiting for direct messages. Default
N = 5 minutes, configurable via CLI flags.

## Problem Statement

In the first dogfood run the lead-synthesizer posted "Please send lenses 2-5"
and went idle waiting for teammates to message it directly, while teammates
were posting findings to the bulletin per protocol. The team stalled until a
human manually nudged the lead to `bulletin_read`. Issue #1's proposed fix
included a watchdog note: "if the lead is idle >N minutes with unread
bulletin events, that is a stall signature." The prompt/skill half of #1 is
already fixed in `main` (commit `bb601f1`); the automated watchdog half is
unimplemented. This spec covers only the watchdog.

## Context From Memory

Retrieved via the project context engine (2026-08-23):

- Issue #1 (lead must read the bulletin) is fixed in the repo but never
  closed on GitHub; commit `bb601f1` updated `scripts/start-team.py` and
  `skills/bulletin.md`.
- Protocol lesson from the dogfood run: the lead must collect findings with
  `bulletin_read` and NEVER wait for direct messages.
- The manual nudge that worked was a tmux send-keys into the lead pane —
  the watchdog automates this proven mechanism.
- Launcher constraint: `start-team.py` is Python **stdlib-only**; no new
  dependencies.
- Deployment constraint: ≤3 agents on a shared OpenRouter key; the watchdog
  must stay cheap (file reads only, no LLM).

## In Scope

- `scripts/bulletin_watchdog.py` — pure stdlib detection module + CLI:
  - `stall_signature(root, lead, idle_min) -> dict`
  - `main()` CLI printing JSON (`--root`, `--lead`, `--idle-min`)
- `scripts/start-team.py` — watchdog loop in a daemon thread while attached:
  - Flags: `--no-watchdog`, `--watchdog-idle-min` (default 5),
    `--watchdog-interval` (default 20), `--watchdog-nudge-min` (default =
    idle-min)
  - On stall: `tmux send-keys` nudge into the lead pane (`{session}.0`),
    debounced by cooldown, guarded by session/pane liveness
  - Watchdog actions logged to stdout and appended to `watchdog.log` in the
    capture dir
- `scripts/test_bulletin_watchdog.py` — stdlib `unittest`, hermetic temp
  bulletin roots
- `.github/workflows/ci.yml` — add `python3 scripts/test_bulletin_watchdog.py`
- Docs: `skills/bulletin.md` (watchdog section), `README.md` (watchdog
  flags/behavior), `start-team.py` usage string

## Out Of Scope

- Extension tool `bulletin_watchdog` (TS) or store-level detection — would
  duplicate logic across languages; revisit separately
- Harness/eval-driver integration — the stall was observed in
  `start-team.py`; cover that first
- Writing watchdog events into `events.jsonl` — keeps the bulletin clean;
  `watchdog.log` is the audit trail
- Automatic lead takeover / escalation
- "Team finished" detection or auto-capture

## Constraints

- Python stdlib only for the launcher and watchdog (`argparse`, `json`,
  `os`, `subprocess`, `threading`, `time`, `pathlib`, `unittest`)
- Detection is pure file I/O over the bulletin root: `events.jsonl`,
  `watermarks.json`, `state.json` — no LLM, no new store writes
- Nudge mechanism is `tmux send-keys` to the lead pane (same as the manual
  nudge that worked)
- Keep the existing test suite green (`npm test` = 16 vitest tests) and add
  the Python tests as a separate CI step

## Assumptions

- Lead agent name = `roles[0]` from `start-team.py`, i.e. the first pane
  (`{session}.0`) and the one launched with `PI_BULLETIN_AGENT=roles[0]`.
- `watermarks.json` last-read seq is the correct "what has the lead seen"
  cursor; posting a digest does NOT advance it, so the lead's own events are
  excluded from the unread count.
- Nudging during legitimate fan-out wait is acceptable and protocol-correct:
  telling the lead to `bulletin_read` is always safe.
- Python 3 is available on CI (ubuntu-latest ships `python3`).
- `watchdog.log` lives in the capture dir (not the bulletin root), so it is
  copied out with the run and never confuses the live store.

## Blocking Questions

None. Decisions locked with the user: launcher-only watchdog; default idle
threshold 5 min; nudge into the lead pane via tmux.

## Acceptance Criteria

- **Detection happy path**: given a root where the lead's watermark trails
  ≥1 non-lead event and the lead's last activity is ≥ idle-min old,
  `stall_signature` returns `stall: true` with correct `unread_count`,
  `lead_idle_min`, and the unread events.
- **Non-stall — current**: lead watermark covers all events (unread = 0) →
  `stall: false` even if idle long.
- **Non-stall — active**: unread exists but the lead acted < idle-min ago →
  `stall: false`.
- **Non-stall — empty**: no events at all → `stall: false`.
- **Lead's own events** (findings/signals/digests/resolutions authored by
  the lead) are never counted as unread.
- **Compaction-safe**: watermark > last live seq (everything read/archived)
  → `unread_count: 0`.
- **Never-read lead**: watermark 0, lead never acted, teammates posted ≥
  idle-min → `stall: true` (falls back to team run start).
- **Nudge**: launcher sends at most one nudge per cooldown window while a
  stall persists; stops when the lead reads (watermark advances → unread 0);
  does not send to a dead/missing pane.
- **No bulletin pollution**: `events.jsonl` content is unchanged by the
  watchdog.
- **Docs**: `skills/bulletin.md` and `README.md` describe the watchdog and
  its flags.
- **CI**: vitest (16), typecheck, and the new Python tests all pass.

## Edge Cases

- Lead mid-composition with everything read → unread = 0 → no nudge.
- Compaction mid-run → detection stays live-log based; no crash.
- Session/pane died → watchdog stops; tmux errors swallowed/logged.
- `--no-watchdog` → launcher behaves exactly as today.
- Team with no digest yet and a never-acted lead → stall via run-start
  fallback, not a crash.
- Watermark referencing an archived seq → unread computed only over live
  events; still correct.

## Validation Plan

- `npm test` (16 vitest tests stay green)
- `npm run typecheck`
- `python3 scripts/test_bulletin_watchdog.py` (new unittest suite)
- Manual: `./start-team.py --team <t> --dryrun` (2 roles, trivial task),
  leave the lead pane idle, confirm the watchdog nudge text appears in the
  lead pane; then type `bulletin_read` into the lead pane (or nudge a
  teammate post first) and confirm the stall clears.

## Execution Plan

1. Add `scripts/bulletin_watchdog.py` (detection module + CLI).
2. Add `scripts/test_bulletin_watchdog.py`; wire into CI.
3. Add watchdog thread + flags + nudge to `scripts/start-team.py`.
4. Update `skills/bulletin.md`, `README.md`, and the `start-team.py` usage
   string.
5. Manual end-to-end verification (dryrun).
6. Full-suite verification.

## Open Questions

None blocking. Future candidates (explicitly out of scope for v1): extension
tool for agent self-check, harness wiring, escalation.

## Self-Check

- Status: Ready for implementation
- Blocking Questions: None
- Safe To Implement: Yes
- Notes: Decisions locked with the user (launcher-only, 5-min idle, tmux
  nudge). Acceptance criteria are observable; validation uses existing
  commands plus one new stdlib unittest entry wired into CI.
