import fs from "node:fs";
import path from "node:path";
import { findTranscript, findTranscriptCandidates, findAllMainTranscripts, findSubagentTranscripts, dedupeTranscriptEntries, parseJsonl, analyzeTranscript, combineSessionTree } from "./transcript.js";
import { renderReport, renderAggregateReport, renderSessionTreeReport } from "./report.js";
import { dataDir } from "./privacy.js";

function help() {
  return `TokenLens v0.3.0

Usage:
  tokenlens current [--include-agents] [--json]
  tokenlens previous [--json]
  tokenlens aggregate [--since 30d|YYYY-MM-DD] [--json]
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

async function analyzeAggregate(args, json) {
  const sinceIndex = args.indexOf("--since");
  const since = parseSince(sinceIndex >= 0 ? args[sinceIndex + 1] : "30d");
  const until = new Date();
  const eligibleFiles = findAllMainTranscripts().filter((file) => fs.statSync(file).mtimeMs >= since.getTime());
  const entries = [];
  const sessionIds = new Set();
  let malformedCount = 0;

  for (const file of eligibleFiles) {
    const parsed = await parseJsonl(file);
    malformedCount += parsed.malformed.length;
    const inPeriod = parsed.entries.filter((entry) => {
      const timestamp = Date.parse(entry.timestamp || "");
      return Number.isFinite(timestamp) && timestamp >= since.getTime() && timestamp <= until.getTime();
    });
    if (!inPeriod.length) continue;
    sessionIds.add(inPeriod.find((entry) => entry.sessionId)?.sessionId || path.basename(file, ".jsonl"));
    entries.push(...inPeriod);
  }

  const deduped = dedupeTranscriptEntries(entries);
  const base = analyzeTranscript(deduped, Array.from({ length: malformedCount }), { scope: "all" });
  const report = {
    schema_version: 1,
    measurement_policy: base.measurement_policy,
    period: { since: since.toISOString(), until: until.toISOString() },
    sessions: { count: sessionIds.size, transcript_files_scanned: eligibleFiles.length },
    usage: base.session,
    messages: {
      attributed_tokens: base.context.attributed_message_tokens,
      categories: base.context.categories
    },
    repeated_reads: base.repeated_reads,
    warnings: [
      ...base.warnings,
      "Aggregate categories count unique recorded content, not cumulative context exposure across requests.",
      "Entries are included by their own timestamp; transcript modification time is used only as a scan optimization."
    ]
  };
  console.log(json ? JSON.stringify(report, null, 2) : renderAggregateReport(report));
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
  if (command === "session") return analyze(args.slice(1).find((arg) => !arg.startsWith("--")), json);
  if (command === "doctor") return doctor();
  console.log(help());
}
