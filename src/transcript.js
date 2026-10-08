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

export function findSubagentTranscripts(mainTranscript) {
  if (!mainTranscript || isSubagentTranscript(mainTranscript)) return [];
  const sessionId = path.basename(mainTranscript, ".jsonl");
  const root = path.join(path.dirname(mainTranscript), sessionId, "subagents");
  const files = [];
  walkFiles(root, ".jsonl", files);
  return files
    .filter((file) => isSubagentTranscript(file))
    .sort((a, b) => a.localeCompare(b));
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
  for (const [entryIndex, entry] of entries.entries()) {
    const usage = usageOf(entry);
    if (!usage || entry.isApiErrorMessage) continue;
    const key = entry.requestId || entry.message?.id || `fallback:${fallback++}`;
    if (!requests.has(key)) requests.set(key, { key, model: entry.message?.model, usage, entry, entryIndex });
  }
  return [...requests.values()];
}

function categoryForBlock(entry, block, toolUses) {
  if (block?.type === "text") {
    return entry.type === "assistant"
      ? "Assistant responses"
      : entry.isMeta
        ? "Other / Claude-managed"
        : "User prompts";
  }
  if (block?.type === "thinking" || block?.type === "redacted_thinking") return "Assistant responses";
  if (block?.type === "tool_use") return "Assistant responses";
  if (block?.type === "tool_result") {
    if (block.is_error) return "Errors / retries";
    return categoryForTool(toolUses.get(block.tool_use_id)?.name);
  }
  return undefined;
}

function textForBlock(block) {
  if (block?.type === "tool_use") return JSON.stringify(block);
  if (block?.type === "thinking") return block.thinking || block.text || "";
  if (block?.type === "redacted_thinking") return "";
  return blockText(block);
}

function keepsPriorThinking(model = "") {
  const value = String(model).toLowerCase();
  return /claude-(?:opus-(?:4-[5-9]|[5-9])|sonnet-(?:4-[6-9]|[5-9]))/.test(value);
}

function cumulativeLinear(entries, toolUses) {
  const requests = uniqueRequests(entries);
  if (!requests.length) return {
    categories: {}, message_tokens: 0, fixed_overhead: 0,
    fixed_overhead_method: "first_nonzero_request_floor_minus_visible",
    conversation_growth: 0, growth_residual: null, unattributed: null,
    growth_coverage_percent: null, baseline_per_request: null, segments: []
  };
  const requestByIndex = new Map(requests.map((request) => [request.entryIndex, request]));
  const active = new Map();
  const segments = [];
  let segment;
  const newSegment = () => {
    segment = { inputs: [], categories: new Map() };
    segments.push(segment);
  };
  for (const [entryIndex, entry] of entries.entries()) {
    if (entry.type === "system" && /compact/i.test(String(entry.subtype || ""))) {
      active.clear();
      segment = undefined;
    }
    if (requestByIndex.has(entryIndex)) {
      if (!segment) newSegment();
      const request = requestByIndex.get(entryIndex);
      let messages = 0;
      for (const [category, tokens] of active) {
        segment.categories.set(category, (segment.categories.get(category) || 0) + tokens);
        messages += tokens;
      }
      const input = request.usage.input + request.usage.cacheRead + request.usage.cacheCreation;
      segment.inputs.push({ input, visible_messages: messages });
      if (keepsPriorThinking(request.model)) {
        active.set("Assistant responses", (active.get("Assistant responses") || 0) + request.usage.output);
      }
    }
    const exactAssistantOutputUsed = entry.type === "assistant"
      && Boolean(usageOf(entry))
      && keepsPriorThinking(entry.message?.model);
    for (const block of contentBlocks(entry)) {
      const category = categoryForBlock(entry, block, toolUses);
      if (!category) continue;
      if (exactAssistantOutputUsed && category === "Assistant responses") continue;
      active.set(category, (active.get(category) || 0) + estimateTokens(textForBlock(block)));
    }
  }
  const finalized = segments.map((item, index) => {
    const first = item.inputs.find((value) => value.input > 0);
    const baseline = first ? Math.max(0, first.input - first.visible_messages) : 0;
    const processedInput = item.inputs.reduce((sum, value) => sum + value.input, 0);
    const fixedOverhead = item.inputs.reduce((sum, value) => sum + Math.min(value.input, baseline), 0);
    const conversationGrowth = item.inputs.reduce((sum, value) => sum + Math.max(0, value.input - baseline), 0);
    const messageTokens = [...item.categories.values()].reduce((sum, value) => sum + value, 0);
    const growthResidual = conversationGrowth - messageTokens;
    return {
      segment: index + 1,
      requests: item.inputs.length,
      processed_input: processedInput,
      baseline_per_request: baseline,
      baseline_visible_messages: first?.visible_messages ?? null,
      fixed_overhead: fixedOverhead,
      fixed_overhead_method: "first_nonzero_request_floor_minus_visible",
      conversation_growth: conversationGrowth,
      categories: Object.fromEntries([...item.categories.entries()].sort((a, b) => b[1] - a[1])),
      message_tokens: messageTokens,
      growth_residual: growthResidual,
      growth_coverage_percent: conversationGrowth
        ? Number(((messageTokens / conversationGrowth) * 100).toFixed(1))
        : null
    };
  });
  const categories = new Map();
  for (const item of finalized) {
    for (const [category, tokens] of Object.entries(item.categories)) {
      categories.set(category, (categories.get(category) || 0) + tokens);
    }
  }
  const fixedOverhead = finalized.reduce((sum, item) => sum + item.fixed_overhead, 0);
  const conversationGrowth = finalized.reduce((sum, item) => sum + item.conversation_growth, 0);
  const messageTokens = [...categories.values()].reduce((sum, value) => sum + value, 0);
  const growthResidual = conversationGrowth - messageTokens;

  return {
    categories: Object.fromEntries([...categories.entries()].sort((a, b) => b[1] - a[1])),
    message_tokens: messageTokens,
    fixed_overhead: fixedOverhead,
    fixed_overhead_method: "first_nonzero_request_floor_minus_visible",
    conversation_growth: conversationGrowth,
    growth_residual: growthResidual,
    unattributed: growthResidual,
    growth_coverage_percent: conversationGrowth
      ? Number(((messageTokens / conversationGrowth) * 100).toFixed(1))
      : null,
    baseline_per_request: finalized.length === 1 ? finalized[0].baseline_per_request : null,
    baseline_method: "first_nonzero_request_floor_minus_visible",
    assistant_output_basis: "exact_output_for_keep_all_thinking_models_otherwise_visible_estimate",
    segments: finalized
  };
}

function cumulativeAttribution(entries, toolUses, baselineScopeComplete = true) {
  const groups = new Map();
  const knownSessions = new Set(entries.map((entry) => entry.__tokenlensSessionId || entry.sessionId || entry.session_id).filter(Boolean));
  const knownActors = new Set(entries.map((entry) => entry.__tokenlensActorId || entry.agentId || entry.agent_id).filter(Boolean));
  const defaultSession = knownSessions.size === 1 ? [...knownSessions][0] : "single";
  const defaultActor = knownActors.size === 1 ? [...knownActors][0] : "main";
  for (const entry of entries) {
    const session = entry.__tokenlensSessionId || entry.sessionId || entry.session_id || defaultSession;
    const actor = entry.__tokenlensActorId || entry.agentId || entry.agent_id || defaultActor;
    const key = `${session}:${actor}`;
    const group = groups.get(key) || [];
    group.push(entry);
    groups.set(key, group);
  }
  const parts = [...groups.values()].map((group) => cumulativeLinear(group, toolUses));
  const categories = new Map();
  for (const part of parts) {
    for (const [name, tokens] of Object.entries(part.categories)) {
      categories.set(name, (categories.get(name) || 0) + tokens);
    }
  }
  const messageTokens = [...categories.values()].reduce((sum, value) => sum + value, 0);
  const fixedOverhead = parts.reduce((sum, part) => sum + part.fixed_overhead, 0);
  const conversationGrowth = parts.reduce((sum, part) => sum + part.conversation_growth, 0);
  const growthResidual = conversationGrowth - messageTokens;
  const segments = parts.flatMap((part, groupIndex) => part.segments.map((item) => ({
    ...item,
    transcript_group: groupIndex + 1
  })));
  return {
    categories: Object.fromEntries([...categories.entries()].sort((a, b) => b[1] - a[1])),
    message_tokens: messageTokens,
    fixed_overhead: fixedOverhead,
    fixed_overhead_method: "first_nonzero_request_floor_minus_visible",
    conversation_growth: conversationGrowth,
    growth_residual: growthResidual,
    unattributed: growthResidual,
    growth_coverage_percent: conversationGrowth
      ? Number(((messageTokens / conversationGrowth) * 100).toFixed(1))
      : null,
    baseline_per_request: segments.length === 1 ? segments[0].baseline_per_request : null,
    baseline_method: "first_nonzero_request_floor_minus_visible",
    assistant_output_basis: "exact_output_for_keep_all_thinking_models_otherwise_visible_estimate",
    baseline_scope_complete: baselineScopeComplete,
    transcript_groups: parts.length,
    segments
  };
}

export function apiEquivalent(exactTotals) {
  if (!exactTotals) return null;
  const weights = { input: 1, cacheRead: 0.1, cacheCreation: 1.25 };
  return {
    input_units: exactTotals.input * weights.input
      + exactTotals.cacheRead * weights.cacheRead
      + exactTotals.cacheCreation * weights.cacheCreation,
    weights,
    basis: "estimated_standard_5m_cache_api_multipliers",
    excludes_output: true
  };
}

export function recommendationsForReport(report) {
  const recommendations = [];
  const cumulative = report.context?.cumulative ?? report.totals?.cumulative;
  const fixedBaselineThreshold = 75_000;
  const maxBaseline = Math.max(0, ...(cumulative?.segments || []).map((item) => item.baseline_per_request || 0));
  if (cumulative?.baseline_scope_complete !== false && maxBaseline >= fixedBaselineThreshold) recommendations.push({
    rule: "fixed-overhead-high", severity: "high", threshold: ">=75k measured baseline/request",
    observed: maxBaseline,
    action: "Reduce always-loaded CLAUDE.md/rules, plugin descriptions, and MCP tool schemas; defer optional tools."
  });
  const bash = cumulative?.categories?.["Bash / test output"] || 0;
  const cumulativeMessages = cumulative?.message_tokens || 0;
  if (cumulativeMessages && bash / cumulativeMessages >= 0.3) recommendations.push({
    rule: "command-output-high", severity: "medium", threshold: ">=30% of cumulative messages",
    observed: Number(((bash / cumulativeMessages) * 100).toFixed(1)),
    action: "Use quiet test/build modes, save full logs to files, and return only failures plus a short summary."
  });
  const requests = report.session?.requests ?? report.totals?.requests ?? 0;
  if (requests >= 30) recommendations.push({
    rule: "request-count-high", severity: "medium", threshold: ">=30 requests",
    observed: requests,
    action: "Checkpoint completed work and continue the next phase in a fresh session or narrowly scoped subagent."
  });
  const last = report.context?.last_request_exact;
  const lastInput = last ? last.input + last.cacheRead + last.cacheCreation : null;
  if (lastInput !== null && lastInput >= 150_000) recommendations.push({
    rule: "active-context-high", severity: "high", threshold: ">=150k input tokens",
    observed: lastInput,
    action: "Run /compact at a safe checkpoint or start a fresh session with a concise handoff."
  });
  const repeatedCommand = (report.repeated_commands || []).find((item) => item.occurrences >= 3);
  if (repeatedCommand) recommendations.push({
    rule: "repeated-command-loop", severity: "high", threshold: ">=3 identical command invocations",
    observed: repeatedCommand.occurrences,
    action: `Stop the retry loop for ${repeatedCommand.tool}; inspect the first failure and change the approach before rerunning.`
  });
  return recommendations;
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
  const commandGroups = new Map();
  const add = (category, text) => {
    const tokens = estimateTokens(text);
    categories.set(category, (categories.get(category) || 0) + tokens);
    return tokens;
  };

  for (const entry of chain) {
    for (const block of contentBlocks(entry)) {
      const category = categoryForBlock(entry, block, toolUses);
      if (!category) continue;
      if (block?.type === "tool_use" && /^(Bash|PowerShell)$/i.test(block.name || "") && typeof block.input?.command === "string") {
        const commandFingerprint = fingerprint(block.input.command).slice(0, 16);
        const actor = entry.agentId || entry.agent_id || entry.sessionId || entry.session_id || "main";
        const key = `${actor}:${commandFingerprint}`;
        const current = commandGroups.get(key) || { tool: block.name, fingerprint: commandFingerprint, scope: String(actor), occurrences: 0 };
        current.occurrences += 1;
        commandGroups.set(key, current);
      }
      if (block?.type === "tool_result") {
        const tool = toolUses.get(block.tool_use_id);
        const text = blockText(block);
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
      } else add(category, textForBlock(block));
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
  const cumulative = cumulativeAttribution(entries, toolUses, options.baselineScopeComplete !== false);

  const report = {
    schema_version: 1,
    measurement_policy: {
      request_usage: "exact",
      category_tokens: "estimated",
      input_split: "derived_from_exact_usage_and_estimated_visible_messages",
      avoidability: "heuristic"
    },
    session: {
      requests: requests.length,
      failed_requests: {
        count: failures.length,
        statuses: [...new Set(failures.map((failure) => failure.status).filter((status) => status !== null))]
      },
      exact_totals: requests.length ? totals : null,
      processed_input: requests.length ? totals.input + totals.cacheRead + totals.cacheCreation : null,
      api_equivalent: requests.length ? apiEquivalent(totals) : null
    },
    context: {
      active_entries: chain.length,
      last_request_exact: lastRequest?.usage || null,
      attributed_message_tokens: [...categories.values()].reduce((a, b) => a + b, 0),
      categories: Object.fromEntries([...categories.entries()].sort((a, b) => b[1] - a[1])),
      cumulative
    },
    repeated_reads: repeated,
    repeated_commands: [...commandGroups.values()].filter((item) => item.occurrences >= 2).sort((a, b) => b.occurrences - a.occurrences),
    warnings: [
      ...(malformed.length ? [`Ignored ${malformed.length} malformed transcript line(s).`] : []),
      ...(failures.length
        ? [`Session contains ${failures.length} failed API request(s)${failures.some((failure) => failure.status === 429) ? "; status 429 means the usage limit or rate limit was reached" : ""}.`]
        : []),
      ...(cumulative.growth_coverage_percent !== null && cumulative.growth_coverage_percent < 70
        ? [`Growth coverage is ${cumulative.growth_coverage_percent.toFixed(1)}%; category-level conclusions are low confidence below 70%.`]
        : []),
      ...(cumulative.baseline_scope_complete === false
        ? ["The selected period begins inside one or more sessions; fixed-baseline recommendations are suppressed because segment starts are incomplete."]
        : []),
      "Unique and cumulative category values are estimates; Claude Code does not expose exact additive per-message token counts.",
      "The fixed-baseline/growth split reconciles exactly to recorded input, but its boundary is derived from exact first-request input minus estimated visible messages for each compaction segment.",
      "Potential savings assume the task trajectory would remain unchanged."
    ]
  };
  report.recommendations = recommendationsForReport(report);
  return report;
}

export function combineSessionTree(main, agents = []) {
  const members = [main, ...agents];
  const successful = members.filter((member) => member.report.session.exact_totals);
  const exactTotals = successful.length
    ? successful.reduce((sum, member) => {
        const usage = member.report.session.exact_totals;
        sum.input += usage.input;
        sum.cacheRead += usage.cacheRead;
        sum.cacheCreation += usage.cacheCreation;
        sum.output += usage.output;
        return sum;
      }, { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 })
    : null;

  const categories = new Map();
  const cumulativeCategories = new Map();
  for (const member of members) {
    for (const [name, tokens] of Object.entries(member.report.context.categories)) {
      categories.set(name, (categories.get(name) || 0) + tokens);
    }
    for (const [name, tokens] of Object.entries(member.report.context.cumulative.categories)) {
      cumulativeCategories.set(name, (cumulativeCategories.get(name) || 0) + tokens);
    }
  }

  const ranked = [...members].sort((a, b) =>
    (b.report.session.processed_input ?? -1) - (a.report.session.processed_input ?? -1)
  );
  const top = ranked[0];
  const processedInput = exactTotals
    ? exactTotals.input + exactTotals.cacheRead + exactTotals.cacheCreation
    : null;

  const cumulativeMessageTokens = [...cumulativeCategories.values()].reduce((sum, value) => sum + value, 0);
  const fixedOverhead = members.reduce((sum, member) => sum + member.report.context.cumulative.fixed_overhead, 0);
  const conversationGrowth = members.reduce((sum, member) => sum + member.report.context.cumulative.conversation_growth, 0);
  const growthResidual = conversationGrowth - cumulativeMessageTokens;
  const cumulativeSegments = members.flatMap((member) => member.report.context.cumulative.segments.map((segment) => ({
    ...segment,
    member_id: member.id,
    member_kind: member.kind,
    agent_type: member.agentType || null
  })));
  const repeatedCommands = new Map();
  for (const member of members) {
    for (const item of member.report.repeated_commands || []) {
      const key = `${member.id}:${item.tool}:${item.fingerprint}`;
      repeatedCommands.set(key, { ...item, scope: member.id });
    }
  }
  const report = {
    schema_version: 1,
    measurement_policy: main.report.measurement_policy,
    scope: {
      main_session_id: main.id,
      agent_count: agents.length,
      transcript_count: members.length
    },
    totals: {
      requests: members.reduce((sum, member) => sum + member.report.session.requests, 0),
      failed_requests: {
        count: members.reduce((sum, member) => sum + member.report.session.failed_requests.count, 0),
        statuses: [...new Set(members.flatMap((member) => member.report.session.failed_requests.statuses))]
      },
      exact_totals: exactTotals,
      processed_input: processedInput,
      api_equivalent: apiEquivalent(exactTotals),
      attributed_message_tokens: [...categories.values()].reduce((sum, value) => sum + value, 0),
      categories: Object.fromEntries([...categories.entries()].sort((a, b) => b[1] - a[1])),
      cumulative: {
        categories: Object.fromEntries([...cumulativeCategories.entries()].sort((a, b) => b[1] - a[1])),
        message_tokens: cumulativeMessageTokens,
        fixed_overhead: fixedOverhead,
        fixed_overhead_method: "first_nonzero_request_floor_minus_visible",
        conversation_growth: conversationGrowth,
        growth_residual: growthResidual,
        unattributed: growthResidual,
        growth_coverage_percent: conversationGrowth
          ? Number(((cumulativeMessageTokens / conversationGrowth) * 100).toFixed(1))
          : null,
        baseline_per_request: null,
        baseline_method: "first_nonzero_request_floor_minus_visible",
        baseline_scope_complete: members.every((member) => member.report.context.cumulative.baseline_scope_complete !== false),
        segments: cumulativeSegments
      }
    },
    main: sessionTreeMember(main, processedInput),
    agents: agents.map((agent) => sessionTreeMember(agent, processedInput)),
    repeated_commands: [...repeatedCommands.values()].sort((a, b) => b.occurrences - a.occurrences),
    top_consumer: top ? {
      kind: top.kind,
      id: top.id,
      agent_type: top.agentType || null,
      processed_input: top.report.session.processed_input,
      share_percent: sharePercent(top.report.session.processed_input, processedInput)
    } : null,
    warnings: [
      ...(members.reduce((sum, member) => sum + member.report.session.failed_requests.count, 0)
        ? [`Session tree contains ${members.reduce((sum, member) => sum + member.report.session.failed_requests.count, 0)} failed API request(s)${members.some((member) => member.report.session.failed_requests.statuses.includes(429)) ? "; status 429 means the usage limit or rate limit was reached" : ""}.`]
        : []),
      ...(conversationGrowth && (cumulativeMessageTokens / conversationGrowth) * 100 < 70
        ? [`Combined growth coverage is ${((cumulativeMessageTokens / conversationGrowth) * 100).toFixed(1)}%; category-level conclusions are low confidence below 70%.`]
        : []),
      ...new Set(members.flatMap((member) => member.report.warnings)
        .filter((warning) => !warning.startsWith("Session contains "))),
      "Combined usage sums the main transcript and its discovered subagent transcripts; returned subagent summaries are message content, not duplicate API usage.",
      "Claude Code transcripts do not expose nested parent-agent identity, so the displayed tree attaches discovered agents directly to the main session."
    ]
  };
  report.recommendations = recommendationsForReport(report);
  return report;
}

function sharePercent(value, total) {
  if (value === null || value === undefined || !total) return null;
  return Number(((value / total) * 100).toFixed(1));
}

function sessionTreeMember(member, totalProcessedInput) {
  const report = member.report;
  const last = report.context.last_request_exact;
  return {
    kind: member.kind,
    id: member.id,
    agent_type: member.agentType || null,
    source: member.source,
    usage: report.session,
    last_request_input: last ? last.input + last.cacheRead + last.cacheCreation : null,
    attributed_message_tokens: report.context.attributed_message_tokens,
    categories: report.context.categories,
    cumulative: report.context.cumulative,
    share_percent: sharePercent(report.session.processed_input, totalProcessedInput)
  };
}
