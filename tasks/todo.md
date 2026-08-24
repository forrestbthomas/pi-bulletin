# Task List — Watchdog stall detection (lead agent)

Spec: `docs/specs/watchdog-stall-detection.md`
Plan: `tasks/plan.md`

## Phase 1: Detection (foundation)

### Task 1: Detection module + CLI

**Description:** Add `scripts/bulletin_watchdog.py` (stdlib only) with
`stall_signature(root, lead, idle_min)` implementing the stall signature
(unread non-lead events beyond the lead watermark + lead idle ≥ idle-min)
and a `main()` CLI printing JSON (`--root`, `--lead`, `--idle-min`).

**Acceptance criteria:**
- [x] `stall_signature` returns the documented shape: `stall`,
      `unread_count`, `lead_idle_min`, `unread_events`, `lead_watermark`,
      `last_digest_seq`
- [x] Lead's own events never counted as unread
- [x] Compaction-safe: watermark > last live seq → `unread_count: 0`
- [x] CLI prints valid JSON and exits 0

**Verification:**
- [x] Python tests pass: `python3 scripts/test_bulletin_watchdog.py`
- [x] Manual check: run CLI against a fixture root

**Dependencies:** None

**Files likely touched:**
- `scripts/bulletin_watchdog.py` (new)

**Estimated scope:** Small (1 file)

### Task 2: Python unit tests + CI

**Description:** Add `scripts/test_bulletin_watchdog.py` (stdlib unittest,
hermetic temp roots mirroring the `PI_BULLETIN_ROOT` pattern) covering the
spec's acceptance criteria, and wire it into `.github/workflows/ci.yml`.

**Acceptance criteria:**
- [x] Tests cover: stall happy path; non-stall when current; non-stall when
      lead recently active; empty bulletin; lead events excluded; compaction
      case; never-read lead fallback
- [x] CI runs `python3 scripts/test_bulletin_watchdog.py`

**Verification:**
- [x] `python3 scripts/test_bulletin_watchdog.py` passes locally
- [x] `npm test` still green (16)

**Dependencies:** Task 1

**Files likely touched:**
- `scripts/test_bulletin_watchdog.py` (new)
- `.github/workflows/ci.yml`

**Estimated scope:** Small (2 files)

## Checkpoint: Detection

- [x] `python3 scripts/test_bulletin_watchdog.py` passes (all scenarios)
- [x] CLI prints a correct JSON signature on a fixture root
- [x] `npm test` still green (16)

## Phase 2: Launcher integration (core)

### Task 3: Watchdog thread + flags + nudge

**Description:** In `scripts/start-team.py`, add a daemon watchdog thread
that polls the bulletin root while attached. Flags: `--no-watchdog`,
`--watchdog-idle-min` (default 5), `--watchdog-interval` (default 20),
`--watchdog-nudge-min` (default = idle-min). On stall, `tmux send-keys` a
nudge into the lead pane (`{session}.0`): tell the lead to `bulletin_read`
and not wait for direct messages. Debounce by cooldown; guard with
session/pane liveness; log to stdout and append to `watchdog.log` in the
capture dir. Never write to the bulletin.

**Acceptance criteria:**
- [x] At most one nudge per cooldown window while a stall persists
- [x] Nudge stops when the lead reads (watermark advances → unread 0)
- [x] No nudge sent to a dead/missing pane; no tmux errors crash the launcher
- [x] `--no-watchdog` reproduces today's behavior exactly
- [x] `events.jsonl` unchanged by the watchdog

**Verification:**
- [x] Manual dryrun: `./start-team.py --team <t> --dryrun`, leave lead idle,
      confirm nudge text appears in the lead pane; then have the lead read
      and confirm it clears
- [x] `python3 scripts/test_bulletin_watchdog.py` and `npm test` pass

**Dependencies:** Task 1

**Files likely touched:**
- `scripts/start-team.py`

**Estimated scope:** Medium (1 file, ~80 lines)

## Checkpoint: Launcher

- [x] Flags parse; `--no-watchdog` reproduces today's behavior
- [x] Manual dryrun: stalled lead gets exactly one nudge per cooldown;
      nudge clears after the lead reads

## Phase 3: Polish

### Task 4: Docs

**Description:** Document the watchdog: a section in `skills/bulletin.md`
(agents should expect watchdog nudges and treat them as protocol reminders,
not human commands), a "Watchdog" section in `README.md`, and the flags in
the `start-team.py` usage string/docstring.

**Acceptance criteria:**
- [x] `skills/bulletin.md` describes the watchdog and the correct response
      (`bulletin_read`, never wait for messages)
- [x] `README.md` documents the flags and default behavior
- [x] `start-team.py --help` shows the new flags

**Verification:**
- [x] `./start-team.py --help` renders the new flags
- [x] Docs read cleanly

**Dependencies:** Task 3

**Files likely touched:**
- `skills/bulletin.md`
- `README.md`
- `scripts/start-team.py` (docstring/usage)

**Estimated scope:** Small (3 files)

### Task 5: Manual end-to-end verification

**Description:** Run a 2-role dryrun team; verify the full loop: teammates
post, lead stays idle past the threshold, nudge appears, lead reads, stall
clears. Also verify `--no-watchdog` and a dead-pane case.

**Acceptance criteria:**
- [x] Nudge appears in the lead pane within ~idle-min + interval of the
      first unread event
- [x] Stall clears after the lead reads
- [x] `watchdog.log` written to the capture dir

**Verification:**
- [x] Observed in a live dryrun

**Dependencies:** Tasks 3-4

**Files likely touched:** none (manual)

**Estimated scope:** XS

### Task 6: Full-suite verification

**Description:** Run the complete verification set and confirm the spec's
acceptance criteria are all met.

**Acceptance criteria:**
- [x] All spec acceptance criteria met
- [x] Repo ready for commit

**Verification:**
- [x] `npm test`
- [x] `npm run typecheck`
- [x] `python3 scripts/test_bulletin_watchdog.py`

**Dependencies:** Task 5

**Files likely touched:** none

**Estimated scope:** XS

## Checkpoint: Complete

- [x] All acceptance criteria in the spec met
- [x] Ready for review / commit
