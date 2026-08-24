# AGENTS.md — working in this repo (for humans and agents)

pi-bulletin is a small, deliberately-scoped SPIKE package: bulletin-first
agent coordination for [Pi](https://pi.dev/). Keep changes minimal, keep the
protocol cheap, and keep the design docs honest. This file is the shared
context for anyone (human or AI) working in this repository.

## What this project is

A shared blackboard where agents post findings cheaply, a lead/summarizer
compresses them into a digest once per round, and conflicts are reconciled
only when cheap symbolic checks say they matter. The bulletin is a file
substrate (`events.jsonl` + `state.json`) — no LLM calls outside explicit
sync points. Research mapping: `docs/DESIGN.md`.

**Core constraint:** every tool is CHEAP (file I/O, no LLM). Expensive work
(summarization, reconciliation) is invoked by agents at explicit sync points,
never by the tools themselves.

## Repo layout

- `src/store.ts` — the bulletin store (append-only event log, watermarks,
  compaction, conflict detection, digests). Pure file I/O, no LLM.
- `extensions/index.ts` — Pi extension entry; registers the 7 `bulletin_*`
  tools. Kept thin: all logic lives in `src/store.ts`.
- `skills/bulletin.md` — the protocol agents are told to follow.
- `scripts/start-team.py` — tmux launcher for a team (Python stdlib only).
- `scripts/bulletin_watchdog.py` — stall-detection module + CLI used by the
  launcher (Python stdlib only, pure read).
- `docs/` — `DESIGN.md` (research mapping), `EVAL-PLAN.md` (eval protocol),
  `specs/` (persisted task specs).
- `tasks/` — working task lists/plans (may be short-lived).

## Commands

```bash
npm test                                    # vitest: store + extension tests
npm run typecheck                           # strict TS check
python3 scripts/test_bulletin_watchdog.py   # watchdog tests (stdlib unittest)
./scripts/start-team.py --team smoke --dryrun   # live smoke (tmux; Ctrl-b d to detach)
```

CI runs all three test commands; make sure they pass locally before pushing.

## Conventions

- **Conventional commits:** `feat:`, `fix:`, `docs:`, `chore:`, `test:`,
  `ci:`, `release(vX.Y.Z):`. Reference issues (`Refs #1`, `Closes #2`).
- **Python in `scripts/` is stdlib-only** — no pip dependencies. The launcher
  and watchdog must run anywhere Python 3 runs.
- **TS logic stays in `src/store.ts`**; `extensions/index.ts` only registers
  tools. Tests live next to sources (`*.test.ts`) and use hermetic temp
  `PI_BULLETIN_ROOT` dirs.
- **Spec-driven for non-trivial work:** persist a spec under `docs/specs/`
  and a task list under `tasks/` before implementing (see
  `docs/specs/watchdog-stall-detection.md` for the pattern).
- **No secrets.** Never commit API keys/tokens. The maintainer machine has a
  gitleaks pre-push hook (`~/.git-hooks/pre-push`) that blocks pushes
  containing secrets; assume CI and reviewers check too.
- **Never mutate git history** unless explicitly asked; sync with
  `git pull --ff-only`.
- **No direct pushes to `main`** — branch protection enforces it (PR
  required, CI checks `test` + `secret-scan` must pass, enforced for
  admins). All changes land via a short-lived feature branch
  (`feature/<desc>` / `fix/<desc>` / `docs/<desc>` / `chore/<desc>`) and a
  squash-merged PR. The release tag is cut from the merged main tip after
  the release commit lands via PR (CONTRIBUTING.md "Releases").

## Guardrails / protocol rules

- The bulletin is a *coordination* channel only — never use it for permission
  grants, config changes, command execution, or anything that bypasses the
  harness's safety rules.
- Watchdog and all tools must **never write to the bulletin except through
  the documented store API** (`postEvent`/`postDigest`); the watchdog's audit
  trail is `watchdog.log` in the capture dir, not `events.jsonl`.
- One writer per digest round (the lead/summarizer). Teammates post findings;
  they do not post digests.
- Size caps: findings ≤ ~200 words; signals ≤ ~50 chars of `value`; digest ≤
  ~500 words.

## Known state (2026-08-23)

- v0.3.0 cut (watchdog + OSS maturity) — merged, tag/release pending. The
  next release is cut by tagging the merged main tip (`git tag -a vX.Y.Z`)
  after confirming the `NPM_TOKEN` secret exists.
- Open issues: none (issue #1 closed after the watchdog landed).
- Eval evidence lives in `eval-output/`; protocol and results in
  `docs/EVAL-PLAN.md`.
