# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/) (0.x: anything can change until 1.0).

## [Unreleased]

## [0.5.0] - 2026-08-24

### Added

- **Auditable digest rounds**: digests are now structured snapshots with
  provenance. `bulletin_sync` accepts `decisions`, `findings`, and `open`
  sections; each item can carry event-ID `evidence` and an optional
  `status`, so the shared picture traces back to the underlying events.
  Contested items go in `open` and are never silently resolved.
- **Round/lead fencing**: digest writes are single-writer. The first digest
  sets the lead; later digests must come from the same lead and advance a
  monotonic round. Stale retries and duplicate syncs for the same round are
  rejected, so double digests are impossible.
- **Replayable state**: the latest digest state can be rebuilt from
  `digests.jsonl` independent of `state.json` — recovery and audit still
  work if the snapshot file is lost or corrupted.
- `bulletin_resolve` accepts an optional `rationale` recording why a decision
  was made; the decision's evidence seqs fold into the next digest's
  `decisions` section.

### Changed

- `bulletin_sync` and `bulletin_status` now report the digest round, lead,
  and coverage range (`coverageFrom..coverageTo`) showing which events each
  digest folded in.

## [0.4.0] - 2026-08-24

### Added

- **Evidence-tiered conflict detection**: `bulletin_conflicts` now reports
  hard/medium/soft tiers, distinguishes same-author corrections (updates)
  from cross-author conflicts, and compares canonicalized values (ref
  case/whitespace, numeric strings) so cosmetic differences no longer look
  like conflicts. `bulletin_post` accepts an optional `status`
  (proposed/confirmed/contested/superseded); corroboration — two or more
  agents posting the same canonical value — counts as confirmed.
- **Durability**: appends are fsync'd before acknowledgement and snapshots
  (`state.json`, watermarks, the post-compaction live log) are written
  atomically (temp + rename), so a crash mid-write cannot corrupt the
  bulletin. A torn tail (crash mid-append) is detected and truncated on the
  next read instead of breaking every subsequent read.
- `bulletin_resolve` accepts `decision_evidence` and `supersedes`; a
  resolution that supersedes specific events preserves the losing claims in
  the log and surfaces them as audit markers instead of silently erasing
  them.

### Changed

- `bulletin_conflicts` returns a richer shape (tier, authors, kind, status)
  alongside the existing ref/value/seq fields; output stays additive and
  backward compatible.

### Fixed

- A crash mid-append no longer breaks every subsequent read of the bulletin
  (torn-tail recovery in `readEvents`).

## [0.3.0] - 2026-08-23

### Added

- **Watchdog stall detection for the lead agent** (PR #2): `start-team.py`
  now runs a watchdog while a team is attached. If the lead is idle ≥ N
  minutes (default 5) with unread non-lead bulletin events, it injects a
  nudge into the lead's pane telling it to `bulletin_read` instead of
  waiting for direct messages. Detection lives in
  `scripts/bulletin_watchdog.py` (pure file I/O, never writes to the
  bulletin); new flags: `--no-watchdog`, `--watchdog-idle-min`,
  `--watchdog-interval`, `--watchdog-nudge-min`.
- Lead prompt + skill now state explicitly that teammates never message the
  lead directly; the lead collects findings with `bulletin_read` and never
  waits for "sent" input (fixes the HEAL-6 dogfood stall, issue #1).
- OSS maturity: `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`,
  `AGENTS.md`, issue/PR templates, `CODEOWNERS`, `CHANGELOG.md`, Dependabot,
  CodeQL, and a release workflow (npm publish + GitHub releases).

### Fixed

- `start-team.py` capture no longer copies the bulletin into itself (live
  bulletin root is outside the capture dir).

## [0.2.0] - 2026-08-23

### Added

- **Protocol v0.2** (PR #1): per-agent read watermarks (`bulletin_read`
  returns only NEW events and advances the agent's cursor), digest
  compaction (`bulletin_compact` archives events at/before the last digest;
  seq high-watermark keeps ids unique), and conflict resolution
  (`bulletin_resolve` suppresses a ref from future symbolic checks).
- Standalone `scripts/start-team.py` launcher (tmux panes, role prompts,
  capture of sessions + bulletin state after detach).
- CI: GitHub Actions (`npm test` + `npm run typecheck`) + extension
  registration tests.

### Changed

- Tool surface is now 7 tools: `bulletin_status`, `bulletin_post`,
  `bulletin_read`, `bulletin_conflicts`, `bulletin_compact`,
  `bulletin_resolve`, `bulletin_sync`.

## [0.1.0] - 2026-08-23

### Added

- Initial scaffold: shared bulletin store (`src/store.ts`, append-only event
  log + digest snapshot), extension tool registration (`extensions/index.ts`),
  `skills/bulletin.md` protocol (fan out → observe → sync round →
  reconcile-on-conflict), `docs/DESIGN.md` research mapping, and the
  side-by-side eval evidence (`eval-output/`).

[Unreleased]: https://github.com/forrestbthomas/pi-bulletin/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/forrestbthomas/pi-bulletin/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/forrestbthomas/pi-bulletin/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/forrestbthomas/pi-bulletin/releases/tag/v0.1.0
