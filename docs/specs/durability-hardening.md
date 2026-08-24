# Spec: Durability hardening for the bulletin store (H1)

## Goal

Make `events.jsonl` / `state.json` / `watermarks.json` survive process crash
or power loss without silent corruption or event loss. After this spec, a
killed `postEvent`/`postDigest`/`compact` can only lose the *in-flight*
append (a torn tail that is detected and truncated), never previously
acknowledged events, and `state.json` is never observed half-written.

## Problem Statement

`src/store.ts` currently relies on `writeFileSync`/`appendFileSync` without
`fsync`. On Linux/macOS those writes land in the page cache; a crash or
power loss can leave:

1. **Torn tail in `events.jsonl`** — a partially written final line.
   `readEvents` (store.ts:88-94) does `JSON.parse` on every line and will
   **throw** on the partial line, breaking every subsequent read and the
   whole team.
2. **`state.json` half-written or missing while events exist** —
   `postDigest` writes `state.json` in place (store.ts:116-118); a crash
   between the append and the write loses the digest pointer but keeps
   events (recoverable, but the picture is wrong), and a crash *during* the
   write can leave invalid JSON that `readState` swallows to `null` silently.
3. **`compact` rewriting `events.jsonl` in place** (store.ts:167-171) — a
   crash mid-rewrite can truncate the live log and lose *acknowledged*
   events, including events newer than the digest (the exact class of loss
   OpenClaw hit with a plain-file queue: openclaw#32063).
4. **`seq.json` ahead of the log** — benign (high-watermark design), but the
   reader must not crash when the last line is short.

The report's durability bar: *"Durability is fsync + framing, not
write()/flush()"* (research-report-2026.md §2 Lane 3 finding 3, citing
SQLite WAL practice and OpenClaw #32063).

## Context From Memory

- Eval verdict 2026-08-23: bulletin promoted; the store is the production
  substrate for the OSS package — durability is a release-blocker quality
  item, not polish.
- `compact` already archives before trimming (store.ts:155-165) — the order
  is right; only the in-place rewrite is wrong.
- Seq high-watermark (`seq.json`) intentionally survives compaction — keep
  that invariant.

## In Scope

- **fsync discipline** in `src/store.ts`:
  - `postEvent`: fsync `events.jsonl` after the append.
  - `postDigest`: fsync `events.jsonl` after the digest event append, then
    write `state.json` atomically (temp file + fsync + rename) + fsync the
    directory.
  - `markRead`: fsync `watermarks.json` (best-effort; watermarks are caches,
    monotonic re-reads are safe).
  - `compact`: fsync `archive.jsonl` append, then atomically replace
    `events.jsonl` (temp + fsync + rename + dir fsync).
- **Torn-tail tolerance** in `readEvents`: a trailing sequence of unparseable
  lines is treated as a torn tail — log a warning (stderr), truncate the
  file to the last good line, and return the good events. `readEvents` never
  throws on a malformed tail.
- **Atomic snapshot commits** via a small helper (`writeFileAtomic(path,
  data)`) used for `state.json`, `watermarks.json`, and the post-compaction
  `events.jsonl` replacement.
- **Framing note:** keep one JSON event per line (already true — JSON has no
  raw newlines). A crash can only truncate the *last* append, so
  parse-based torn-tail detection is sufficient for app-crash recovery.
  Length/checksum framing and mid-file bit-rot detection are deferred to the
  replay milestone (L3, ESAA-style hash verification) — out of scope here.
- Tests: extend `src/store.test.ts` (or add `src/durability.test.ts`) with
  hermetic `PI_BULLETIN_ROOT` fixtures.

## Out Of Scope

- Checksum framing per line / mid-file corruption detection (deferred to L3
  replay).
- SQLite WAL substrate (L2 — only if multi-process atomicity needs grow).
- Multi-process locking around writes (one writer per digest round is the
  protocol; unchanged).
- Harness/eval-driver changes.

## Constraints

- Pure Node `fs` — no new dependencies (project is dependency-light; TS
  logic stays in `src/store.ts`).
- On-disk format remains JSONL — existing bulletins must keep working
  (backward compatible read; no migration tool).
- Keep the existing test suite green (`npm test`, `npm run typecheck`).

## Assumptions

- `fs.fsyncSync` is available (Node ≥ 14; project uses modern Node).
- Directory fsync on macOS is best-effort (it is a no-op on some filesystems
  but harmless); we still call it.
- A torn tail is always at the *end* of the file (append-only invariant);
  truncation never discards acknowledged events.
- Stderr warnings are acceptable observability for a coordination substrate
  (the watchdog already logs to `watchdog.log`; this is store-level, so
  stderr is fine for v1).

## Acceptance Criteria

- **Torn tail detected, not fatal:** fixture `events.jsonl` with N valid
  lines + a partial final line → `readEvents` returns N events, prints one
  warning, and truncates the file to N lines. No throw.
- **Torn tail after digest:** same, with the torn line being a digest event
  → `readEvents`/`readState` still work; `state.json` may lag but is valid.
- **Atomic state commit:** crash injection (write temp, then kill before
  rename) leaves the *previous* `state.json` intact; a crash after rename
  leaves the new one. Simulated by testing the helper's temp/rename steps
  directly and by a spy on `fsyncSync`/`renameSync` call order.
- **Compaction atomic:** `compact` archives first, then replaces
  `events.jsonl` via temp+rename; a failure between archive and replace
  leaves the original live log intact (no truncation of acknowledged
  events).
- **fsync called:** postEvent/postDigest/compact call `fsyncSync` on the
  events file (spy/unit test); order = append → fsync.
- **Backward compatible:** a pre-existing bulletin root (JSONL, no fsync
  history) reads identically before and after the change.
- **Seq invariant:** after torn-tail truncation, `nextSeq` still returns a
  unique id (derived from `seq.json`, which survives).
- **CI:** `npm test` and `npm run typecheck` pass.

## Edge Cases

- Empty `events.jsonl` or no trailing newline → no warning, empty result.
- Multiple consecutive unparseable trailing lines → all truncated together.
- `compact` with `beforeSeq` beyond the last seq → archive everything, live
  log empty but valid.
- `readEvents` after external truncation (someone hand-edited the log) →
  torn-tail path, never throw.
- `readState` with a valid file → unchanged behavior.

## Validation Plan

- `npm test` (existing vitest suite + new durability tests)
- `npm run typecheck`
- Manual: append a partial line to a fixture `events.jsonl`, run
  `bulletin_status`/`bulletin_read` through the extension path, confirm a
  warning and clean recovery.
- Optional live check: `kill -9` a posting process mid-loop in a scratch
  team root; verify next read recovers (this is the acceptance target, but
  the unit tests are the gate).

## Execution Plan

1. Add `writeFileAtomic(path, data)` helper (temp + fsync + rename + dir
   fsync) in `src/store.ts`.
2. Add `fsyncFile(path)` helper; call after appends in `postEvent`,
   `postDigest`, `markRead`, `compact`.
3. Make `readEvents` torn-tail tolerant (parse loop → on failure, warn +
   truncate, return good events).
4. Rewrite `compact`'s live-log replacement to use `writeFileAtomic`.
5. Add durability tests (hermetic temp roots, spy on fs calls).
6. Full-suite verification.

## Open Questions

- Should torn-tail truncation also happen for `digests.jsonl`? (Low value —
  it is an audit trail, not read for correctness; leave as-is for v1.)
- Should `archive.jsonl` get fsync too? (Yes — append + fsync in `compact`,
  same discipline.)

## Self-Check

- Status: Ready for implementation (pending roadmap approval)
- Blocking Questions: None
- Safe To Implement: Yes
- Notes: On-disk format unchanged; all changes are additive durability +
  recovery behavior. Matches H1 in `docs/ROADMAP.md` (Now milestone
  v0.4.0).
