import { describe, expect, it } from "vitest";
import extension from "./index";

/** Minimal ExtensionAPI stub: capture every registerTool call. */
function fakePi() {
  const tools: unknown[] = [];
  return {
    registerTool: (t: unknown) => tools.push(t),
    tools,
  };
}

describe("pi-bulletin extension", () => {
  it("registers the five bulletin tools", () => {
    const pi = fakePi() as any;
    extension(pi);
    const names = pi.tools.map((t: any) => t.name).sort();
    expect(names).toEqual([
      "bulletin_conflicts",
      "bulletin_post",
      "bulletin_read",
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
});
