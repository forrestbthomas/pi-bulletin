# pi-bulletin

Bulletin-first agent coordination for [Pi](https://pi.dev/): a shared
blackboard where agents post findings cheaply, a lead/summarizer compresses
them into a digest **once per round**, and conflicts are reconciled only
when cheap symbolic checks say they matter.

Built because peer message passing (the pi-teams / Claude Agent Teams
mailbox model) thrashes: every message is a full LLM turn injected into the
recipient's context, teammates have no shared situational awareness, and the
coordination layer is tightly coupled to agent lifecycle. pi-bulletin
separates the two: **reconcile the shared state, not the conversations.**

**Status:** v0.1.0, early but validated. The design was measured in a
side-by-side eval against pi-teams on a 5-agent read-only review task: the
bulletin leg completed (4m14s, ~$0.80, 6 code-cited findings); the pi-teams
leg failed to complete (reproducible teammate startup stall, 2/2 attempts).
Evidence: `eval-output/leg-b/`.

## The model

- **Cheap (never an LLM call):** post findings, read the bulletin, symbolic
  conflict checks. Pure file I/O over `~/.pi/teams/<team>/`.
- **Expensive (LLM) only at sync points:** one digest per round
  (`bulletin_sync`), LLM reconciliation only for unresolved conflicts.
- **Decoupled from agent lifecycle:** agents are ordinary Pi sessions
  sharing a file. A slow or stuck agent doesn't wedge the team — others
  proceed and it catches up by reading the digest.

Research mapping and design rationale: `docs/DESIGN.md`. The full eval
protocol: `docs/EVAL-PLAN.md`.

## Tools

| Tool | Cost | Purpose |
|---|---|---|
| `bulletin_status` | cheap | team root, event count, last digest |
| `bulletin_post` | cheap | post a finding/signal (structured `ref` + `claim`) |
| `bulletin_read` | cheap | catch up since a seq |
| `bulletin_conflicts` | cheap | symbolic same-ref/different-value check |
| `bulletin_sync` | LLM (1/round) | lead compresses everything since last digest |

## Install (as a Pi package)

```bash
pi install npm:pi-bulletin      # once published
# or locally during development:
pi install file:/path/to/pi-bulletin
```

Then use the protocol in `skills/bulletin.md`: fan out → observe → sync
round → reconcile-on-conflict.

## Watchdog (lead-stall detection)

`scripts/start-team.py` runs a watchdog while the team is attached (on by
default): it polls the bulletin every `--watchdog-interval` seconds (20) and
nudges the lead pane when the lead shows the stall signature from issue #1 —
idle ≥ `--watchdog-idle-min` minutes (5) with unread non-lead bulletin
events. The nudge is a tmux send-keys into the lead's session telling it to
`bulletin_read` (the same mechanism a human used to un-stall the first
dogfood run). Nudges are debounced by `--watchdog-nudge-min` (default =
idle-min) and stop as soon as the lead reads. The watchdog is pure file I/O
and never writes to the bulletin; its audit trail is `watchdog.log` in the
capture dir. Disable with `--no-watchdog`.

```bash
./start-team.py --team my-team --watchdog-idle-min 3 --watchdog-nudge-min 2
```

## Development

```bash
npm install
npm test          # hermetic store tests (PI_BULLETIN_ROOT override)
npm run typecheck # extension + store typecheck
```

## License

MIT — see `LICENSE`.
