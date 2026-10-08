import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseJsonl, analyzeTranscript, activeChain, apiEquivalent, combineSessionTree, dedupeTranscriptEntries, findSubagentTranscripts, isSubagentTranscript } from "../src/transcript.js";
import { pruneEvents, readAgentTypeFromMeta, readAgentTypes, resolveAgentType, sanitizeHookInput } from "../src/hook.js";
import { buildTeamReport } from "../src/cli.js";
import { estimateTokens } from "../src/privacy.js";
import { renderReport } from "../src/report.js";

function assistant(uuid, parentUuid, id, usage, content) {
  return {
    type: "assistant", uuid, parentUuid, requestId: `req-${id}`,
    message: { id, model: "claude-test", usage, content }
  };
}

const usage = {
  input_tokens: 10,
  cache_read_input_tokens: 20,
  cache_creation_input_tokens: 5,
  output_tokens: 3
};

test("deduplicates usage repeated across assistant content entries", () => {
  const entries = [
    assistant("a", null, "msg-1", usage, [{ type: "text", text: "hello" }]),
    assistant("b", "a", "msg-1", usage, [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } }])
  ];
  const report = analyzeTranscript(entries);
  assert.equal(report.session.requests, 1);
  assert.equal(report.session.processed_input, 35);
  assert.equal(report.session.exact_totals.output, 3);
});

test("fresh session splits processed input exactly into first-request baseline and growth", () => {
  const first = { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 2 };
  const second = { input_tokens: 0, cache_read_input_tokens: 120, cache_creation_input_tokens: 0, output_tokens: 2 };
  const report = analyzeTranscript([
    { type: "user", uuid: "u1", message: { content: "hello" } },
    assistant("a1", "u1", "m1", first, [{ type: "text", text: "answer" }]),
    { type: "user", uuid: "u2", parentUuid: "a1", message: { content: "next" } },
    assistant("a2", "u2", "m2", second, [{ type: "text", text: "done" }])
  ]);
  assert.equal(report.session.processed_input, 220);
  assert.ok(report.context.cumulative.categories["User prompts"] > report.context.categories["User prompts"]);
  assert.equal(report.context.cumulative.fixed_overhead_method, "first_nonzero_request_floor_minus_visible");
  assert.equal(report.context.cumulative.fixed_overhead + report.context.cumulative.conversation_growth, 220);
  assert.equal(typeof report.context.cumulative.growth_residual, "number");
  assert.equal(typeof report.context.cumulative.growth_coverage_percent, "number");
  assert.equal(report.context.cumulative.coverage_percent, undefined);
});

test("human report uses the honest decomposition labels and flags weak growth coverage", () => {
  const prompt = "hello";
  const report = analyzeTranscript([
    { type: "user", uuid: "label-u1", message: { content: prompt } },
    assistant("label-a1", "label-u1", "label-m1", { input_tokens: 100, output_tokens: 1 }, [{ type: "text", text: "answer" }]),
    assistant("label-a2", "label-a1", "label-m2", { cache_read_input_tokens: 300, output_tokens: 1 }, [{ type: "text", text: "done" }])
  ]);
  const rendered = renderReport(report, "fixture.jsonl");
  assert.match(rendered, /Measured fixed baseline \(first-request floor\)/);
  assert.match(rendered, /Conversation growth/);
  assert.match(rendered, /Growth coverage:.*LOW CONFIDENCE/);
});

test("request input below the segment baseline remains a non-negative exact split", () => {
  const prompt = "hello";
  const firstInput = 100 + estimateTokens(prompt);
  const report = analyzeTranscript([
    { type: "user", uuid: "floor-u1", message: { content: prompt } },
    assistant("floor-a1", "floor-u1", "floor-m1", { input_tokens: firstInput, output_tokens: 1 }, [{ type: "text", text: "answer" }]),
    assistant("floor-a2", "floor-a1", "floor-m2", { cache_read_input_tokens: 50, output_tokens: 1 }, [{ type: "text", text: "answer" }])
  ]);
  const cumulative = report.context.cumulative;
  assert.equal(cumulative.fixed_overhead, 150);
  assert.equal(cumulative.conversation_growth, estimateTokens(prompt));
  assert.equal(cumulative.fixed_overhead + cumulative.conversation_growth, report.session.processed_input);
  assert.ok(cumulative.fixed_overhead >= 0);
  assert.ok(cumulative.conversation_growth >= 0);
});

test("keep-all thinking models use recorded output tokens for assistant growth exposure", () => {
  const first = assistant("thinking-a1", "thinking-u1", "thinking-m1", { input_tokens: 100, output_tokens: 80 }, [
    { type: "thinking", thinking: "short summary", signature: "opaque" },
    { type: "text", text: "visible" }
  ]);
  first.message.model = "claude-opus-5-5";
  const second = assistant("thinking-a2", "thinking-a1", "thinking-m2", { cache_read_input_tokens: 220, output_tokens: 1 }, [{ type: "text", text: "done" }]);
  second.message.model = "claude-opus-5-5";
  const report = analyzeTranscript([
    { type: "user", uuid: "thinking-u1", message: { content: "prompt" } },
    first,
    second
  ]);
  assert.ok(report.context.cumulative.categories["Assistant responses"] >= 80);
});

test("resumed transcript subtracts visible history from the first non-zero request floor", () => {
  const history = "previous conversation context";
  const prompt = "continue the task";
  const visible = estimateTokens(history) + estimateTokens(prompt);
  const report = analyzeTranscript([
    { type: "assistant", uuid: "history", message: { content: history } },
    { type: "user", uuid: "u1", parentUuid: "history", message: { content: prompt } },
    assistant("a1", "u1", "m1", { input_tokens: 1000 + visible, output_tokens: 2 }, [{ type: "text", text: "answer" }])
  ]);
  assert.equal(report.context.cumulative.baseline_per_request, 1000);
  assert.equal(report.context.cumulative.fixed_overhead, 1000);
  assert.equal(report.context.cumulative.conversation_growth, visible);
  assert.equal(report.context.cumulative.fixed_overhead + report.context.cumulative.conversation_growth, report.session.processed_input);
});

test("mid-session compact starts a new independently measured baseline segment", () => {
  const before = "first prompt";
  const summary = "compact summary";
  const firstInput = 1000 + estimateTokens(before);
  const secondInput = 1100;
  const compactInput = 700 + estimateTokens(summary);
  const report = analyzeTranscript([
    { type: "user", uuid: "u1", message: { content: before } },
    assistant("a1", "u1", "m1", { input_tokens: firstInput, output_tokens: 2 }, [{ type: "text", text: "answer" }]),
    { type: "user", uuid: "u2", parentUuid: "a1", message: { content: "more" } },
    assistant("a2", "u2", "m2", { cache_read_input_tokens: secondInput, output_tokens: 2 }, [{ type: "text", text: "done" }]),
    { type: "system", uuid: "compact", subtype: "compact_boundary" },
    { type: "user", uuid: "summary", parentUuid: "compact", isMeta: true, message: { content: summary } },
    assistant("a3", "summary", "m3", { cache_creation_input_tokens: compactInput, output_tokens: 2 }, [{ type: "text", text: "continued" }])
  ]);
  const cumulative = report.context.cumulative;
  assert.equal(cumulative.segments.length, 2);
  assert.deepEqual(cumulative.segments.map((item) => item.baseline_per_request), [1000, 700]);
  assert.equal(cumulative.fixed_overhead + cumulative.conversation_growth, report.session.processed_input);
  for (const segment of cumulative.segments) {
    assert.equal(segment.fixed_overhead + segment.conversation_growth, segment.processed_input);
    assert.ok(segment.fixed_overhead >= 0);
    assert.ok(segment.conversation_growth >= 0);
  }
});

test("subagent transcript keeps the exact baseline-growth invariant", () => {
  const prompt = "inspect one bounded component";
  const firstInput = 500 + estimateTokens(prompt);
  const report = analyzeTranscript([
    { type: "user", uuid: "agent-u1", agentId: "a1", message: { content: prompt } },
    { ...assistant("agent-a1", "agent-u1", "agent-m1", { input_tokens: firstInput, output_tokens: 1 }, [{ type: "text", text: "result" }]), agentId: "a1" },
    { type: "user", uuid: "agent-u2", parentUuid: "agent-a1", agentId: "a1", message: { content: "verify" } },
    { ...assistant("agent-a2", "agent-u2", "agent-m2", { cache_read_input_tokens: 650, output_tokens: 1 }, [{ type: "text", text: "verified" }]), agentId: "a1" }
  ]);
  assert.equal(report.context.cumulative.fixed_overhead + report.context.cumulative.conversation_growth, report.session.processed_input);
  assert.equal(report.context.cumulative.baseline_per_request, 500);
});

test("entries missing session identity stay with the transcript's sole known session", () => {
  const report = analyzeTranscript([
    { type: "user", uuid: "identity-u1", message: { content: "prompt" } },
    { ...assistant("identity-a1", "identity-u1", "identity-m1", { input_tokens: 100, output_tokens: 1 }, [{ type: "text", text: "answer" }]), sessionId: "session-1" }
  ]);
  assert.equal(report.context.cumulative.transcript_groups, 1);
  assert.equal(report.context.cumulative.fixed_overhead + report.context.cumulative.conversation_growth, 100);
});

test("very large first prompt is growth and cannot trigger fixed-overhead-high", () => {
  const prompt = "x".repeat(600_000);
  const visible = estimateTokens(prompt);
  const report = analyzeTranscript([
    { type: "user", uuid: "large-u1", message: { content: prompt } },
    assistant("large-a1", "large-u1", "large-m1", { input_tokens: 50_000 + visible, output_tokens: 1 }, [{ type: "text", text: "ok" }])
  ]);
  assert.equal(report.context.cumulative.baseline_per_request, 50_000);
  assert.equal(report.context.cumulative.conversation_growth, visible);
  assert.equal(report.context.cumulative.fixed_overhead + report.context.cumulative.conversation_growth, report.session.processed_input);
  assert.equal(report.recommendations.some((item) => item.rule === "fixed-overhead-high"), false);
});

test("fixed-overhead-high uses an absolute measured baseline threshold", () => {
  const prompt = "small prompt";
  const visible = estimateTokens(prompt);
  const report = analyzeTranscript([
    { type: "user", uuid: "fixed-u1", message: { content: prompt } },
    assistant("fixed-a1", "fixed-u1", "fixed-m1", { input_tokens: 75_000 + visible, output_tokens: 1 }, [{ type: "text", text: "ok" }])
  ]);
  const recommendation = report.recommendations.find((item) => item.rule === "fixed-overhead-high");
  assert.equal(recommendation.threshold, ">=75k measured baseline/request");
  assert.equal(recommendation.observed, 75_000);
});

test("partial-period analysis suppresses fixed-baseline recommendations", () => {
  const prompt = "small prompt";
  const visible = estimateTokens(prompt);
  const report = analyzeTranscript([
    { type: "user", uuid: "partial-u1", message: { content: prompt } },
    assistant("partial-a1", "partial-u1", "partial-m1", { input_tokens: 90_000 + visible, output_tokens: 1 }, [{ type: "text", text: "ok" }])
  ], [], { scope: "all", baselineScopeComplete: false });
  assert.equal(report.context.cumulative.baseline_scope_complete, false);
  assert.equal(report.recommendations.some((item) => item.rule === "fixed-overhead-high"), false);
  assert.match(report.warnings.join(" "), /recommendations are suppressed/);
});

test("growth coverage can fail and is reported as low confidence", () => {
  const prompt = "tiny";
  const report = analyzeTranscript([
    { type: "user", uuid: "low-u1", message: { content: prompt } },
    assistant("low-a1", "low-u1", "low-m1", { input_tokens: 1000 + estimateTokens(prompt), output_tokens: 1 }, [{ type: "text", text: "ok" }]),
    assistant("low-a2", "low-a1", "low-m2", { cache_read_input_tokens: 5000, output_tokens: 1 }, [{ type: "text", text: "ok" }])
  ]);
  assert.ok(report.context.cumulative.growth_coverage_percent < 70);
  assert.match(report.warnings.join(" "), /low confidence below 70%/);
});

test("computes normalized API-equivalent input weights", () => {
  const result = apiEquivalent({ input: 100, cacheRead: 1000, cacheCreation: 100, output: 999 });
  assert.equal(result.input_units, 325);
  assert.equal(result.excludes_output, true);
});

test("finds repeated unchanged reads and does not persist their content", () => {
  const entries = [
    assistant("a", null, "m1", usage, [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/A.ts" } }]),
    { type: "user", uuid: "b", parentUuid: "a", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "SECRET SOURCE" }] } },
    assistant("c", "b", "m2", usage, [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "src/a.ts" } }]),
    { type: "user", uuid: "d", parentUuid: "c", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "SECRET SOURCE" }] } }
  ];
  const report = analyzeTranscript(entries);
  assert.equal(report.repeated_reads.length, 1);
  assert.equal(report.repeated_reads[0].occurrences, 2);
  assert.doesNotMatch(JSON.stringify(report), /SECRET SOURCE/);
});

test("detects repeated command loops without exposing command text", () => {
  const entries = [];
  for (let index = 0; index < 3; index += 1) {
    entries.push(assistant(`a${index}`, index ? `u${index}` : null, `m${index}`, usage, [{
      type: "tool_use", id: `t${index}`, name: "Bash", input: { command: "SECRET RETRY COMMAND" }
    }]));
    entries.push({ type: "user", uuid: `u${index + 1}`, parentUuid: `a${index}`, message: { content: "continue" } });
  }
  const report = analyzeTranscript(entries);
  assert.equal(report.repeated_commands[0].occurrences, 3);
  assert.match(report.recommendations.map((item) => item.rule).join(" "), /repeated-command-loop/);
  assert.doesNotMatch(JSON.stringify(report.repeated_commands), /SECRET RETRY COMMAND/);
});

test("active chain ignores abandoned branches", () => {
  const entries = [
    { type: "user", uuid: "root", message: { content: "root" } },
    { type: "assistant", uuid: "old", parentUuid: "root", message: { content: "old" } },
    { type: "assistant", uuid: "new", parentUuid: "root", message: { content: "new" } },
    { type: "last-prompt", leafUuid: "new" }
  ];
  assert.deepEqual(activeChain(entries).map((entry) => entry.uuid), ["root", "new"]);
});

test("classifies metadata separately and does not double count tool errors", () => {
  const entries = [
    { type: "user", uuid: "u1", isMeta: true, message: { content: [{ type: "text", text: "system reminder" }] } },
    assistant("a", "u1", "m1", usage, [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "false" } }]),
    { type: "user", uuid: "u2", parentUuid: "a", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "failed" }] } }
  ];
  const report = analyzeTranscript(entries);
  assert.ok(report.context.categories["Other / Claude-managed"] > 0);
  assert.ok(report.context.categories["Errors / retries"] > 0);
  assert.equal(report.context.categories["Bash / test output"], undefined);
});

test("reports API errors without presenting zero usage as an exact successful request", () => {
  const entries = [{
    type: "assistant",
    uuid: "error-1",
    requestId: "req-error",
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    message: { id: "msg-error", usage, content: [{ type: "text", text: "rate limited" }] }
  }];
  const report = analyzeTranscript(entries);
  assert.equal(report.session.requests, 0);
  assert.equal(report.session.failed_requests.count, 1);
  assert.deepEqual(report.session.failed_requests.statuses, [429]);
  assert.equal(report.session.exact_totals, null);
  assert.equal(report.session.processed_input, null);
  assert.match(report.warnings.join(" "), /429/);
});

test("parser tolerates a partially-written final JSONL line", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tokenlens-"));
  const file = path.join(directory, "session.jsonl");
  fs.writeFileSync(file, '{"type":"user","uuid":"1"}\n{"broken":');
  const parsed = await parseJsonl(file);
  assert.equal(parsed.entries.length, 1);
  assert.deepEqual(parsed.malformed, [2]);
});

test("distinguishes main transcripts from nested subagent transcripts", () => {
  assert.equal(isSubagentTranscript(path.join("project", "session.jsonl")), false);
  assert.equal(isSubagentTranscript(path.join("project", "session", "subagents", "agent-123.jsonl")), true);
  assert.equal(isSubagentTranscript(path.join("project", "agent-123.jsonl")), true);
});

test("discovers only subagents belonging to the selected main transcript", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tokenlens-tree-"));
  const main = path.join(directory, "session-1.jsonl");
  const own = path.join(directory, "session-1", "subagents");
  const other = path.join(directory, "session-2", "subagents");
  fs.mkdirSync(own, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(main, "");
  fs.writeFileSync(path.join(own, "agent-a.jsonl"), "");
  fs.writeFileSync(path.join(other, "agent-b.jsonl"), "");
  assert.deepEqual(findSubagentTranscripts(main), [path.join(own, "agent-a.jsonl")]);
});

test("combines main and subagent usage without counting returned summaries as requests", () => {
  const mainReport = analyzeTranscript([
    assistant("main-a", null, "main-message", usage, [{ type: "text", text: "main" }]),
    { type: "user", uuid: "main-b", parentUuid: "main-a", message: { content: [{ type: "tool_result", tool_use_id: "agent-tool", content: "agent summary" }] } }
  ]);
  const agentUsage = { ...usage, cache_read_input_tokens: 90, output_tokens: 7 };
  const agentReport = analyzeTranscript([
    assistant("agent-a", null, "agent-message", agentUsage, [{ type: "text", text: "agent" }])
  ]);
  const combined = combineSessionTree(
    { kind: "main", id: "session-1", source: "session-1.jsonl", report: mainReport },
    [{ kind: "agent", id: "a", source: "agent-a.jsonl", report: agentReport }]
  );
  assert.equal(combined.totals.requests, 2);
  assert.equal(combined.totals.processed_input, 140);
  assert.equal(combined.totals.exact_totals.output, 10);
  assert.equal(combined.top_consumer.id, "a");
  assert.equal(combined.agents[0].share_percent, 75);
});

test("deduplicates copied transcript history before aggregate analysis", () => {
  const copied = { type: "user", uuid: "same-uuid", timestamp: "2026-10-01T00:00:00Z", message: { content: "same" } };
  const unique = { type: "user", uuid: "unique-uuid", timestamp: "2026-10-02T00:00:00Z", message: { content: "unique" } };
  const deduped = dedupeTranscriptEntries([copied, { ...copied }, unique]);
  assert.equal(deduped.length, 2);
});

test("aggregate scope includes independent branches", () => {
  const entries = [
    { type: "user", uuid: "root", message: { content: "root" } },
    { type: "assistant", uuid: "left", parentUuid: "root", message: { content: "left" } },
    { type: "assistant", uuid: "right", parentUuid: "root", message: { content: "right" } },
    { type: "last-prompt", leafUuid: "right" }
  ];
  const current = analyzeTranscript(entries);
  const aggregate = analyzeTranscript(entries, [], { scope: "all" });
  assert.ok(aggregate.context.attributed_message_tokens > current.context.attributed_message_tokens);
});

test("hook sanitizer records measurements but no sensitive content", () => {
  process.env.TOKENLENS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tokenlens-data-"));
  const result = sanitizeHookInput({
    hook_event_name: "PostToolBatch",
    session_id: "s1",
    cwd: process.cwd(),
    prompt: "TOP SECRET PROMPT",
    tool_calls: [{
      tool_name: "Bash",
      tool_use_id: "t1",
      tool_input: { command: "curl -H Authorization:SECRET https://example.com" },
      tool_response: "TOP SECRET OUTPUT"
    }]
  });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /TOP SECRET|Authorization|curl|example\.com/);
  assert.equal(result.content_stored, false);
  assert.ok(result.prompt.estimated_tokens > 0);
});

test("reads agent types from privacy-safe hook metadata", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenlens-agent-types-"));
  process.env.TOKENLENS_DATA_DIR = root;
  const directory = path.join(root, "sessions", "s1", "events");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "event.json"), JSON.stringify({ agent_id: "a1", agent_type: "Explore", content_stored: false }));
  assert.equal(readAgentTypes("s1").get("a1"), "Explore");
});

test("falls back to subagent meta type while hook metadata keeps precedence", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tokenlens-agent-meta-"));
  const transcript = path.join(directory, "agent-a1.jsonl");
  fs.writeFileSync(transcript, "");
  fs.writeFileSync(path.join(directory, "agent-a1.meta.json"), JSON.stringify({
    agentType: "claude-code-guide",
    description: "PRIVATE DESCRIPTION MUST NOT BE RETURNED"
  }));
  assert.equal(readAgentTypeFromMeta(transcript), "claude-code-guide");
  assert.equal(resolveAgentType(new Map(), "a1", transcript), "claude-code-guide");
  assert.equal(resolveAgentType(new Map([["a1", "Explore"]]), "a1", transcript), "Explore");
  assert.doesNotMatch(JSON.stringify({ agent_type: resolveAgentType(new Map(), "a1", transcript) }), /PRIVATE DESCRIPTION/);
  fs.writeFileSync(path.join(directory, "agent-a1.meta.json"), "{broken");
  assert.equal(readAgentTypeFromMeta(transcript), undefined);
});

test("prunes expired hook events and preserves current metadata", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenlens-retention-"));
  process.env.TOKENLENS_DATA_DIR = root;
  process.env.TOKENLENS_RETENTION_DAYS = "30";
  const directory = path.join(root, "sessions", "s1", "events");
  fs.mkdirSync(directory, { recursive: true });
  const oldFile = path.join(directory, "old.json");
  const newFile = path.join(directory, "new.json");
  fs.writeFileSync(oldFile, "{}");
  fs.writeFileSync(newFile, "{}");
  const now = Date.now();
  fs.utimesSync(oldFile, new Date(now - 31 * 86_400_000), new Date(now - 31 * 86_400_000));
  assert.equal(pruneEvents(now), 1);
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(newFile), true);
});

test("merges aggregate JSON into person-project-agent rows", () => {
  const exact = { input: 10, cacheRead: 90, cacheCreation: 0, output: 2 };
  const agent = { requests: 1, failed_requests: 0, exact_totals: exact, processed_input: 100, api_equivalent: apiEquivalent(exact) };
  const report = buildTeamReport([{ source: "fallback.json", report: {
    period: { since: "2026-10-01", until: "2026-10-02" },
    identity: { person: "Dato", project: "Pulse" },
    usage: { requests: 3, failed_requests: { count: 0 }, exact_totals: { input: 30, cacheRead: 270, cacheCreation: 0, output: 6 } },
    agents_by_type: { Explore: agent }
  } }]);
  assert.equal(report.rows.length, 2);
  assert.deepEqual(report.rows.map((row) => row.agent_type), ["main", "Explore"]);
  assert.equal(report.rows[0].processed_input, 200);
});
