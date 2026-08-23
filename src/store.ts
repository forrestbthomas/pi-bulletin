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
 * Storage layout (root defaults to ~/.pi/teams/{team}/, overridable for tests):
 *   events.jsonl   — append-only event log (the cheap layer)
 *   digests.jsonl  — append-only digest history (audit of sync rounds)
 *   state.json     — latest snapshot: lastDigestSeq, digest, members
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type EventKind =
  | "finding" // an observation/finding worth sharing (data: {ref, claim, evidence?})
  | "signal" // a cheap structured state-change signal (data: {ref, value})
  | "message" // a directed note (data: {to?, text})
  | "conflict" // a detected or manually declared conflict (data: {ref, a, b})
  | "resolution" // a recorded conflict resolution (data: {ref, decision})
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
}

export interface BulletinStatus {
  team: string;
  root: string;
  eventCount: number;
  lastSeq: number;
  state: DigestState | null;
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

/** Atomic append via O_APPEND; seq from the high-watermark file (survives compaction). */
export function postEvent(team: string, kind: EventKind, from: string, data: Record<string, unknown>): BulletinEvent {
  const root = bulletinRoot(team);
  const eventsFile = eventsPath(root);
  const seq = nextSeq(eventsFile, root);
  const event: BulletinEvent = { seq, ts: new Date().toISOString(), kind, from, data };
  fs.appendFileSync(eventsFile, JSON.stringify(event) + "\n", { encoding: "utf8", flag: "a" });
  fs.writeFileSync(seqPath(root), JSON.stringify({ last: seq }) + "\n", { encoding: "utf8" });
  return event;
}

/** Read events. sinceSeq is inclusive; limit caps the tail. */
export function readEvents(team: string, opts: { sinceSeq?: number; limit?: number } = {}): BulletinEvent[] {
  const root = bulletinRoot(team);
  const eventsFile = eventsPath(root);
  if (!fs.existsSync(eventsFile)) return [];
  const lines = fs.readFileSync(eventsFile, "utf8").trim().split("\n").filter(Boolean);
  let events = lines.map((l) => JSON.parse(l) as BulletinEvent);
  if (opts.sinceSeq !== undefined) events = events.filter((e) => e.seq > (opts.sinceSeq ?? 0));
  if (opts.limit !== undefined) events = events.slice(-opts.limit);
  return events;
}

/** One sync round: agent (lead/summarizer) writes the compressed digest. */
export function postDigest(
  team: string,
  from: string,
  digest: string,
  members: string[],
): { event: BulletinEvent; state: DigestState } {
  const root = bulletinRoot(team);
  const event = postEvent(team, "digest", from, { digest, replacedSeq: readState(team)?.lastDigestSeq ?? 0 });
  const state: DigestState = {
    lastDigestSeq: event.seq,
    digest,
    digestAt: event.ts,
    members,
  };
  fs.appendFileSync(digestsPath(root), JSON.stringify(event) + "\n", { encoding: "utf8", flag: "a" });
  fs.writeFileSync(statePath(root), JSON.stringify(state, null, 2) + "\n", { encoding: "utf8" });
  return { event, state };
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
  fs.writeFileSync(file, JSON.stringify(w, null, 2) + "\n", { encoding: "utf8" });
}

export function status(team: string): BulletinStatus {
  const root = bulletinRoot(team);
  const eventsFile = eventsPath(root);
  const eventCount = fs.existsSync(eventsFile)
    ? fs.readFileSync(eventsFile, "utf8").trim().split("\n").filter(Boolean).length
    : 0;
  return { team, root, eventCount, lastSeq: eventCount, state: readState(team) };
}

/**
 * Cheap symbolic conflict detection: within events since `sinceSeq`, if two
 * signal events carry the same `ref` but different `value`, flag a conflict.
 * This is the CHEAP path (no LLM). Agents/lead then decide whether the
 * conflict needs an LLM reconcile round — typically folded into the next
 * bulletin_sync digest.
 */
export function findConflictsSince(team: string, sinceSeq: number): Array<{ ref: string; a: unknown; b: unknown; seqs: [number, number] }> {
  const events = readEvents(team, { sinceSeq });
  const resolutions = events
    .filter((e) => e.kind === "resolution" && e.data.ref)
    .map((e) => ({ ref: e.data.ref as string, seq: e.seq }));
  const byRef = new Map<string, { value: unknown; seq: number }>();
  const conflicts: Array<{ ref: string; a: unknown; b: unknown; seqs: [number, number] }> = [];
  for (const e of events) {
    if (e.kind !== "signal") continue;
    const ref = e.data.ref as string | undefined;
    const value = e.data.value;
    if (!ref) continue;
    // A later recorded resolution settles this ref — don't re-flag it.
    if (resolutions.some((r) => r.ref === ref && r.seq > e.seq)) continue;
    if (byRef.has(ref)) {
      const prev = byRef.get(ref)!;
      if (JSON.stringify(prev.value) !== JSON.stringify(value)) {
        conflicts.push({ ref, a: prev.value, b: value, seqs: [prev.seq, e.seq] });
      }
      byRef.set(ref, { value, seq: e.seq }); // latest wins for future diffs
    } else {
      byRef.set(ref, { value, seq: e.seq });
    }
  }
  return conflicts;
}

/**
 * Digest compaction (the "cleaner"): archive every event at or before
 * beforeSeq into archive.jsonl and trim the live log. The seq high-watermark
 * keeps future event ids unique. Cheap (no LLM) — run before a digest round
 * to keep the live bulletin lean and token-efficient.
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
  }
  fs.writeFileSync(eventsFile, newer.map((e) => JSON.stringify(e)).join("\n") + (newer.length ? "\n" : ""), { encoding: "utf8" });
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
  if (lines.length === 0) return 1;
  const last = JSON.parse(lines[lines.length - 1]) as BulletinEvent;
  return last.seq + 1;
}
