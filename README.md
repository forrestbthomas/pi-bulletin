# pi-bulletin

[![npm version](https://img.shields.io/npm/v/pi-bulletin)](https://www.npmjs.com/package/pi-bulletin)
[![CI](https://img.shields.io/github/actions/workflow/status/forrestbthomas/pi-bulletin/ci.yml?branch=main)](https://github.com/forrestbthomas/pi-bulletin/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/forrestbthomas/pi-bulletin)](LICENSE)

Bulletin-first agent coordination for [Pi](https://pi.dev/): a shared
blackboard where agents post findings cheaply, a lead/summarizer compresses
them into a digest **once per round**, and conflicts are reconciled only
when cheap symbolic checks say they matter.

Built because peer message passing (the pi-teams / Claude Agent Teams
mailbox model) thrashes: every message is a full LLM turn injected into the
recipient's context, teammates have no shared situational awareness, and the
coordination layer is tightly coupled to agent lifecycle. pi-bulletin
separates the two: **reconcile the shared state, not the conversations.**

**Status:** v0.3.0 (watchdog + OSS maturity) on npm. The design was measured in a
side-by-side eval against
pi-teams on a 5-agent read-only review task: the bulletin leg completed
(4m14s, ~$0.80, 6 code-cited findings); the pi-teams leg failed to complete
(reproducible teammate startup stall, 2/2 attempts). Evidence:
`eval-output/leg-b/`.

## The model

- **Cheap (never an LLM call):** post findings, read the bulletin, symbolic
  conflict checks. Pure file I/O over `~/.pi/teams/<team>/`.
- **Expensive (LLM) only at sync points:** one digest per round
  (`bulletin_sync`), LLM reconciliation only for unresolved conflicts.
- **Decoupled from agent lifecycle:** agents are ordinary Pi sessions
  sharing a file. A slow or stuck agent doesn't wedge the team — others
  proceed and it catches up by reading the digest.
- **Durable and honest:** appends are fsync'd before acknowledgement and
  snapshots are written atomically (temp + rename), so a crash mid-write
  cannot corrupt the bulletin — a torn tail is detected and truncated on the
  next read. Conflicts are evidence-tiered (proposed/confirmed/contested),
  same-author corrections are updates not conflicts, and a resolved losing
  claim is kept in the log as a superseded audit marker — never silently
  erased.
- **Auditable digest rounds:** each digest is a structured snapshot
  (Decisions / Findings / Open questions, each item carrying event-ID
  evidence + status), fenced by a monotonic round and lead identity (one
  writer per round; stale/duplicate digests are rejected), and replayable
  from the digest log (`digests.jsonl`) if `state.json` is lost.

Research mapping and design rationale: `docs/DESIGN.md`. The full eval
protocol: `docs/EVAL-PLAN.md`.

## Usage

Install the package (as a Pi package):

```bash
pi install npm:pi-bulletin      # once published
# or locally during development:
pi install file:/path/to/pi-bulletin
```

Agents coordinate through the `bulletin_*` tools — no peer message passing:

```text
bulletin_status(team_name="team-a")                      # confirm the bulletin exists
bulletin_post(team_name="team-a", kind="finding",
              ref="api", claim="endpoint moved to /v2")  # cheap share
bulletin_read(team_name="team-a")                        # what changed since my last read
bulletin_conflicts(team_name="team-a", since_seq=3)      # cheap symbolic conflict check
bulletin_sync(team_name="team-a", digest="round 1: ...") # lead compresses one digest/round
```

Full protocol (fan out → observe → sync round → reconcile-on-conflict):
`skills/bulletin.md`.

## Tools

| Tool | Cost | Purpose |
|---|---|---|
| `bulletin_status` | cheap | team root, event count, last digest |
| `bulletin_post` | cheap | post a finding/signal (structured `ref` + `claim`, optional `status` tier) |
| `bulletin_read` | cheap | catch up since a seq (per-agent watermark) |
| `bulletin_conflicts` | cheap | evidence-tiered symbolic same-ref/different-value check (updates vs conflicts vs superseded) |
| `bulletin_compact` | cheap | archive old events; keeps the live log lean |
| `bulletin_resolve` | cheap | record a conflict decision (lead only; optional `rationale`, `decision_evidence`, `supersedes` audit) |
| `bulletin_sync` | LLM (1/round) | lead compresses everything since last digest; structured `decisions`/`findings`/`open` with evidence seqs; round-fenced |

## Development

```bash
npm install
npm test          # hermetic store tests (PI_BULLETIN_ROOT override)
npm run typecheck # extension + store typecheck
python3 scripts/test_bulletin_watchdog.py   # watchdog tests (stdlib unittest)
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full contributor guide
(setup, commit style, versioning, releases).

## Security

Report vulnerabilities privately via GitHub's Security tab — see
[`SECURITY.md`](SECURITY.md). A gitleaks secret scan runs in CI and as a
maintainer-machine pre-push hook; never commit API keys or tokens.

## Changelog

See [`CHANGELOG.md`](CHANGELOG.md) (Keep a Changelog format).

## License

MIT — see `LICENSE`.
