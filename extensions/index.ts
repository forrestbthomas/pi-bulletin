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
      const lines = [
        `Bulletin: ${s.team} @ ${s.root}`,
        `events: ${s.eventCount} (last seq ${s.lastSeq})`,
      ];
      if (s.state) {
        lines.push(`last digest: seq ${s.state.lastDigestSeq} at ${s.state.digestAt}`);
        lines.push(`round ${s.state.round} by ${s.state.lead} (covers ${s.state.coverageFrom}..${s.state.coverageTo})`);
        lines.push(`members: ${s.state.members.join(", ")}`);
        if (s.state.decisions.length) lines.push(`decisions: ${s.state.decisions.map((d) => `${d.ref}: ${d.text}`).join("; ")}`);
        if (s.state.open.length) lines.push(`open: ${s.state.open.map((o) => `${o.ref}: ${o.text}`).join("; ")}`);
        lines.push(s.state.digest);
      } else {
        lines.push("no digest yet (first bulletin_sync will create one)");
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: s };
    },
  });

  pi.registerTool({
    name: "bulletin_post",
    label: "Bulletin Post",
    description:
      "Post a finding to the shared bulletin. CHEAP: no other agent is notified or interrupted; they observe by reading. Prefer structured data with a `ref` (topic/file) so conflict detection can key on it. Optional `status` sets the claim's evidence tier: proposed (default), confirmed, contested, superseded (audit-only).",
    parameters: Type.Object({
      team_name: Type.String(),
      kind: Type.Optional(Type.Union([Type.Literal("finding"), Type.Literal("signal"), Type.Literal("message")], { default: "finding" })),
      ref: Type.Optional(Type.String({ description: "Topic/file this finding is about (used for cheap conflict detection)." })),
      claim: Type.Optional(Type.String({ description: "The finding/claim/observation itself." })),
      value: Type.Optional(Type.String({ description: "For kind=signal: a compact structured value (e.g. 'claimed', 'sha:abc123')." })),
      to: Type.Optional(Type.String({ description: "For kind=message: recipient agent name. Prefer findings over directed messages." })),
      status: Type.Optional(Type.Union([
        Type.Literal("proposed"),
        Type.Literal("confirmed"),
        Type.Literal("contested"),
        Type.Literal("superseded"),
      ], { description: "Evidence status of this claim. Confirmed = verified/corroborated; contested = in dispute; superseded = audit-only (not a live claim)." })),
    }),
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
      const kind = params.kind || "finding";
      const data: Record<string, unknown> = {};
      if (params.ref) data.ref = params.ref;
      if (params.claim) data.claim = params.claim;
      if (params.value) data.value = params.value;
      if (params.to) data.to = params.to;
      if (params.status) data.status = params.status;
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
      const agent = agentName();
      // Per-agent watermark: without an explicit since_seq, return only NEW
      // events since this agent's last read, then advance the cursor.
      const sinceSeq = params.since_seq !== undefined
        ? params.since_seq
        : store.readWatermark(params.team_name, agent);
      const events = store.readEvents(params.team_name, { sinceSeq, limit: params.limit ?? 20 });
      if (events.length) {
        store.markRead(params.team_name, agent, events[events.length - 1].seq);
      }
      const text = events.length
        ? events.map((e) => `#${e.seq} ${e.kind} ${e.from}: ${JSON.stringify(e.data)}`).join("\n")
        : "no new events since your last read";
      return { content: [{ type: "text", text }], details: { events, watermark: sinceSeq } };
    },
  });

  pi.registerTool({
    name: "bulletin_conflicts",
    label: "Bulletin Conflicts",
    description:
      "CHEAP symbolic conflict check: signal events since `since_seq` on the same ref with different values, evidence-tiered (hard/medium/soft). Same-author later values are updates (not conflicts); superseded claims appear as audit markers. Use before deciding whether a sync round needs LLM reconciliation.",
    parameters: Type.Object({
      team_name: Type.String(),
      since_seq: Type.Number({ description: "Check events after this seq (typically the last digest seq)." }),
    }),
    async execute(_toolCallId, params: any, _signal, _onUpdate, _ctx) {
      const conflicts = store.findConflictsSince(params.team_name, params.since_seq);
      const text = conflicts.length
        ? conflicts.map((c) => {
            if (c.kind === "superseded") {
              return `superseded ref=${c.ref}: seq ${c.seqs[0]} (${JSON.stringify(c.a)}) superseded by resolution ${c.seqs[1]}`;
            }
            const tier = c.tier ? ` [${c.tier}]` : "";
            const authors = c.authors ? ` (${c.authors.join(" vs ")})` : "";
            return `${c.kind === "update" ? "update" : "conflict"} ref=${c.ref}${tier}${authors}: ${JSON.stringify(c.a)} (seq ${c.seqs[0]}) vs ${JSON.stringify(c.b)} (seq ${c.seqs[1]})`;
          }).join("\n")
        : "no conflicts detected";
      return { content: [{ type: "text", text }], details: { conflicts } };
    },
  });

  pi.registerTool({
    name: "bulletin_compact",
    label: "Bulletin Compact",
    description:
      "CHEAP cleanup (the cleaner): archive every event at or before the given seq (default: last digest seq) into archive.jsonl and trim the live log. Run BEFORE a bulletin_sync round to keep the live bulletin lean and token-efficient. Future event ids stay unique (high-watermark).",
    parameters: Type.Object({
      team_name: Type.String(),
      before_seq: Type.Optional(Type.Number({ description: "Archive events with seq <= this (default: last digest seq)." })),
    }),
    async execute(_toolCallId, params: any, _signal, _onUpdate, _ctx) {
      const state = store.readState(params.team_name);
      const beforeSeq = params.before_seq ?? state?.lastDigestSeq ?? 0;
      const r = store.compact(params.team_name, beforeSeq);
      const text = `archived ${r.archived} event(s), kept ${r.kept}`;
      return { content: [{ type: "text", text }], details: r };
    },
  });

  pi.registerTool({
    name: "bulletin_resolve",
    label: "Bulletin Resolve",
    description:
      "Record a conflict resolution for a ref (LEAD ONLY). Cheap: posts a resolution event; the symbolic conflict checker stops flagging that ref. The decision is folded into the next digest. Optional `supersedes` lists the event seqs this decision invalidates (losing claims are kept in the log and shown as superseded audit markers).",
    parameters: Type.Object({
      team_name: Type.String(),
      ref: Type.String({ description: "The ref (topic) being resolved." }),
      decision: Type.String({ description: "The decision (e.g. 'use 8080')." }),
      decision_evidence: Type.Optional(Type.Array(Type.Number(), { description: "Event seqs that motivated this decision (audit)." })),
      supersedes: Type.Optional(Type.Array(Type.Number(), { description: "Event seqs invalidated by this decision (losing claims kept, marked superseded)." })),
      rationale: Type.Optional(Type.String({ description: "Free-text why this decision was made (audit, folded into the next digest)." })),
    }),
    async execute(_toolCallId, params: any, _signal, _onUpdate, _ctx) {
      const data: Record<string, unknown> = { ref: params.ref, decision: params.decision };
      if (params.decision_evidence) data.decisionEvidence = params.decision_evidence;
      if (params.supersedes) data.supersedes = params.supersedes;
      if (params.rationale) data.rationale = params.rationale;
      const event = store.postEvent(params.team_name, "resolution", agentName(), data);
      const text = `resolution #${event.seq} recorded for ref=${params.ref}: ${params.decision}`;
      return { content: [{ type: "text", text }], details: event };
    },
  });

  pi.registerTool({
    name: "bulletin_sync",
    label: "Bulletin Sync",
    description:
      "Run one sync round (LEAD/SUMMARIZER ONLY): compress everything since the last digest into ONE digest entry. This is the single expensive step — one LLM call per round, not per message. After posting, other agents read the digest as their shared picture. The digest can be structured: pass decisions/findings/open with `evidence` event seqs so the snapshot carries provenance. Round is auto-incremented; pass `round` explicitly only on a retry (must equal current round + 1).",
    parameters: Type.Object({
      team_name: Type.String(),
      digest: Type.String({ description: "The compressed summary of what happened since the last digest (max ~500 words)." }),
      members: Type.Optional(Type.Array(Type.String(), { description: "Current member list (recorded for observability)." })),
      round: Type.Optional(Type.Number({ description: "Expected round = current round + 1 (omit to auto-increment; provide on retry)." })),
      decisions: Type.Optional(Type.Array(Type.Object({
        ref: Type.String(),
        text: Type.String(),
        status: Type.Optional(Type.Union([Type.Literal("proposed"), Type.Literal("confirmed"), Type.Literal("contested"), Type.Literal("superseded")])),
        evidence: Type.Optional(Type.Array(Type.Number(), { description: "Event seqs backing this decision." })),
      }), { description: "Decided items (what won), each with event-ID evidence." })),
      findings: Type.Optional(Type.Array(Type.Object({
        ref: Type.String(),
        text: Type.String(),
        status: Type.Optional(Type.Union([Type.Literal("proposed"), Type.Literal("confirmed"), Type.Literal("contested"), Type.Literal("superseded")])),
        evidence: Type.Optional(Type.Array(Type.Number(), { description: "Event seqs backing this finding." })),
      }), { description: "Findings carried forward, each with claim + status + evidence." })),
      open: Type.Optional(Type.Array(Type.Object({
        ref: Type.String(),
        text: Type.String(),
        status: Type.Optional(Type.Union([Type.Literal("proposed"), Type.Literal("confirmed"), Type.Literal("contested"), Type.Literal("superseded")])),
        evidence: Type.Optional(Type.Array(Type.Number(), { description: "Event seqs backing this open question." })),
      }), { description: "Open questions / minority views — never silently resolved." })),
    }),
    async execute(_toolCallId, params: any, _signal, _onUpdate, _ctx) {
      const { event, state } = store.postDigest(
        params.team_name,
        agentName(),
        params.digest,
        params.members ?? [],
        {
          round: params.round,
          decisions: params.decisions,
          findings: params.findings,
          open: params.open,
        },
      );
      const text = `digest #${event.seq} recorded (round ${state.round}, lastDigestSeq=${state.lastDigestSeq}, covers ${state.coverageFrom}..${state.coverageTo})`;
      return { content: [{ type: "text", text }], details: { event, state } };
    },
  });
}
