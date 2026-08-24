import { describe, expect, it, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "./index";
import * as store from "../src/store";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bulletin-ext-test-"));
  process.env.PI_BULLETIN_ROOT = tmpRoot;
  process.env.PI_BULLETIN_AGENT = "tester";
});

/** Minimal ExtensionAPI stub: capture every registerTool call. */
function fakePi() {
  const tools: unknown[] = [];
  return {
    registerTool: (t: unknown) => tools.push(t),
    tools,
  };
}

function findTool(pi: any, name: string) {
  return pi.tools.find((t: any) => t.name === name);
}

async function callTool(pi: any, name: string, params: Record<string, unknown>) {
  const tool = findTool(pi, name);
  return tool.execute("call-1", params, null, null, {});
}

describe("pi-bulletin extension", () => {
  it("registers the five bulletin tools", () => {
    const pi = fakePi() as any;
    extension(pi);
    const names = pi.tools.map((t: any) => t.name).sort();
    expect(names).toEqual([
      "bulletin_compact",
      "bulletin_conflicts",
      "bulletin_post",
      "bulletin_read",
      "bulletin_resolve",
      "bulletin_status",
      "bulletin_sync",
    ]);
  });

  it("gives every tool a description and parameters", () => {
    const pi = fakePi() as any;
    extension(pi);
    for (const t of pi.tools) {
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.parameters).toBeTruthy();
    }
  });

  it("bulletin_post stores an optional status on the event", async () => {
    const pi = fakePi() as any;
    extension(pi);
    await callTool(pi, "bulletin_post", {
      team_name: "team-x",
      kind: "signal",
      ref: "port",
      value: "8080",
      status: "confirmed",
    });
    const events = store.readEvents("team-x");
    expect(events).toHaveLength(1);
    expect(events[0].data.status).toBe("confirmed");
    expect(events[0].from).toBe("tester");
  });

  it("bulletin_resolve stores decision evidence and supersedes", async () => {
    const pi = fakePi() as any;
    extension(pi);
    await callTool(pi, "bulletin_post", { team_name: "team-x", kind: "signal", ref: "port", value: "8080" });
    await callTool(pi, "bulletin_post", { team_name: "team-x", kind: "signal", ref: "port", value: "9090" });
    await callTool(pi, "bulletin_resolve", {
      team_name: "team-x",
      ref: "port",
      decision: "use 8080",
      decision_evidence: [1],
      supersedes: [2],
    });
    const events = store.readEvents("team-x");
    const resolution = events.find((e) => e.kind === "resolution");
    expect(resolution?.data.decisionEvidence).toEqual([1]);
    expect(resolution?.data.supersedes).toEqual([2]);
  });

  it("bulletin_resolve stores an optional rationale", async () => {
    const pi = fakePi() as any;
    extension(pi);
    await callTool(pi, "bulletin_resolve", {
      team_name: "team-x",
      ref: "port",
      decision: "use 8080",
      rationale: "8080 is the load balancer default",
    });
    const events = store.readEvents("team-x");
    const resolution = events.find((e) => e.kind === "resolution");
    expect(resolution?.data.rationale).toBe("8080 is the load balancer default");
  });

  it("bulletin_sync stores structured sections and round", async () => {
    const pi = fakePi() as any;
    extension(pi);
    await callTool(pi, "bulletin_post", { team_name: "team-x", kind: "signal", ref: "port", value: "8080" });
    const res = await callTool(pi, "bulletin_sync", {
      team_name: "team-x",
      digest: "round 1 summary",
      members: ["lead", "tester"],
      decisions: [{ ref: "port", text: "use 8080", evidence: [1] }],
      findings: [{ ref: "api", text: "moved", status: "confirmed" }],
      open: [{ ref: "host", text: "which host?" }],
    });
    const state = res.details.state;
    expect(state.round).toBe(1);
    expect(state.lead).toBe("tester");
    expect(state.decisions).toEqual([{ ref: "port", text: "use 8080", evidence: [1] }]);
    expect(state.findings[0].status).toBe("confirmed");
    expect(state.open).toEqual([{ ref: "host", text: "which host?" }]);
    // status shows round/lead/coverage
    const statusRes = await callTool(pi, "bulletin_status", { team_name: "team-x" });
    expect(statusRes.content[0].text).toContain("round 1");
    expect(statusRes.content[0].text).toContain("by tester");
  });

  it("bulletin_sync surfaces fencing errors (stale round)", async () => {
    const pi = fakePi() as any;
    extension(pi);
    await callTool(pi, "bulletin_sync", { team_name: "team-x", digest: "round 1", members: ["tester"] });
    const err = await callTool(pi, "bulletin_sync", { team_name: "team-x", digest: "round 1 dup", members: ["tester"], round: 1 }).catch((e: Error) => e);
    expect(String(err)).toMatch(/stale digest round 1.*expected 2/);
  });
});
