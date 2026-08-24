# Roadmap

Outcome-oriented, rough-order. This is a small SPIKE package — the point is
validation, not feature volume. Dates are intentionally absent.

## Now (in flight)

- **Cut v0.3.0** — ship the lead-stall watchdog to npm (bump version,
  CHANGELOG entry, tag from merged main tip via the release workflow).
- **Adopt the maturity stack** — OSS hygiene docs, dependabot, CodeQL,
  release automation (landing now).

## Next (validated needs)

- **Agent self-check tool** — expose `bulletin_watchdog` as an extension
  tool so any agent can inspect the stall signature (currently launcher-only
  detection in Python).
- **Harness integration** — wire the bulletin protocol into harness-launched
  sessions beyond `start-team.py` (the eval driver path).
- **Second eval leg** — re-run the side-by-side against pi-teams to confirm
  the protocol results at a larger team size / different task shape.

## Later (1.0 candidate)

- **Protocol stability** — lock the event/state file format and tool
  contract for 1.0.
- **Backends** — alternative storage (in-memory, MCP/A2A wire protocol)
  behind the same tool surface.
- **Operational tooling** — round telemetry, stall analytics across runs,
  digest quality scoring.

Out-of-scope by design (see `docs/DESIGN.md` non-goals): process spawning,
task boards/workflow engines, and a wire protocol of our own.
