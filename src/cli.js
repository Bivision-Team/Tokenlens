import fs from "node:fs";
import path from "node:path";
import { findTranscript, findTranscriptCandidates, findAllMainTranscripts, findSubagentTranscripts, dedupeTranscriptEntries, parseJsonl, analyzeTranscript, combineSessionTree, apiEquivalent } from "./transcript.js";
import { renderReport, renderAggregateReport, renderSessionTreeReport, renderTeamReport } from "./report.js";
import { dataDir } from "./privacy.js";
import { readAgentTypes } from "./hook.js";

function help() {
  return `TokenLens v0.4.0

Usage:
  tokenlens current [--include-agents] [--json]
  tokenlens previous [--json]
  tokenlens aggregate [--since 30d|YYYY-MM-DD] [--include-agents] [--person NAME] [--project NAME] [--json]
  tokenlens team <aggregate.json...> [--json]
  tokenlens session <session-id|transcript-path> [--json]
  tokenlens doctor

Measurements are local. Content is not persisted by TokenLens.`;
}

async function analyze(query, json) {
  const transcript = findTranscript(query);
  if (!transcript) {
    throw new Error("No Claude Code transcript found. Start a Claude session with the TokenLens plugin enabled.");
  }
  const { entries, malformed } = await parseJsonl(transcript);
  const report = analyzeTranscript(entries, malformed);
  report.source = { transcript: path.basename(transcript), content_stored_by_tokenlens: false };
  console.log(json ? JSON.stringify(report, null, 2) : renderReport(report, path.basename(transcript)));
}

async function analyzeWithAgents(query, json) {
  const transcript = findTranscript(query);
  if (!transcript) {
    throw new Error("No Claude Code transcript found. Start a Claude session with the TokenLens plugin enabled.");
  }

  const parsedMain = await parseJsonl(transcript);
  const mainId = path.basename(transcript, ".jsonl");
  const agentTypes = readAgentTypes(mainId);
  const main = {
    kind: "main",
    id: mainId,
    source: path.basename(transcript),
    report: analyzeTranscript(parsedMain.entries, parsedMain.malformed)
  };
  const agents = [];
  for (const file of findSubagentTranscripts(transcript)) {
    const parsed = await parseJsonl(file);
    const id = parsed.entries.find((entry) => entry.agentId)?.agentId
      || path.basename(file, ".jsonl").replace(/^agent-/i, "");
    agents.push({
      kind: "agent",
      id,
      agentType: agentTypes.get(id) || "unknown",
      source: path.basename(file),
      report: analyzeTranscript(parsed.entries, parsed.malformed)
    });
  }

  const report = combineSessionTree(main, agents);
  report.source = { transcript: path.basename(transcript), content_stored_by_tokenlens: false };
  console.log(json ? JSON.stringify(report, null, 2) : renderSessionTreeReport(report));
}

async function analyzePrevious(json) {
  const current = findTranscript();
  for (const transcript of findTranscriptCandidates()) {
    if (transcript === current) continue;
    const { entries, malformed } = await parseJsonl(transcript);
    const report = analyzeTranscript(entries, malformed);
    if (report.session.requests > 0) {
      report.source = { transcript: path.basename(transcript), content_stored_by_tokenlens: false };
      console.log(json ? JSON.stringify(report, null, 2) : renderReport(report, path.basename(transcript)));
      return;
    }
  }
  throw new Error("No previous successful Claude Code session was found for this project.");
}

function parseSince(value = "30d") {
  const now = new Date();
  const days = /^(\d+)d$/i.exec(value);
  if (days) return new Date(now.getTime() - Number(days[1]) * 86_400_000);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid --since value: ${value}. Use 30d or YYYY-MM-DD.`);
  return parsed;
}

function optionValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : fallback;
}

function emptyUsage() {
  return { requests: 0, failed: 0, input: 0, cacheRead: 0, cacheCreation: 0, output: 0 };
}

function addReportUsage(target, report) {
  target.requests += report.session.requests;
  target.failed += report.session.failed_requests.count;
  const exact = report.session.exact_totals;
  if (exact) {
    target.input += exact.input;
    target.cacheRead += exact.cacheRead;
    target.cacheCreation += exact.cacheCreation;
    target.output += exact.output;
  }
}

function finalizeUsage(value) {
  const exact = { input: value.input, cacheRead: value.cacheRead, cacheCreation: value.cacheCreation, output: value.output };
  return {
    requests: value.requests,
    failed_requests: value.failed,
    exact_totals: exact,
    processed_input: exact.input + exact.cacheRead + exact.cacheCreation,
    api_equivalent: apiEquivalent(exact)
  };
}

async function analyzeAggregate(args, json) {
  const sinceIndex = args.indexOf("--since");
  const since = parseSince(sinceIndex >= 0 ? args[sinceIndex + 1] : "30d");
  const until = new Date();
  const eligibleFiles = findAllMainTranscripts().filter((file) => fs.statSync(file).mtimeMs >= since.getTime());
  const entries = [];
  const sessionIds = new Set();
  const includeAgents = args.includes("--include-agents");
  const agentUsage = new Map();
  let agentCount = 0;
  let agentTranscriptFilesScanned = 0;
  let malformedCount = 0;

  for (const file of eligibleFiles) {
    const parsed = await parseJsonl(file);
    malformedCount += parsed.malformed.length;
    const inPeriod = parsed.entries.filter((entry) => {
      const timestamp = Date.parse(entry.timestamp || "");
      return Number.isFinite(timestamp) && timestamp >= since.getTime() && timestamp <= until.getTime();
    });
    if (inPeriod.length) {
      sessionIds.add(inPeriod.find((entry) => entry.sessionId)?.sessionId || path.basename(file, ".jsonl"));
      entries.push(...inPeriod);
    }
    if (includeAgents) {
      const sessionId = path.basename(file, ".jsonl");
      const types = readAgentTypes(sessionId);
      for (const agentFile of findSubagentTranscripts(file)) {
        agentTranscriptFilesScanned += 1;
        const agentParsed = await parseJsonl(agentFile);
        malformedCount += agentParsed.malformed.length;
        const agentEntries = agentParsed.entries.filter((entry) => {
          const timestamp = Date.parse(entry.timestamp || "");
          return Number.isFinite(timestamp) && timestamp >= since.getTime() && timestamp <= until.getTime();
        });
        if (!agentEntries.length) continue;
        sessionIds.add(sessionId);
        agentCount += 1;
        entries.push(...agentEntries);
        const agentId = agentEntries.find((entry) => entry.agentId)?.agentId
          || path.basename(agentFile, ".jsonl").replace(/^agent-/i, "");
        const type = types.get(String(agentId)) || "unknown";
        const report = analyzeTranscript(agentEntries, agentParsed.malformed, { scope: "all" });
        const usage = agentUsage.get(type) || emptyUsage();
        addReportUsage(usage, report);
        agentUsage.set(type, usage);
      }
    }
  }

  const deduped = dedupeTranscriptEntries(entries);
  const base = analyzeTranscript(deduped, Array.from({ length: malformedCount }), { scope: "all" });
  const report = {
    schema_version: 1,
    measurement_policy: base.measurement_policy,
    period: { since: since.toISOString(), until: until.toISOString() },
    identity: {
      person: optionValue(args, "--person", process.env.USERNAME || process.env.USER || "unknown"),
      project: optionValue(args, "--project", path.basename(process.cwd()))
    },
    sessions: {
      count: sessionIds.size,
      agent_count: agentCount,
      transcript_files_scanned: eligibleFiles.length + agentTranscriptFilesScanned,
      includes_agents: includeAgents
    },
    usage: base.session,
    messages: {
      attributed_tokens: base.context.attributed_message_tokens,
      categories: base.context.categories,
      cumulative: base.context.cumulative
    },
    agents_by_type: Object.fromEntries([...agentUsage.entries()].map(([type, usage]) => [type, finalizeUsage(usage)])),
    recommendations: base.recommendations,
    repeated_reads: base.repeated_reads,
    repeated_commands: base.repeated_commands,
    warnings: [
      ...base.warnings,
      "Entries are included by their own timestamp; transcript modification time is used only as a scan optimization."
    ]
  };
  console.log(json ? JSON.stringify(report, null, 2) : renderAggregateReport(report));
}

function subtractUsage(total, parts) {
  const value = {
    requests: total.requests - parts.reduce((sum, part) => sum + part.requests, 0),
    failed_requests: (total.failed_requests?.count || 0) - parts.reduce((sum, part) => sum + (part.failed_requests || 0), 0),
    exact_totals: {}
  };
  for (const key of ["input", "cacheRead", "cacheCreation", "output"]) {
    value.exact_totals[key] = (total.exact_totals?.[key] || 0) - parts.reduce((sum, part) => sum + (part.exact_totals?.[key] || 0), 0);
  }
  value.processed_input = value.exact_totals.input + value.exact_totals.cacheRead + value.exact_totals.cacheCreation;
  value.api_equivalent = apiEquivalent(value.exact_totals);
  return value;
}

export function buildTeamReport(inputs) {
  const rows = [];
  for (const { report, source } of inputs) {
    if (!report.period || !report.usage) throw new Error(`${source} is not a TokenLens aggregate JSON report.`);
    const parts = Object.values(report.agents_by_type || {});
    rows.push({
      person: report.identity?.person || "unknown",
      project: report.identity?.project || path.basename(source, path.extname(source)),
      agent_type: "main",
      ...subtractUsage(report.usage, parts)
    });
    for (const [agentType, usage] of Object.entries(report.agents_by_type || {})) {
      rows.push({ person: report.identity?.person || "unknown", project: report.identity?.project || path.basename(source, path.extname(source)), agent_type: agentType, ...usage });
    }
  }
  return { schema_version: 1, reports: inputs.length, rows };
}

function analyzeTeam(args, json) {
  const files = args.filter((arg) => !arg.startsWith("--"));
  if (!files.length) throw new Error("Provide one or more aggregate --json files.");
  const inputs = files.map((file) => ({ source: file, report: JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) }));
  const report = buildTeamReport(inputs);
  console.log(json ? JSON.stringify(report, null, 2) : renderTeamReport(report));
}

function doctor() {
  const checks = {
    node: process.version,
    node_supported: Number(process.versions.node.split(".")[0]) >= 20,
    claude_transcript_root: fs.existsSync(path.join(process.env.USERPROFILE || process.env.HOME || "", ".claude", "projects")),
    tokenlens_data_dir: dataDir(),
    privacy_default: "store_content=false"
  };
  console.log(JSON.stringify(checks, null, 2));
  if (!checks.node_supported) process.exitCode = 1;
}

export async function main(args) {
  const command = args[0] || "help";
  const json = args.includes("--json");
  if (command === "current" && args.includes("--include-agents")) return analyzeWithAgents(undefined, json);
  if (command === "current") return analyze(undefined, json);
  if (command === "previous") return analyzePrevious(json);
  if (command === "aggregate") return analyzeAggregate(args.slice(1), json);
  if (command === "team") return analyzeTeam(args.slice(1), json);
  if (command === "session") return analyze(args.slice(1).find((arg) => !arg.startsWith("--")), json);
  if (command === "doctor") return doctor();
  console.log(help());
}
