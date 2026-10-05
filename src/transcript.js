import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import crypto from "node:crypto";
import { dataDir, estimateTokens, fingerprint } from "./privacy.js";

export async function parseJsonl(file) {
  const entries = [];
  const malformed = [];
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      malformed.push(lineNumber);
    }
  }
  return { entries, malformed };
}

function walkFiles(root, suffix, output) {
  if (!fs.existsSync(root)) return;
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, item.name);
    if (item.isDirectory()) walkFiles(full, suffix, output);
    else if (item.isFile() && item.name.endsWith(suffix)) output.push(full);
  }
}

export function isSubagentTranscript(file) {
  const segments = path.normalize(file).split(path.sep).map((segment) => segment.toLowerCase());
  return segments.includes("subagents") || /^agent-/i.test(path.basename(file));
}

export function findTranscript(query, cwd = process.cwd()) {
  if (query && fs.existsSync(path.resolve(query))) return path.resolve(query);

  let activeSession;
  try {
    const activeKey = fingerprint(path.resolve(cwd)).slice(0, 32);
    const active = JSON.parse(fs.readFileSync(path.join(dataDir(), "active", `${activeKey}.json`), "utf8"));
    if (!query || active.session_id === query) activeSession = active.session_id;
  } catch {}

  const files = [];
  walkFiles(path.join(os.homedir(), ".claude", "projects"), ".jsonl", files);
  const wanted = query || activeSession;
  const matching = wanted
    ? files.filter((file) => path.basename(file, ".jsonl") === wanted)
    : files.filter((file) => !isSubagentTranscript(file));
  matching.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return matching[0];
}

export function findTranscriptCandidates(cwd = process.cwd()) {
  let activeSession;
  try {
    const activeKey = fingerprint(path.resolve(cwd)).slice(0, 32);
    const active = JSON.parse(fs.readFileSync(path.join(dataDir(), "active", `${activeKey}.json`), "utf8"));
    activeSession = active.session_id;
  } catch {}

  const files = [];
  walkFiles(path.join(os.homedir(), ".claude", "projects"), ".jsonl", files);
  const mainFiles = files.filter((file) => !isSubagentTranscript(file));
  const activeFile = activeSession
    ? mainFiles.find((file) => path.basename(file, ".jsonl") === activeSession)
    : undefined;
  const candidates = activeFile
    ? mainFiles.filter((file) => path.dirname(file) === path.dirname(activeFile))
    : mainFiles;
  return candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

export function findAllMainTranscripts() {
  const files = [];
  walkFiles(path.join(os.homedir(), ".claude", "projects"), ".jsonl", files);
  return files
    .filter((file) => !isSubagentTranscript(file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

export function dedupeTranscriptEntries(entries) {
  const seen = new Set();
  return entries.filter((entry, index) => {
    const key = entry.uuid
      ? `uuid:${entry.uuid}`
      : entry.type === "assistant" && (entry.requestId || entry.message?.id)
        ? `assistant:${entry.requestId || entry.message.id}:${entry.message?.content?.[0]?.type || index}`
        : undefined;
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function activeChain(entries) {
  const byUuid = new Map(entries.filter((entry) => entry.uuid).map((entry) => [entry.uuid, entry]));
  const explicitLeaf = [...entries].reverse().find((entry) => entry.leafUuid)?.leafUuid;
  let cursor = explicitLeaf ? byUuid.get(explicitLeaf) : [...entries].reverse().find((entry) => entry.uuid);
  const chain = [];
  const seen = new Set();
  while (cursor && !seen.has(cursor.uuid)) {
    seen.add(cursor.uuid);
    chain.push(cursor);
    cursor = cursor.parentUuid ? byUuid.get(cursor.parentUuid) : undefined;
  }
  chain.reverse();
  const compactIndex = chain.findLastIndex((entry) =>
    entry.type === "system" && /compact/i.test(String(entry.subtype || ""))
  );
  return compactIndex >= 0 ? chain.slice(compactIndex) : chain;
}

function contentBlocks(entry) {
  const content = entry?.message?.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function blockText(block) {
  if (typeof block === "string") return block;
  if (typeof block?.text === "string") return block.text;
  if (typeof block?.content === "string") return block.content;
  if (Array.isArray(block?.content)) {
    return block.content.map((item) => blockText(item)).join("\n");
  }
  return block?.content === undefined ? "" : JSON.stringify(block.content);
}

function canonicalPath(value) {
  if (!value) return undefined;
  return path.normalize(String(value)).replaceAll("\\", "/").toLowerCase();
}

function categoryForTool(name = "") {
  if (name === "Read") return "Read tool results";
  if (/^(Bash|PowerShell)$/i.test(name)) return "Bash / test output";
  if (/^(WebSearch|WebFetch|Grep|Glob)$/i.test(name)) return "Search results";
  if (/^mcp__/i.test(name)) return "MCP tool results";
  if (/^(Task|Agent|Workflow)$/i.test(name)) return "Subagent output";
  return "Other tool results";
}

function usageOf(entry) {
  const usage = entry?.message?.usage;
  if (!usage) return undefined;
  return {
    input: Number(usage.input_tokens || 0),
    cacheRead: Number(usage.cache_read_input_tokens || 0),
    cacheCreation: Number(usage.cache_creation_input_tokens || 0),
    output: Number(usage.output_tokens || 0)
  };
}

function uniqueRequests(entries) {
  const requests = new Map();
  let fallback = 0;
  for (const entry of entries) {
    const usage = usageOf(entry);
    if (!usage || entry.isApiErrorMessage) continue;
    const key = entry.requestId || entry.message?.id || `fallback:${fallback++}`;
    if (!requests.has(key)) requests.set(key, { key, model: entry.message?.model, usage, entry });
  }
  return [...requests.values()];
}

function failedRequests(entries) {
  const failures = new Map();
  let fallback = 0;
  for (const entry of entries) {
    if (!entry.isApiErrorMessage) continue;
    const key = entry.requestId || entry.message?.id || `fallback:${fallback++}`;
    if (!failures.has(key)) {
      failures.set(key, {
        status: entry.apiErrorStatus ?? null,
        request_id_present: Boolean(entry.requestId)
      });
    }
  }
  return [...failures.values()];
}

export function analyzeTranscript(entries, malformed = [], options = {}) {
  const chain = options.scope === "all" ? entries : activeChain(entries);
  const toolUses = new Map();
  for (const entry of entries) {
    for (const block of contentBlocks(entry)) {
      if (block?.type === "tool_use" && block.id) toolUses.set(block.id, block);
    }
  }

  const categories = new Map();
  const reads = [];
  const add = (category, text) => {
    const tokens = estimateTokens(text);
    categories.set(category, (categories.get(category) || 0) + tokens);
    return tokens;
  };

  for (const entry of chain) {
    for (const block of contentBlocks(entry)) {
      if (block?.type === "text") {
        const category = entry.type === "assistant"
          ? "Assistant responses"
          : entry.isMeta
            ? "Other / Claude-managed"
            : "User prompts";
        add(category, block.text || "");
      } else if (block?.type === "tool_use") {
        add("Assistant responses", JSON.stringify(block));
      } else if (block?.type === "tool_result") {
        const tool = toolUses.get(block.tool_use_id);
        const text = blockText(block);
        const category = block.is_error ? "Errors / retries" : categoryForTool(tool?.name);
        const tokens = add(category, text);
        if (tool?.name === "Read") {
          reads.push({
            path: canonicalPath(tool.input?.file_path || tool.input?.path),
            offset: tool.input?.offset ?? 0,
            limit: tool.input?.limit ?? null,
            hash: crypto.createHash("sha256").update(text).digest("hex"),
            tokens
          });
        }
      }
    }
  }

  const repeated = [];
  const groups = new Map();
  for (const read of reads) {
    const key = `${read.path}|${read.offset}|${read.limit}|${read.hash}`;
    const group = groups.get(key) || [];
    group.push(read);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.length > 1) {
      repeated.push({
        path: group[0].path,
        occurrences: group.length,
        avoidable_tokens: group.slice(1).reduce((sum, read) => sum + read.tokens, 0),
        basis: "heuristic"
      });
    }
  }
  repeated.sort((a, b) => b.avoidable_tokens - a.avoidable_tokens);

  const requests = uniqueRequests(entries);
  const failures = failedRequests(entries);
  const lastRequest = uniqueRequests(chain).at(-1);
  const totals = requests.reduce((sum, request) => ({
    input: sum.input + request.usage.input,
    cacheRead: sum.cacheRead + request.usage.cacheRead,
    cacheCreation: sum.cacheCreation + request.usage.cacheCreation,
    output: sum.output + request.usage.output
  }), { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 });

  return {
    schema_version: 1,
    measurement_policy: {
      request_usage: "exact",
      category_tokens: "estimated",
      avoidability: "heuristic"
    },
    session: {
      requests: requests.length,
      failed_requests: {
        count: failures.length,
        statuses: [...new Set(failures.map((failure) => failure.status).filter((status) => status !== null))]
      },
      exact_totals: requests.length ? totals : null,
      processed_input: requests.length ? totals.input + totals.cacheRead + totals.cacheCreation : null
    },
    context: {
      active_entries: chain.length,
      last_request_exact: lastRequest?.usage || null,
      attributed_message_tokens: [...categories.values()].reduce((a, b) => a + b, 0),
      categories: Object.fromEntries([...categories.entries()].sort((a, b) => b[1] - a[1]))
    },
    repeated_reads: repeated,
    warnings: [
      ...(malformed.length ? [`Ignored ${malformed.length} malformed transcript line(s).`] : []),
      ...(failures.length
        ? [`Session contains ${failures.length} failed API request(s)${failures.some((failure) => failure.status === 429) ? "; status 429 means the usage limit or rate limit was reached" : ""}.`]
        : []),
      "Per-category values are estimates; Claude Code does not expose exact additive per-message token counts.",
      "Potential savings assume the task trajectory would remain unchanged."
    ]
  };
}
