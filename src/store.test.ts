import { describe, expect, it, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as store from "./store";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bulletin-test-"));
  process.env.PI_BULLETIN_ROOT = tmpRoot;
});

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
