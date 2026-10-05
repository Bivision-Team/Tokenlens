import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseJsonl, analyzeTranscript, activeChain, isSubagentTranscript } from "../src/transcript.js";
import { sanitizeHookInput } from "../src/hook.js";

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
