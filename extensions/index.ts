/**
 * pi-bulletin — extension entry (SPIKE).
 *
 * Registers the bulletin tool surface. The substrate is deliberately small:
 * everything here is CHEAP (file I/O, no LLM calls). Expensive work
 * (summarization, reconciliation) is invoked by the agent through the skill
 * prompt at explicit sync points, never by the tools themselves.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as store from "../src/store";

/**
 * Agent identity comes from the environment (the spawner/lead sets
 * PI_BULLETIN_AGENT per session), not from ExtensionContext — the Pi
 * extension API does not expose an agent name. Same pattern as
 * pi-teams/Claude Teams env vars on spawned teammates.
 */
function agentName(): string {
  return process.env.PI_BULLETIN_AGENT || "agent";
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "bulletin_status",
    label: "Bulletin Status",
    description:
      "Show the shared bulletin for a team: root path, event count, last digest, members. Call this first to confirm the team name and that the bulletin exists.",
    parameters: Type.Object({
      team_name: Type.String({ description: "Team name (matches the bulletin directory under ~/.pi/teams/)." }),
    }),
    async execute(_toolCallId, params: { team_name: string }, _signal, _onUpdate, _ctx) {
      const s = store.status(params.team_name);
      const text = [
        `Bulletin: ${s.team} @ ${s.root}`,
        `events: ${s.eventCount} (last seq ${s.lastSeq})`,
        s.state
          ? `last digest: seq ${s.state.lastDigestSeq} at ${s.state.digestAt}\nmembers: ${s.state.members.join(", ")}\n${s.state.digest}`
          : "no digest yet (first bulletin_sync will create one)",
      ].join("\n");
      return { content: [{ type: "text", text }], details: s };
    },
  });

  pi.registerTool({
    name: "bulletin_post",
    label: "Bulletin Post",
    description:
      "Post a finding to the shared bulletin. CHEAP: no other agent is notified or interrupted; they observe by reading. Prefer structured data with a `ref` (topic/file) so conflict detection can key on it.",
    parameters: Type.Object({
      team_name: Type.String(),
      kind: Type.Optional(Type.Union([Type.Literal("finding"), Type.Literal("signal"), Type.Literal("message")], { default: "finding" })),
      ref: Type.Optional(Type.String({ description: "Topic/file this finding is about (used for cheap conflict detection)." })),
      claim: Type.Optional(Type.String({ description: "The finding/claim/observation itself." })),
      value: Type.Optional(Type.String({ description: "For kind=signal: a compact structured value (e.g. 'claimed', 'sha:abc123')." })),
      to: Type.Optional(Type.String({ description: "For kind=message: recipient agent name. Prefer findings over directed messages." })),
    }),
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
      const kind = params.kind || "finding";
      const data: Record<string, unknown> = {};
      if (params.ref) data.ref = params.ref;
      if (params.claim) data.claim = params.claim;
      if (params.value) data.value = params.value;
      if (params.to) data.to = params.to;
      const event = store.postEvent(params.team_name, kind, agentName(), data);
      const text = `posted ${kind} #${event.seq} (${event.from})`;
      return { content: [{ type: "text", text }], details: event };
    },
  });

  pi.registerTool({
    name: "bulletin_read",
    label: "Bulletin Read",
    description:
      "Read recent bulletin events, optionally since a sequence number. CHEAP (file read, no LLM). Use this instead of messaging other agents to 'check in' — the bulletin is the shared picture.",
    parameters: Type.Object({
      team_name: Type.String(),
      since_seq: Type.Optional(Type.Number({ description: "Only events with seq > this value." })),
      limit: Type.Optional(Type.Number({ description: "Tail limit (default 20)." })),
    }),
    async execute(_toolCallId, params: any, _signal, _onUpdate, _ctx) {
      const events = store.readEvents(params.team_name, { sinceSeq: params.since_seq, limit: params.limit ?? 20 });
      const text = events.length
        ? events.map((e) => `#${e.seq} ${e.kind} ${e.from}: ${JSON.stringify(e.data)}`).join("\n")
        : "no events";
      return { content: [{ type: "text", text }], details: { events } };
    },
  });

  pi.registerTool({
    name: "bulletin_conflicts",
    label: "Bulletin Conflicts",
    description:
      "CHEAP symbolic conflict check: signal events since `since_seq` with the same ref but different values. Use before deciding whether a sync round needs LLM reconciliation.",
    parameters: Type.Object({
      team_name: Type.String(),
      since_seq: Type.Number({ description: "Check events after this seq (typically the last digest seq)." }),
    }),
    async execute(_toolCallId, params: any, _signal, _onUpdate, _ctx) {
      const conflicts = store.findConflictsSince(params.team_name, params.since_seq);
      const text = conflicts.length
        ? conflicts.map((c) => `conflict ref=${c.ref}: ${JSON.stringify(c.a)} (seq ${c.seqs[0]}) vs ${JSON.stringify(c.b)} (seq ${c.seqs[1]})`).join("\n")
        : "no conflicts detected";
      return { content: [{ type: "text", text }], details: { conflicts } };
    },
  });

  pi.registerTool({
    name: "bulletin_sync",
    label: "Bulletin Sync",
    description:
      "Run one sync round (LEAD/SUMMARIZER ONLY): compress everything since the last digest into ONE digest entry. This is the single expensive step — one LLM call per round, not per message. After posting, other agents read the digest as their shared picture.",
    parameters: Type.Object({
      team_name: Type.String(),
      digest: Type.String({ description: "The compressed summary of what happened since the last digest (max ~500 words)." }),
      members: Type.Optional(Type.Array(Type.String(), { description: "Current member list (recorded for observability)." })),
    }),
    async execute(_toolCallId, params: any, _signal, _onUpdate, _ctx) {
      const { event, state } = store.postDigest(
        params.team_name,
        agentName(),
        params.digest,
        params.members ?? [],
      );
      const text = `digest #${event.seq} recorded (lastDigestSeq=${state.lastDigestSeq})`;
      return { content: [{ type: "text", text }], details: { event, state } };
    },
  });
}
