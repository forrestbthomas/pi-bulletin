/**
 * pi-bulletin — shared bulletin store (SPIKE).
 *
 * Design intent (see docs/DESIGN.md for the research mapping):
 *  - The bulletin is a *shared, append-only event log* + a *state snapshot*
 *    (the "picture"). It is the coordination substrate.
 *  - Cheap eventing: writing/reading events and signals costs ZERO LLM calls.
 *    Agents post findings and signals; other agents observe by reading.
 *  - Expensive work (summarization/reconciliation) happens only at explicit
 *    sync points (bulletin_sync) — one LLM call per round, driven by the
 *    skill prompt, never per message.
 *  - Cheap symbolic conflict detection in code (same ref, different value);
 *    LLM reconciliation is invoked ONLY for unresolved conflicts.
 *
 * Durability (v0.4.0, docs/specs/durability-hardening.md):
 *  - Appends are fsync'd before acknowledgement; snapshots (state.json,
 *    watermarks.json, post-compaction events.jsonl) are written via
 *    temp-file + fsync + rename so readers never observe a half-written
 *    file.
 *  - readEvents tolerates a torn tail (a crash mid-append leaves a partial
 *    final line): it warns, truncates at the last good line, and returns the
 *    good events instead of throwing forever.
 *
 * Conflict detection (v0.4.0, docs/specs/conflict-supersession.md):
 *  - Canonicalized ref/value comparison (case/whitespace/numeric), so
 *    cosmetic differences are not conflicts.
 *  - Evidence tiers (proposed/confirmed/contested/superseded) with
 *    corroboration counting; same-author later values are updates, not
 *    conflicts; cross-author divergence is tiered hard/medium/soft.
 *  - Resolutions settle a ref (existing behavior) and may list `supersedes`
 *    seqs; superseded claims are preserved in the log and reported as audit
 *    markers, never deleted.
 *
 * Storage layout (root defaults to ~/.pi/teams/{team}/, overridable for tests):
 *   events.jsonl   — append-only event log (the cheap layer)
 *   digests.jsonl  — append-only digest history (audit of sync rounds)
 *   state.json     — latest snapshot: lastDigestSeq, digest, members
 *   watermarks.json — per-agent read cursors
 *   seq.json       — event seq high-watermark (survives compaction)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type EventKind =
  | "finding" // an observation/finding worth sharing (data: {ref, claim, evidence?})
  | "signal" // a cheap structured state-change signal (data: {ref, value, status?})
  | "message" // a directed note (data: {to?, text})
  | "conflict" // a detected or manually declared conflict (data: {ref, a, b})
  | "resolution" // a recorded conflict resolution (data: {ref, decision, decisionEvidence?, supersedes?})
  | "digest"; // a sync-round summary (data: {digest, replacedSeq?})

export interface BulletinEvent {
  seq: number;
  ts: string; // ISO timestamp
  kind: EventKind;
  from: string; // agent name / "user"
  data: Record<string, unknown>;
}

export interface DigestState {
  lastDigestSeq: number;
  digest: string;
  digestAt: string;
  members: string[];
  /** Monotonic digest round (fencing epoch, M1). 0 for legacy digests. */
  round: number;
  /** Agent identity that wrote the current digest (single writer per round). */
  lead: string;
  /** Coverage note (H3): this digest folds in events (coverageFrom, coverageTo]. */
  coverageFrom: number;
  coverageTo: number;
  /** Structured digest sections with event-ID provenance (H3). */
  decisions: DigestItem[];
  findings: DigestItem[];
  open: DigestItem[];
}

/** One structured digest section item: a decision, finding, or open question. */
export interface DigestItem {
  ref: string;
  text: string;
  status?: ClaimStatus;
  evidence?: number[]; // event seqs backing this item (validated against the log)
}

/** Optional structured digest write (H3/M1): round + sections. */
export interface PostDigestOptions {
  round?: number;
  decisions?: DigestItem[];
  findings?: DigestItem[];
  open?: DigestItem[];
}

export interface BulletinStatus {
  team: string;
  root: string;
  eventCount: number;
  lastSeq: number;
  state: DigestState | null;
}

/** Evidence status of a claim (see conflict-supersession spec). */
export type ClaimStatus = "proposed" | "confirmed" | "contested" | "superseded";

/** A conflict/update/supersession item from the cheap symbolic check. */
export interface ConflictItem {
  ref: string; // canonical ref (trimmed, lowercased)
  a: unknown; // earlier value (raw, as posted)
  b: unknown; // later value (raw, as posted); undefined for superseded markers
  seqs: [number, number];
  kind: "conflict" | "update" | "superseded";
  tier?: "hard" | "medium" | "soft"; // conflict severity (cross-author only)
  authors?: string[]; // [earlier author, later author]; single author for superseded markers
  status: "active" | "superseded";
}

/** Resolve the bulletin root for a team. Env override keeps tests hermetic. */
export function bulletinRoot(team: string): string {
  const base = process.env.PI_BULLETIN_ROOT || path.join(os.homedir(), ".pi", "teams");
  const root = path.join(base, team);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function eventsPath(root: string): string {
  return path.join(root, "events.jsonl");
}

function digestsPath(root: string): string {
  return path.join(root, "digests.jsonl");
}

function statePath(root: string): string {
  return path.join(root, "state.json");
}

function watermarksPath(root: string): string {
  return path.join(root, "watermarks.json");
}

function seqPath(root: string): string {
  return path.join(root, "seq.json");
}

/**
 * fsync a file (best-effort). Page-cache writes are not durable; a crash
 * can lose acknowledged events without fsync. We never let an fsync failure
 * break the protocol (coordinating is better than crashing), but the write
 * path is only "acknowledged" after fsync on the happy path.
 */
function fsyncFile(file: string): void {
  try {
    const fd = fs.openSync(file, "r+");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // best-effort: no-op if the file is missing or the FS rejects fsync
  }
}

/**
 * Atomic file write: temp file + fsync + rename + directory fsync. Readers
 * never observe a half-written file at `file` (they see the old or the new
 * complete content). Used for state.json, watermarks.json, and the
 * post-compaction events.jsonl replacement.
 */
function writeFileAtomic(file: string, data: string): void {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, data, { encoding: "utf8" });
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
  try {
    const dfd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  } catch {
    // best-effort (some filesystems don't support directory fsync)
  }
}

/** Atomic append via O_APPEND; seq from the high-watermark file (survives compaction). */
export function postEvent(team: string, kind: EventKind, from: string, data: Record<string, unknown>): BulletinEvent {
  const root = bulletinRoot(team);
  const eventsFile = eventsPath(root);
  const seq = nextSeq(eventsFile, root);
  const event: BulletinEvent = { seq, ts: new Date().toISOString(), kind, from, data };
  fs.appendFileSync(eventsFile, JSON.stringify(event) + "\n", { encoding: "utf8", flag: "a" });
  fs.writeFileSync(seqPath(root), JSON.stringify({ last: seq }) + "\n", { encoding: "utf8" });
  fsyncFile(eventsFile); // durability: only acknowledge once the append is durable
  return event;
}

/**
 * Read events. sinceSeq is exclusive (events with seq > sinceSeq); limit
 * caps the tail. Torn-tail tolerant: a crash mid-append leaves a partial
 * final line, which is truncated here instead of throwing on every read.
 */
export function readEvents(team: string, opts: { sinceSeq?: number; limit?: number } = {}): BulletinEvent[] {
  const root = bulletinRoot(team);
  const eventsFile = eventsPath(root);
  if (!fs.existsSync(eventsFile)) return [];
  const lines = fs.readFileSync(eventsFile, "utf8").split("\n").filter(Boolean);
  let events: BulletinEvent[] = [];
  let firstBad = -1;
  for (let i = 0; i < lines.length; i++) {
    try {
      events.push(JSON.parse(lines[i]) as BulletinEvent);
    } catch {
      if (firstBad === -1) firstBad = i;
    }
  }
  if (firstBad !== -1) {
    // Only truncate when the unparseable lines form a suffix (torn tail).
    // Mid-file corruption is not from an app crash — skip those lines but
    // keep the good ones after them.
    const isSuffix = lines.slice(firstBad).every((l) => {
      try {
        JSON.parse(l);
        return false;
      } catch {
        return true;
      }
    });
    if (isSuffix) {
      const good = lines.slice(0, firstBad);
      console.warn(
        `[pi-bulletin] torn tail in ${eventsFile}: ${lines.length - firstBad} trailing line(s) unparseable; truncating to ${good.length} event(s).`,
      );
      try {
        fs.writeFileSync(eventsFile, good.length ? good.join("\n") + "\n" : "", { encoding: "utf8" });
      } catch {
        // best-effort truncation; the parsed events below are still returned
      }
      events.length = firstBad; // good lines before the first bad line
    } else {
      console.warn(
        `[pi-bulletin] ${eventsFile}: ${lines.length - firstBad} unparseable line(s) skipped (not a tail; no truncation).`,
      );
    }
  }
  if (opts.sinceSeq !== undefined) events = events.filter((e) => e.seq > (opts.sinceSeq ?? 0));
  if (opts.limit !== undefined) events = events.slice(-opts.limit);
  return events;
}

/**
 * One sync round: agent (lead/summarizer) writes the compressed digest.
 *
 * Fencing (M1): the first digest sets `lead` and `round = 1`; later digests
 * must come from the same lead and carry a monotonically increasing round
 * (`opts.round` must equal `state.round + 1`). A stale retry or a non-lead
 * writer is rejected — double digests for the same round are impossible.
 *
 * Provenance (H3): `decisions`/`findings`/`open` may carry `evidence` event
 * seqs, validated cheaply (positive integers <= the seq high-watermark, a
 * file read — no LLM). Coverage (`coverageFrom`, `coverageTo`) is derived
 * from the log, not authored, so a digest cannot misstate what it folds in.
 */
export function postDigest(
  team: string,
  from: string,
  digest: string,
  members: string[],
  opts: PostDigestOptions = {},
): { event: BulletinEvent; state: DigestState } {
  const root = bulletinRoot(team);
  const prev = readState(team);

  // Fencing: one writer per round. Legacy state (no lead) treats the next
  // writer as the first lead (backward compatible with pre-0.5.0 teams).
  if (prev && prev.lead && from !== prev.lead) {
    throw new Error(`digest rejected: ${from} is not the lead (${prev.lead}) — only the lead writes digests`);
  }
  const expectedRound = (prev?.round ?? 0) + 1;
  const round = opts.round ?? expectedRound;
  if (round !== expectedRound) {
    throw new Error(
      `stale digest round ${round}: current round is ${prev?.round ?? 0}, expected ${expectedRound} — read the bulletin and re-sync as round ${expectedRound}`,
    );
  }

  // Coverage + provenance bound: the last event seq at digest time (the new
  // digest event has not been appended yet).
  const maxSeq = seqHighWatermark(team);
  const coverageFrom = prev?.lastDigestSeq ?? 0;
  const coverageTo = maxSeq;
  validateEvidence(opts.decisions, maxSeq);
  validateEvidence(opts.findings, maxSeq);
  validateEvidence(opts.open, maxSeq);

  const event = postEvent(team, "digest", from, {
    digest,
    replacedSeq: prev?.lastDigestSeq ?? 0,
    round,
    decisions: opts.decisions ?? [],
    findings: opts.findings ?? [],
    open: opts.open ?? [],
    coverageFrom,
    coverageTo,
    members,
  });
  const state: DigestState = {
    lastDigestSeq: event.seq,
    digest,
    digestAt: event.ts,
    members,
    round,
    lead: from,
    coverageFrom,
    coverageTo,
    decisions: opts.decisions ?? [],
    findings: opts.findings ?? [],
    open: opts.open ?? [],
  };
  fs.appendFileSync(digestsPath(root), JSON.stringify(event) + "\n", { encoding: "utf8", flag: "a" });
  fsyncFile(digestsPath(root));
  writeFileAtomic(statePath(root), JSON.stringify(state, null, 2) + "\n");
  return { event, state };
}

/**
 * Rebuild the latest digest state from `digests.jsonl` (the last digest
 * event), independent of `state.json`. Used for recovery/audit: the snapshot
 * is replayable from the log. Legacy digest events (no round/sections) replay
 * with defaults and never throw.
 */
export function replayState(team: string): DigestState | null {
  const root = bulletinRoot(team);
  const file = digestsPath(root);
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  let last: BulletinEvent | null = null;
  for (const line of lines) {
    try {
      const e = JSON.parse(line) as BulletinEvent;
      if (e.kind === "digest") last = e;
    } catch {
      // skip torn/legacy lines; keep scanning for the last good digest
    }
  }
  if (!last) return null;
  const d = last.data;
  return {
    lastDigestSeq: last.seq,
    digest: typeof d.digest === "string" ? d.digest : "",
    digestAt: last.ts,
    members: Array.isArray(d.members) ? (d.members as string[]) : [],
    round: typeof d.round === "number" ? d.round : 0,
    lead: last.from,
    coverageFrom: typeof d.coverageFrom === "number" ? d.coverageFrom : 0,
    coverageTo: typeof d.coverageTo === "number" ? d.coverageTo : 0,
    decisions: Array.isArray(d.decisions) ? (d.decisions as DigestItem[]) : [],
    findings: Array.isArray(d.findings) ? (d.findings as DigestItem[]) : [],
    open: Array.isArray(d.open) ? (d.open as DigestItem[]) : [],
  };
}

/**
 * Highest event seq ever written (seq.json high-watermark, which survives
 * compaction); falls back to the last live event. 0 on an empty team.
 */
function seqHighWatermark(team: string): number {
  const root = bulletinRoot(team);
  const sp = seqPath(root);
  if (fs.existsSync(sp)) {
    try {
      const s = JSON.parse(fs.readFileSync(sp, "utf8")) as { last: number };
      return s.last;
    } catch {
      // fall through to log-derived seq
    }
  }
  const events = readEvents(team);
  return events.length ? events[events.length - 1].seq : 0;
}

/**
 * Cheap provenance validation (H3): every evidence seq on a digest section
 * must be a positive integer <= the seq high-watermark. Errors name the bad
 * seq and ref so the lead can fix and retry. Zero-LLM, pure file state.
 */
function validateEvidence(items: DigestItem[] | undefined, maxSeq: number): void {
  for (const item of items ?? []) {
    for (const seq of item.evidence ?? []) {
      if (!Number.isInteger(seq) || seq <= 0 || seq > maxSeq) {
        throw new Error(
          `invalid evidence seq ${seq} on ref=${item.ref}: must be a positive integer <= ${maxSeq} (last event seq)`,
        );
      }
    }
  }
}

export function readState(team: string): DigestState | null {
  const root = bulletinRoot(team);
  const file = statePath(root);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as DigestState;
  } catch {
    return null;
  }
}

/**
 * Read watermarks: the last event seq each agent has seen (cheap "what
 * have I read" cursor, per agent). 0 = nothing read yet. This is the
 * per-agent observation cursor the protocol needs so bulletin_read can
 * return only NEW events without an LLM call.
 */
export function readWatermark(team: string, agent: string): number {
  const root = bulletinRoot(team);
  const file = watermarksPath(root);
  if (!fs.existsSync(file)) return 0;
  try {
    const w = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, number>;
    return w[agent] ?? 0;
  } catch {
    return 0;
  }
}

export function markRead(team: string, agent: string, seq: number): void {
  const root = bulletinRoot(team);
  const file = watermarksPath(root);
  const w: Record<string, number> = fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, "utf8") || "{}") as Record<string, number>)
    : {};
  w[agent] = seq;
  writeFileAtomic(file, JSON.stringify(w, null, 2) + "\n");
}

export function status(team: string): BulletinStatus {
  const root = bulletinRoot(team);
  const events = readEvents(team); // torn-tail tolerant
  return {
    team,
    root,
    eventCount: events.length,
    lastSeq: events.length ? events[events.length - 1].seq : 0,
    state: readState(team),
  };
}

/** Canonicalize a ref for conflict keying: trim + lowercase (topic keys are case-insensitive). */
function canonRef(ref: string): string {
  return ref.trim().toLowerCase();
}

/**
 * Canonicalize a signal value for conflict comparison: trim strings,
 * collapse internal whitespace, and compare numeric strings as numbers.
 * Conservative — no stemming or synonyms, so distinct values are never
 * over-merged.
 */
function canonValue(value: unknown): unknown {
  if (typeof value === "string") {
    const t = value.trim().replace(/\s+/g, " ");
    if (t !== "" && /^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    return t;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  // objects/arrays: compare structurally (matches the old JSON.stringify keying)
  try {
    return JSON.stringify(value);
  } catch {
    return value;
  }
}

/**
 * Effective status of a claim: declared `confirmed`, or corroborated by
 * >= 2 distinct authors writing the same canonical value.
 */
function effectiveStatus(status: ClaimStatus | undefined, evidenceCount: number): "confirmed" | "proposed" | "contested" {
  if (status === "confirmed" || evidenceCount >= 2) return "confirmed";
  if (status === "contested") return "contested";
  return "proposed";
}

/** Conflict tier: both confirmed = hard; one side confirmed = medium; else soft. */
function tierOf(a: "confirmed" | "proposed" | "contested", b: "confirmed" | "proposed" | "contested"): "hard" | "medium" | "soft" {
  if (a === "confirmed" && b === "confirmed") return "hard";
  if (a === "confirmed" || b === "confirmed") return "medium";
  return "soft";
}

/**
 * Cheap symbolic conflict detection: within events since `sinceSeq`, track
 * signal values per canonical ref. Cross-author divergent values produce a
 * tiered conflict; same-author later values are updates (not conflicts);
 * corroboration (distinct authors on the same canonical value) raises the
 * evidence tier. A later resolution settles a ref (no re-flagging); if it
 * lists `supersedes` seqs, those claims are preserved in the log and
 * reported as `kind: "superseded"` audit markers. This is the CHEAP path
 * (no LLM). Agents/lead then decide whether a conflict needs an LLM
 * reconcile round — typically folded into the next bulletin_sync digest.
 */
export function findConflictsSince(team: string, sinceSeq: number): ConflictItem[] {
  const events = readEvents(team, { sinceSeq });
  const resolutions = events
    .filter((e) => e.kind === "resolution" && typeof e.data.ref === "string")
    .map((e) => ({
      ref: canonRef(e.data.ref as string),
      seq: e.seq,
      supersedes: Array.isArray(e.data.supersedes) ? (e.data.supersedes as number[]) : [],
    }));

  // Current baseline per ref: the winning value for future diffs.
  const baseline = new Map<string, { author: string; seq: number; rawValue: unknown; value: unknown; status: ClaimStatus | undefined }>();
  // Corroboration: distinct authors per (canonical ref, canonical value).
  const evidence = new Map<string, Map<unknown, Set<string>>>();
  const out: ConflictItem[] = [];

  const evidenceCount = (ref: string, value: unknown): number => evidence.get(ref)?.get(value)?.size ?? 0;

  for (const e of events) {
    if (e.kind !== "signal") continue;
    const ref = typeof e.data.ref === "string" ? canonRef(e.data.ref) : "";
    const value = e.data.value;
    if (!ref || value === undefined) continue;
    // Declared-superseded signals are audit-only, not live claims.
    if (e.data.status === "superseded") continue;
    // A later recorded resolution settles this ref — don't re-flag it.
    if (resolutions.some((r) => r.ref === ref && r.seq > e.seq)) continue;

    const status = (typeof e.data.status === "string" ? e.data.status : "proposed") as ClaimStatus;
    const canon = canonValue(value);

    // Corroboration: track distinct authors per canonical value.
    let byValue = evidence.get(ref);
    if (!byValue) {
      byValue = new Map();
      evidence.set(ref, byValue);
    }
    let authors = byValue.get(canon);
    if (!authors) {
      authors = new Set();
      byValue.set(canon, authors);
    }
    authors.add(e.from);

    const prev = baseline.get(ref);
    if (!prev) {
      baseline.set(ref, { author: e.from, seq: e.seq, rawValue: value, value: canon, status });
      continue;
    }

    if (prev.value === canon) {
      continue; // agreement (same canonical value) — corroboration already counted
    }

    const superseded = resolutions.some((r) => r.ref === ref && r.supersedes.includes(e.seq));

    if (e.from === prev.author) {
      // Same-author later value: a correction/update, not a conflict.
      out.push({
        ref,
        a: prev.rawValue,
        b: value,
        seqs: [prev.seq, e.seq],
        kind: "update",
        status: superseded ? "superseded" : "active",
      });
      baseline.set(ref, { author: e.from, seq: e.seq, rawValue: value, value: canon, status });
      continue;
    }

    // Cross-author divergence: evidence-tiered conflict.
    const prevEff = effectiveStatus(prev.status, evidenceCount(ref, prev.value));
    const newEff = effectiveStatus(status, evidenceCount(ref, canon));
    out.push({
      ref,
      a: prev.rawValue,
      b: value,
      seqs: [prev.seq, e.seq],
      kind: "conflict",
      tier: tierOf(prevEff, newEff),
      authors: [prev.author, e.from],
      status: superseded ? "superseded" : "active",
    });

    // Baseline update: higher effective evidence wins; ties → later seq.
    // The conflict is still reported (never silently resolved by LWW).
    const prevWeight = prevEff === "confirmed" ? 2 : 1;
    const newWeight = newEff === "confirmed" ? 2 : 1;
    if (newWeight > prevWeight || (newWeight === prevWeight && e.seq > prev.seq)) {
      baseline.set(ref, { author: e.from, seq: e.seq, rawValue: value, value: canon, status });
    }
  }

  // Audit markers: claims a resolution explicitly superseded (kept, never deleted).
  for (const r of resolutions) {
    for (const seq of r.supersedes) {
      const e = events.find(
        (x) => x.seq === seq && x.kind === "signal" && typeof x.data.ref === "string" && canonRef(x.data.ref) === r.ref,
      );
      if (e && !out.some((o) => o.seqs.includes(seq))) {
        out.push({
          ref: r.ref,
          a: e.data.value,
          b: undefined,
          seqs: [seq, r.seq],
          kind: "superseded",
          status: "superseded",
          authors: [e.from],
        });
      }
    }
  }

  return out;
}

/**
 * Digest compaction (the "cleaner"): archive every event at or before
 * beforeSeq into archive.jsonl and trim the live log. The seq high-watermark
 * keeps future event ids unique. Cheap (no LLM) — run before a digest round
 * to keep the live bulletin lean and token-efficient. Archive append is
 * fsync'd first, then the live log is replaced atomically, so a crash
 * between the two leaves the original live log intact (no loss of
 * acknowledged events).
 */
export function compact(team: string, beforeSeq: number): { archived: number; kept: number } {
  const root = bulletinRoot(team);
  const eventsFile = eventsPath(root);
  if (!fs.existsSync(eventsFile)) return { archived: 0, kept: 0 };
  const events = readEvents(team);
  const older = events.filter((e) => e.seq <= beforeSeq);
  const newer = events.filter((e) => e.seq > beforeSeq);
  if (older.length) {
    fs.appendFileSync(
      path.join(root, "archive.jsonl"),
      older.map((e) => JSON.stringify(e)).join("\n") + "\n",
      { encoding: "utf8", flag: "a" },
    );
    fsyncFile(path.join(root, "archive.jsonl"));
  }
  writeFileAtomic(
    eventsFile,
    newer.map((e) => JSON.stringify(e)).join("\n") + (newer.length ? "\n" : ""),
  );
  return { archived: older.length, kept: newer.length };
}

function nextSeq(file: string, root?: string): number {
  if (root) {
    const sp = seqPath(root);
    if (fs.existsSync(sp)) {
      try {
        const s = JSON.parse(fs.readFileSync(sp, "utf8")) as { last: number };
        return s.last + 1;
      } catch {
        // fall through to log-derived seq
      }
    }
  }
  if (!fs.existsSync(file)) return 1;
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  // Walk backwards: the final line may be a torn tail after a crash.
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const last = JSON.parse(lines[i]) as BulletinEvent;
      return last.seq + 1;
    } catch {
      // torn tail; try the previous line
    }
  }
  return 1;
}
