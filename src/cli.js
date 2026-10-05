import fs from "node:fs";
import path from "node:path";
import { findTranscript, findTranscriptCandidates, parseJsonl, analyzeTranscript } from "./transcript.js";
import { renderReport } from "./report.js";
import { dataDir } from "./privacy.js";

function help() {
  return `TokenLens v0.1.0

Usage:
  tokenlens current [--json]
  tokenlens previous [--json]
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
  if (command === "current") return analyze(undefined, json);
  if (command === "previous") return analyzePrevious(json);
  if (command === "session") return analyze(args.slice(1).find((arg) => !arg.startsWith("--")), json);
  if (command === "doctor") return doctor();
  console.log(help());
}
