import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseJsonl, analyzeTranscript, activeChain, apiEquivalent, combineSessionTree, dedupeTranscriptEntries, findSubagentTranscripts, isSubagentTranscript } from "../src/transcript.js";
import { pruneEvents, readAgentTypes, sanitizeHookInput } from "../src/hook.js";
import { buildTeamReport } from "../src/cli.js";

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

test("reports unique and cumulative attribution without forcing reconciliation", () => {
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
  assert.ok(report.context.cumulative.fixed_overhead > 0);
  assert.equal(typeof report.context.cumulative.unattributed, "number");
  assert.equal(typeof report.context.cumulative.coverage_percent, "number");
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
