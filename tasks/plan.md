# Implementation Plan: Watchdog stall detection for the lead agent

Spec: `docs/specs/watchdog-stall-detection.md`
Task list: `tasks/todo.md`

## Overview

Add an automated watchdog to `scripts/start-team.py`: while the team is
attached, a daemon thread polls the bulletin root every ~20s; if the lead
agent has been idle ≥ 5 minutes with unread bulletin events (the stall
signature from issue #1), it injects a nudge into the lead's tmux pane —
"run `bulletin_read`; do not wait for direct messages" — the same mechanism
a human used to un-stall the HEAL-6 dogfood run. Detection lives in a new
pure-stdlib module (`scripts/bulletin_watchdog.py`) with a CLI, unit-tested
via `unittest` and wired into CI.

## Architecture Decisions

- **Detection in Python, not TS.** The launcher is Python stdlib-only; the
  stall signature is a pure file read over `events.jsonl` /
  `watermarks.json` / `state.json`. Duplicating it in the TS store for an
  extension tool is deferred (keeps one source of truth for v1).
- **Nudge = tmux send-keys to the lead pane.** Proven in the dogfood run.
  Guarded by session/pane liveness; debounced by a cooldown so we never
  spam the lead.
- **Watchdog never writes to the bulletin.** `events.jsonl` stays untouched;
  watchdog activity goes to stdout + `watchdog.log` in the capture dir.
- **Thread, not a separate pane.** A daemon thread in `start-team.py` avoids
  an extra tmux pane and lifecycle management; it stops when the session
  dies or attach returns.

## Stall signature (definition)

- `lead_watermark` = `watermarks.json[lead] ?? 0`
- `unread` = live events with `seq > lead_watermark` and `from != lead`
- `last_read_ts` = newest live event with `seq <= lead_watermark` (None if
  watermark = 0)
- `last_action_ts` = newest event authored by the lead; fallback
  `state.digestAt`
- `lead_idle_min` = minutes since `max(last_read_ts, last_action_ts)`; if no
  activity at all, minutes since the oldest live event (run start)
- `stall` = `unread` non-empty **and** `lead_idle_min >= idle_min`

## Task List

### Phase 1: Detection (foundation)

- [ ] Task 1: Detection module + CLI — `scripts/bulletin_watchdog.py`
- [ ] Task 2: Python unit tests + CI — `scripts/test_bulletin_watchdog.py`,
      `.github/workflows/ci.yml`

### Checkpoint: Detection

- [ ] `python3 scripts/test_bulletin_watchdog.py` passes (all scenarios)
- [ ] CLI prints a correct JSON signature on a fixture root
- [ ] `npm test` still green (16)

### Phase 2: Launcher integration (core)

- [ ] Task 3: Watchdog thread + flags + nudge — `scripts/start-team.py`

### Checkpoint: Launcher

- [ ] Flags parse; `--no-watchdog` reproduces today's behavior
- [ ] Manual dryrun: stalled lead gets exactly one nudge per cooldown;
      nudge clears after the lead reads

### Phase 3: Polish

- [ ] Task 4: Docs — `skills/bulletin.md`, `README.md`, usage string
- [ ] Task 5: Manual end-to-end verification (dryrun)
- [ ] Task 6: Full-suite verification (`npm test`, `npm run typecheck`,
      Python tests)

### Checkpoint: Complete

- [ ] All acceptance criteria in the spec met
- [ ] Ready for review / commit

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Nudge interrupts a healthy lead mid-task | Low | Only fires with unread events; text is protocol-correct (`bulletin_read`) |
| Nudge spam | Low | Cooldown `--watchdog-nudge-min`; one nudge per window |
| tmux send-keys fails (pane dead) | Low | Liveness guard + swallow/log errors |
| Python/TS logic drift later | Med | v1 keeps detection solely in Python; note extension tool as future work |
| False "stall" during legit fan-out | Low | Idle-min default 5m + configurable; nudge is harmless in that case |

## Open Questions

None blocking. See spec `Open Questions` for future candidates.
