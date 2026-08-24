import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as store from "./store";

// Partial mock so the store's fsync calls are observable (ESM namespace
// exports cannot be spied directly), while all real fs behavior is kept.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) };
});

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bulletin-test-"));
  process.env.PI_BULLETIN_ROOT = tmpRoot;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Root for team-a under the hermetic tmp root. */
function teamRoot(team = "team-a"): string {
  return path.join(process.env.PI_BULLETIN_ROOT!, team);
}

/** Write events.jsonl directly (bypassing the store) to simulate a crash artifact. */
function writeEventsFile(team: string, lines: string[]): void {
  const root = teamRoot(team);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "events.jsonl"), lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
}

describe("bulletin store", () => {
  it("appends events with increasing seq", () => {
    const e1 = store.postEvent("team-a", "finding", "alice", { ref: "api", claim: "endpoint moved" });
    const e2 = store.postEvent("team-a", "signal", "bob", { ref: "api", value: "sha:abc" });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(store.readEvents("team-a")).toHaveLength(2);
  });

  it("reads since a seq (exclusive) and limits tail", () => {
    store.postEvent("team-a", "finding", "a", { ref: "x", claim: "1" });
    store.postEvent("team-a", "finding", "a", { ref: "x", claim: "2" });
    store.postEvent("team-a", "finding", "a", { ref: "x", claim: "3" });
    const since = store.readEvents("team-a", { sinceSeq: 1 });
    expect(since.map((e) => e.seq)).toEqual([2, 3]);
    const tail = store.readEvents("team-a", { limit: 2 });
    expect(tail.map((e) => e.seq)).toEqual([2, 3]);
  });

  it("records a digest and updates state", () => {
    const { event, state } = store.postDigest("team-a", "lead", "round 1 summary", ["lead", "alice"]);
    expect(event.kind).toBe("digest");
    expect(state.lastDigestSeq).toBe(1);
    expect(store.readState("team-a")?.digest).toBe("round 1 summary");
  });

  it("digest replaces previous digest", () => {
    store.postDigest("team-a", "lead", "round 1", ["lead"]);
    store.postEvent("team-a", "finding", "alice", { ref: "api", claim: "moved" });
    const { state } = store.postDigest("team-a", "lead", "round 2", ["lead", "alice"]);
    expect(state.lastDigestSeq).toBe(3);
    expect(state.digest).toBe("round 2");
  });

  it("cheap conflict detection flags same ref, different value", () => {
    store.postEvent("team-a", "signal", "alice", { ref: "port", value: "8080" });
    store.postEvent("team-a", "signal", "bob", { ref: "port", value: "9090" });
    const conflicts = store.findConflictsSince("team-a", 0);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].ref).toBe("port");
    expect(conflicts[0].a).toBe("8080");
    expect(conflicts[0].b).toBe("9090");
  });

  it("no conflict for same ref, same value; latest wins", () => {
    store.postEvent("team-a", "signal", "alice", { ref: "port", value: "8080" });
    store.postEvent("team-a", "signal", "bob", { ref: "port", value: "8080" });
    store.postEvent("team-a", "signal", "carol", { ref: "port", value: "8080" });
    expect(store.findConflictsSince("team-a", 0)).toHaveLength(0);
    // now a divergent value on the same ref creates one conflict
    store.postEvent("team-a", "signal", "dave", { ref: "port", value: "9090" });
    expect(store.findConflictsSince("team-a", 0)).toHaveLength(1);
  });

  it("status reports counts and state", () => {
    store.postEvent("team-a", "finding", "a", { ref: "x", claim: "1" });
    store.postDigest("team-a", "lead", "d", ["lead"]);
    const s = store.status("team-a");
    expect(s.eventCount).toBe(2);
    expect(s.lastSeq).toBe(2);
    expect(s.state?.digest).toBe("d");
  });
});

describe("read watermarks", () => {
  it("defaults to no watermark (0)", () => {
    expect(store.readWatermark("team-a", "alice")).toBe(0);
  });

  it("marks read at a seq and reads it back", () => {
    store.postEvent("team-a", "finding", "bob", { ref: "x", claim: "1" });
    store.postEvent("team-a", "finding", "bob", { ref: "x", claim: "2" });
    store.markRead("team-a", "alice", 2);
    expect(store.readWatermark("team-a", "alice")).toBe(2);
  });

  it("watermarks are per-agent", () => {
    store.postEvent("team-a", "finding", "bob", { ref: "x", claim: "1" });
    store.markRead("team-a", "alice", 1);
    expect(store.readWatermark("team-a", "bob")).toBe(0);
  });
});

describe("digest compaction", () => {
  it("moves events before the cutoff into archive and keeps newer", () => {
    store.postEvent("team-a", "finding", "a", { ref: "x", claim: "1" });
    store.postEvent("team-a", "finding", "b", { ref: "x", claim: "2" });
    store.postDigest("team-a", "lead", "round 1", ["lead"]);
    store.postEvent("team-a", "finding", "c", { ref: "y", claim: "3" });
    store.compact("team-a", 2); // archive findings 1-2; keep digest (3) + finding 3 (4)
    const kept = store.readEvents("team-a");
    expect(kept).toHaveLength(2);
    expect(kept[0].kind).toBe("digest");
    expect(kept[1].data.claim).toBe("3");
    const root = path.join(process.env.PI_BULLETIN_ROOT!, "team-a");
    const archive = fs.readFileSync(path.join(root, "archive.jsonl"), "utf8");
    expect(archive.split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("seq continues after compaction without collisions", () => {
    store.postEvent("team-a", "finding", "a", { ref: "x", claim: "1" });
    store.compact("team-a", 1);
    const e = store.postEvent("team-a", "finding", "b", { ref: "y", claim: "2" });
    expect(e.seq).toBe(2);
    expect(store.readEvents("team-a").map((x) => x.seq)).toEqual([2]);
  });

  it("does not leave temp files behind after atomic live-log replace", () => {
    store.postEvent("team-a", "finding", "a", { ref: "x", claim: "1" });
    store.compact("team-a", 1);
    const files = fs.readdirSync(teamRoot());
    expect(files.filter((f) => f.includes(".tmp"))).toHaveLength(0);
  });
});

describe("durability", () => {
  it("fsyncs the events file after an append", () => {
    (fs.fsyncSync as unknown as ReturnType<typeof vi.fn>).mockClear();
    store.postEvent("team-a", "finding", "a", { ref: "x", claim: "1" });
    expect(fs.fsyncSync).toHaveBeenCalled();
  });

  it("recovers from a torn tail: warns, truncates, returns good events", () => {
    const e1 = store.postEvent("team-a", "finding", "a", { ref: "x", claim: "1" });
    const e2 = store.postEvent("team-a", "finding", "b", { ref: "x", claim: "2" });
    // Simulate a crash mid-append: a partial final line.
    writeEventsFile("team-a", [JSON.stringify(e1), JSON.stringify(e2), `{"seq":3,"ts":"2026-`, ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const events = store.readEvents("team-a");
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(warn).toHaveBeenCalled();
    // The file is truncated so future reads are clean.
    const raw = fs.readFileSync(path.join(teamRoot(), "events.jsonl"), "utf8");
    expect(raw.split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("torn tail does not break the next seq allocation", () => {
    const e1 = store.postEvent("team-a", "finding", "a", { ref: "x", claim: "1" });
    writeEventsFile("team-a", [JSON.stringify(e1), `{"seq":2,"ts":"2026-`]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    store.readEvents("team-a"); // recovers + truncates
    const e = store.postEvent("team-a", "finding", "b", { ref: "y", claim: "2" });
    expect(e.seq).toBeGreaterThan(1);
  });

  it("skips mid-file corruption but keeps good lines after it", () => {
    const e1 = store.postEvent("team-a", "finding", "a", { ref: "x", claim: "1" });
    const e2 = store.postEvent("team-a", "finding", "b", { ref: "x", claim: "2" });
    writeEventsFile("team-a", [JSON.stringify(e1), "not-json", JSON.stringify(e2)]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const events = store.readEvents("team-a");
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(warn).toHaveBeenCalled();
    // No truncation for mid-file corruption: file keeps all 3 lines.
    const raw = fs.readFileSync(path.join(teamRoot(), "events.jsonl"), "utf8");
    expect(raw.split("\n").filter(Boolean)).toHaveLength(3);
  });

  it("writes state.json atomically (no temp leftovers) and reads it back", () => {
    store.postDigest("team-a", "lead", "round 1", ["lead"]);
    const files = fs.readdirSync(teamRoot());
    expect(files.filter((f) => f.includes(".tmp"))).toHaveLength(0);
    expect(store.readState("team-a")?.digest).toBe("round 1");
  });
});

describe("conflict resolution", () => {
  it("a resolution for a ref suppresses later conflict detection on that ref", () => {
    store.postEvent("team-a", "signal", "alice", { ref: "port", value: "8080" });
    store.postEvent("team-a", "signal", "bob", { ref: "port", value: "9090" });
    expect(store.findConflictsSince("team-a", 0)).toHaveLength(1);
    store.postEvent("team-a", "resolution", "lead", { ref: "port", decision: "use 8080" });
    expect(store.findConflictsSince("team-a", 0)).toHaveLength(0);
  });

  it("resolution only suppresses its own ref", () => {
    store.postEvent("team-a", "signal", "a", { ref: "port", value: "8080" });
    store.postEvent("team-a", "signal", "b", { ref: "port", value: "9090" });
    store.postEvent("team-a", "signal", "c", { ref: "host", value: "x" });
    store.postEvent("team-a", "signal", "d", { ref: "host", value: "y" });
    store.postEvent("team-a", "resolution", "lead", { ref: "port", decision: "8080" });
    const conflicts = store.findConflictsSince("team-a", 0);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].ref).toBe("host");
  });
});

describe("conflict supersession (v0.4.0)", () => {
  it("does not flag cosmetic differences (case/whitespace/numeric)", () => {
    store.postEvent("team-a", "signal", "a", { ref: "API", value: " v2 " });
    store.postEvent("team-a", "signal", "b", { ref: "api", value: "v2" });
    store.postEvent("team-a", "signal", "c", { ref: "port", value: "42" });
    store.postEvent("team-a", "signal", "d", { ref: "port", value: 42 });
    expect(store.findConflictsSince("team-a", 0)).toHaveLength(0);
  });

  it("does not merge distinct values (conservative canonicalization)", () => {
    store.postEvent("team-a", "signal", "a", { ref: "ver", value: "v2" });
    store.postEvent("team-a", "signal", "b", { ref: "ver", value: "v2.0" });
    const conflicts = store.findConflictsSince("team-a", 0);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe("conflict");
  });

  it("same-author later value is an update, not a conflict", () => {
    store.postEvent("team-a", "signal", "alice", { ref: "port", value: "8080" });
    store.postEvent("team-a", "signal", "alice", { ref: "port", value: "9090" });
    const items = store.findConflictsSince("team-a", 0);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("update");
    expect(items[0].tier).toBeUndefined();
    // baseline advanced to the update: a later different-author write conflicts with 9090
    store.postEvent("team-a", "signal", "bob", { ref: "port", value: "9090" });
    expect(store.findConflictsSince("team-a", 0)).toHaveLength(1); // agreement, not new conflict
  });

  it("tiers cross-author divergence by evidence status", () => {
    // proposed vs proposed -> soft
    store.postEvent("team-a", "signal", "a", { ref: "r1", value: "x" });
    store.postEvent("team-a", "signal", "b", { ref: "r1", value: "y" });
    // confirmed vs proposed -> medium
    store.postEvent("team-a", "signal", "c", { ref: "r2", value: "x", status: "confirmed" });
    store.postEvent("team-a", "signal", "d", { ref: "r2", value: "y" });
    // confirmed vs confirmed -> hard
    store.postEvent("team-a", "signal", "e", { ref: "r3", value: "x", status: "confirmed" });
    store.postEvent("team-a", "signal", "f", { ref: "r3", value: "y", status: "confirmed" });
    const items = store.findConflictsSince("team-a", 0);
    const byRef = Object.fromEntries(items.filter((i) => i.kind === "conflict").map((i) => [i.ref, i]));
    expect(byRef.r1.tier).toBe("soft");
    expect(byRef.r2.tier).toBe("medium");
    expect(byRef.r3.tier).toBe("hard");
    expect(byRef.r1.authors).toEqual(["a", "b"]);
  });

  it("corroboration (2 authors, same canonical value) counts as confirmed", () => {
    store.postEvent("team-a", "signal", "a", { ref: "port", value: "8080" });
    store.postEvent("team-a", "signal", "b", { ref: "port", value: "8080" }); // corroborates
    store.postEvent("team-a", "signal", "c", { ref: "port", value: "9090" });
    const items = store.findConflictsSince("team-a", 0);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("conflict");
    expect(items[0].tier).toBe("medium"); // corroborated 8080 vs proposed 9090
  });

  it("recency tiebreak only on ties; conflict still reported", () => {
    store.postEvent("team-a", "signal", "a", { ref: "r", value: "x", status: "confirmed" });
    store.postEvent("team-a", "signal", "b", { ref: "r", value: "x", status: "confirmed" }); // tie evidence (2 authors)
    store.postEvent("team-a", "signal", "c", { ref: "r", value: "y", status: "confirmed" });
    store.postEvent("team-a", "signal", "d", { ref: "r", value: "y", status: "confirmed" }); // tie evidence (2 authors)
    const items = store.findConflictsSince("team-a", 0);
    const conflicts = items.filter((i) => i.kind === "conflict");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].tier).toBe("hard");
    // baseline should be y (later on tie): a new proposed z conflicts with y, not x
    store.postEvent("team-a", "signal", "e", { ref: "r", value: "z" });
    const later = store.findConflictsSince("team-a", 0).filter((i) => i.kind === "conflict");
    expect(later.some((i) => i.b === "z" && i.a === "y")).toBe(true);
  });

  it("resolution with supersedes preserves the losing claim as an audit marker", () => {
    const e1 = store.postEvent("team-a", "signal", "alice", { ref: "port", value: "8080" });
    const e2 = store.postEvent("team-a", "signal", "bob", { ref: "port", value: "9090" });
    store.postEvent("team-a", "resolution", "lead", { ref: "port", decision: "use 8080", supersedes: [e2.seq] });
    const items = store.findConflictsSince("team-a", 0);
    // No active conflicts (settled), but the losing claim is preserved as an audit marker.
    expect(items.filter((i) => i.kind === "conflict")).toHaveLength(0);
    const markers = items.filter((i) => i.kind === "superseded");
    expect(markers).toHaveLength(1);
    expect(markers[0].a).toBe("9090");
    expect(markers[0].seqs[0]).toBe(e2.seq);
    // And the event is still in the log (never deleted).
    const log = store.readEvents("team-a");
    expect(log.some((x) => x.seq === e2.seq)).toBe(true);
    expect(e1.seq).toBe(1);
  });

  it("never calls the network on the conflict path", () => {
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should not fetch"));
    store.postEvent("team-a", "signal", "a", { ref: "r", value: "x" });
    store.postEvent("team-a", "signal", "b", { ref: "r", value: "y" });
    store.findConflictsSince("team-a", 0);
    expect(spy).not.toHaveBeenCalled();
  });
});
