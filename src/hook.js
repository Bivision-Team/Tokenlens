import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataDir, fingerprint, measurement, safePath, writeJsonAtomic } from "./privacy.js";

export function pruneEvents(now = Date.now()) {
  const configured = Number(process.env.TOKENLENS_RETENTION_DAYS || 30);
  const retentionDays = Number.isFinite(configured) && configured >= 1 ? configured : 30;
  const root = path.join(dataDir(), "sessions");
  if (!fs.existsSync(root)) return 0;
  const cutoff = now - retentionDays * 86_400_000;
  let removed = 0;
  for (const session of fs.readdirSync(root, { withFileTypes: true })) {
    if (!session.isDirectory()) continue;
    const events = path.join(root, session.name, "events");
    if (!fs.existsSync(events)) continue;
    for (const item of fs.readdirSync(events, { withFileTypes: true })) {
      if (!item.isFile() || !item.name.endsWith(".json")) continue;
      const file = path.join(events, item.name);
      if (fs.statSync(file).mtimeMs < cutoff) {
        fs.unlinkSync(file);
        removed += 1;
      }
    }
  }
  return removed;
}

export function readAgentTypes(sessionId) {
  const directory = path.join(dataDir(), "sessions", String(sessionId), "events");
  const types = new Map();
  if (!fs.existsSync(directory)) return types;
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!item.isFile() || !item.name.endsWith(".json")) continue;
    try {
      const event = JSON.parse(fs.readFileSync(path.join(directory, item.name), "utf8"));
      if (event.agent_id && event.agent_type) types.set(String(event.agent_id), String(event.agent_type));
    } catch {}
  }
  return types;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function summarizeToolCall(call, cwd) {
  const input = call?.tool_input || {};
  const response = call?.tool_response;
  return {
    tool_name: call?.tool_name,
    tool_use_id: call?.tool_use_id,
    file: safePath(input.file_path || input.path, cwd),
    offset: Number.isFinite(input.offset) ? input.offset : undefined,
    limit: Number.isFinite(input.limit) ? input.limit : undefined,
    input_shape: Object.keys(input).sort(),
    response: response === undefined ? undefined : measurement(response)
  };
}

export function sanitizeHookInput(input) {
  const event = {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    hook_event_name: input.hook_event_name,
    session_id: input.session_id,
    prompt_id: input.prompt_id,
    tool_use_id: input.tool_use_id,
    agent_id: input.agent_id,
    agent_type: input.agent_type,
    permission_mode: input.permission_mode,
    reason: input.reason,
    trigger: input.trigger,
    duration_ms: input.duration_ms,
    content_stored: false
  };

  if (input.prompt !== undefined) event.prompt = measurement(input.prompt);
  if (input.compact_summary !== undefined) event.compact_summary = measurement(input.compact_summary);
  if (input.last_assistant_message !== undefined) event.last_assistant_message = measurement(input.last_assistant_message);
  if (input.error !== undefined) event.error = measurement(input.error);

  if (input.tool_name) {
    event.tool = summarizeToolCall(input, input.cwd);
    if (input.tool_response !== undefined) event.tool.response = measurement(input.tool_response);
  }
  if (Array.isArray(input.tool_calls)) {
    event.tool_calls = input.tool_calls.map((call) => summarizeToolCall(call, input.cwd));
  }

  if (input.file_path) event.file = safePath(input.file_path, input.cwd);
  if (input.agent_transcript_path) {
    event.agent_transcript_ref = fingerprint(input.agent_transcript_path).slice(0, 24);
  }
  return event;
}

export async function runHook() {
  const raw = await readStdin();
  if (!raw.trim()) return;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  const event = sanitizeHookInput(input);
  if (input.hook_event_name === "SessionStart") pruneEvents();
  const session = String(input.session_id || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
  const directory = path.join(dataDir(), "sessions", session, "events");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${Date.now()}-${process.pid}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(file, `${JSON.stringify(event)}\n`, { flag: "wx", mode: 0o600 });

  if (input.cwd && input.transcript_path) {
    const activeKey = fingerprint(path.resolve(input.cwd)).slice(0, 32);
    writeJsonAtomic(path.join(dataDir(), "active", `${activeKey}.json`), {
      schema_version: 1,
      session_id: input.session_id,
      updated_at: new Date().toISOString()
    });
  }
}
