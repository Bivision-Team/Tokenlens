function compact(value) {
  if (value === null || value === undefined) return "n/a";
  const number = Number(value);
  if (Math.abs(number) >= 1_000_000) return `${(number / 1_000_000).toFixed(2)}M`;
  if (Math.abs(number) >= 1_000) return `${(number / 1_000).toFixed(1)}k`;
  return String(number);
}

function pushApiEquivalent(lines, usage) {
  if (!usage?.api_equivalent) return;
  const item = usage.api_equivalent;
  lines.push(`API-equivalent input: ${compact(item.input_units)} units  [estimated; input×1, cache read×${item.weights.cacheRead}, cache creation×${item.weights.cacheCreation}]`);
}

function pushCumulative(lines, cumulative) {
  if (!cumulative) return;
  lines.push(
    "",
    "Cumulative input attribution  [estimated]",
    `  Message exposure:     ~${compact(cumulative.message_tokens)}`,
    `  Fixed overhead:       ~${compact(cumulative.fixed_overhead)}`,
    `  Explained:            ~${compact(cumulative.explained)}`,
    `  Unattributed:         ~${compact(cumulative.unattributed)}`,
    `  Coverage:              ${cumulative.coverage_percent === null ? "n/a" : `${cumulative.coverage_percent.toFixed(1)}%`}`
  );
  for (const [name, tokens] of Object.entries(cumulative.categories || {})) {
    lines.push(`    ${name.padEnd(22)} ~${compact(tokens)}`);
  }
}

function pushRecommendations(lines, recommendations = []) {
  lines.push("", "Actions");
  if (!recommendations.length) lines.push("  No threshold-based action triggered.");
  for (const item of recommendations) {
    lines.push(`  [${item.severity}] ${item.rule}: observed ${item.observed}; ${item.action}`);
  }
}

function pushRepeatedCommands(lines, items = []) {
  lines.push("", "Repeated command patterns");
  if (!items.length) lines.push("  None detected.");
  for (const item of items.slice(0, 10)) {
    lines.push(`  ${item.tool} ${item.fingerprint}  ${item.occurrences}x  scope=${item.scope || "current"}  [content hidden]`);
  }
}

export function renderReport(report, source) {
  const lines = [
    "Session Token Analysis",
    "",
    `Source: ${source}`,
    `Successful API requests: ${report.session.requests}`,
    `Failed API requests: ${report.session.failed_requests.count}${report.session.failed_requests.statuses.length ? `  (status: ${report.session.failed_requests.statuses.join(", ")})` : ""}`,
    report.session.exact_totals
      ? `Total processed input: ${compact(report.session.processed_input)}  [exact]`
      : "Total processed input: unavailable  [no successful usage record]",
    "",
    "Current context snapshot",
  ];

  if (report.session.exact_totals) {
    lines.splice(6, 0,
      `  Fresh input:       ${compact(report.session.exact_totals.input)}`,
      `  Cache reads:       ${compact(report.session.exact_totals.cacheRead)}`,
      `  Cache creation:    ${compact(report.session.exact_totals.cacheCreation)}`,
      `  Model output:      ${compact(report.session.exact_totals.output)}`
    );
  }
  pushApiEquivalent(lines, report.session);

  const last = report.context.last_request_exact;
  if (last) {
    lines.push(`Last request input: ${compact(last.input + last.cacheRead + last.cacheCreation)}  [exact]`);
  } else {
    lines.push("Last request input: unavailable");
  }
  lines.push(`Attributed messages: ~${compact(report.context.attributed_message_tokens)}  [estimated]`);
  for (const [name, tokens] of Object.entries(report.context.categories)) {
    lines.push(`  ${name.padEnd(24)} ~${compact(tokens)}`);
  }
  pushCumulative(lines, report.context.cumulative);

  lines.push("", "Repeated unchanged reads");
  if (!report.repeated_reads.length) lines.push("  None detected in the active context.");
  for (const item of report.repeated_reads.slice(0, 10)) {
    lines.push(`  ${item.path || "unknown"}  ${item.occurrences}x  ~${compact(item.avoidable_tokens)} candidate tokens`);
  }
  pushRepeatedCommands(lines, report.repeated_commands);
  pushRecommendations(lines, report.recommendations);

  lines.push("", "Accuracy notes");
  for (const warning of report.warnings) lines.push(`  - ${warning}`);
  return lines.join("\n");
}

export function renderAggregateReport(report) {
  const lines = [
    "TokenLens Period Analysis",
    "",
    `Period: ${report.period.since} → ${report.period.until}`,
    `Identity: ${report.identity?.person || "unknown"} / ${report.identity?.project || "unknown"}`,
    `Main sessions: ${report.sessions.count}`,
    `Subagents: ${report.sessions.agent_count || 0}${report.sessions.includes_agents ? "  [included]" : "  [excluded; use --include-agents]"}`,
    `Successful API requests: ${report.usage.requests}`,
    `Failed API requests: ${report.usage.failed_requests.count}${report.usage.failed_requests.statuses.length ? `  (status: ${report.usage.failed_requests.statuses.join(", ")})` : ""}`,
    report.usage.exact_totals
      ? `Total processed input: ${compact(report.usage.processed_input)}  [exact]`
      : "Total processed input: unavailable  [no successful usage record]"
  ];

  if (report.usage.exact_totals) {
    lines.push(
      `  Fresh input:       ${compact(report.usage.exact_totals.input)}`,
      `  Cache reads:       ${compact(report.usage.exact_totals.cacheRead)}`,
      `  Cache creation:    ${compact(report.usage.exact_totals.cacheCreation)}`,
      `  Model output:      ${compact(report.usage.exact_totals.output)}`
    );
  }
  pushApiEquivalent(lines, report.usage);

  lines.push("", `Unique attributed message content: ~${compact(report.messages.attributed_tokens)}  [estimated]`);
  for (const [name, tokens] of Object.entries(report.messages.categories)) {
    lines.push(`  ${name.padEnd(24)} ~${compact(tokens)}`);
  }
  pushCumulative(lines, report.messages.cumulative);

  if (Object.keys(report.agents_by_type || {}).length) {
    lines.push("", "Subagent usage by type");
    for (const [type, usage] of Object.entries(report.agents_by_type)) {
      lines.push(`  ${type.padEnd(24)} ${usage.requests} requests  ${compact(usage.processed_input)} processed`);
    }
  }

  lines.push("", "Repeated unchanged reads across the period");
  if (!report.repeated_reads.length) lines.push("  None detected.");
  for (const item of report.repeated_reads.slice(0, 10)) {
    lines.push(`  ${item.path || "unknown"}  ${item.occurrences}x  ~${compact(item.avoidable_tokens)} candidate tokens`);
  }
  pushRepeatedCommands(lines, report.repeated_commands);
  pushRecommendations(lines, report.recommendations);

  lines.push("", "Accuracy notes");
  for (const warning of report.warnings) lines.push(`  - ${warning}`);
  return lines.join("\n");
}

export function renderSessionTreeReport(report) {
  const usage = report.totals;
  const lines = [
    "TokenLens Session Tree Analysis",
    "",
    `Main session: ${report.scope.main_session_id}`,
    `Subagents: ${report.scope.agent_count}`,
    `Transcripts: ${report.scope.transcript_count}`,
    `Successful API requests: ${usage.requests}`,
    `Failed API requests: ${usage.failed_requests.count}${usage.failed_requests.statuses.length ? `  (status: ${usage.failed_requests.statuses.join(", ")})` : ""}`,
    usage.exact_totals
      ? `Combined processed input: ${compact(usage.processed_input)}  [exact]`
      : "Combined processed input: unavailable  [no successful usage record]"
  ];

  if (usage.exact_totals) {
    lines.push(
      `  Fresh input:       ${compact(usage.exact_totals.input)}`,
      `  Cache reads:       ${compact(usage.exact_totals.cacheRead)}`,
      `  Cache creation:    ${compact(usage.exact_totals.cacheCreation)}`,
      `  Model output:      ${compact(usage.exact_totals.output)}`
    );
  }
  pushApiEquivalent(lines, usage);

  lines.push("", `Combined attributed messages: ~${compact(usage.attributed_message_tokens)}  [estimated]`);
  for (const [name, tokens] of Object.entries(usage.categories)) {
    lines.push(`  ${name.padEnd(24)} ~${compact(tokens)}`);
  }
  pushCumulative(lines, usage.cumulative);

  lines.push("", "Usage breakdown");
  for (const member of [report.main, ...report.agents]) {
    const label = member.kind === "main" ? "main " : "agent";
    const type = member.kind === "agent" ? ` (${member.agent_type || "unknown"})` : "";
    const share = member.share_percent === null ? "n/a" : `${member.share_percent.toFixed(1)}%`;
    lines.push(
      `  ${label} ${member.id}${type}  ${member.usage.requests} requests  ${compact(member.usage.processed_input)} processed  ${share}`,
      `       last request ${compact(member.last_request_input)}  attributed ~${compact(member.attributed_message_tokens)}`
    );
  }

  if (report.top_consumer) {
    const topShare = report.top_consumer.share_percent === null ? "n/a" : `${report.top_consumer.share_percent.toFixed(1)}%`;
    lines.push(
      "",
      `Largest consumer: ${report.top_consumer.kind} ${report.top_consumer.id}${report.top_consumer.agent_type ? ` (${report.top_consumer.agent_type})` : ""}  ${compact(report.top_consumer.processed_input)}  (${topShare})`
    );
  }

  lines.push("", "Session tree", `  ${report.main.id}  [main]`);
  report.agents.forEach((agent, index) => {
    lines.push(`  ${index === report.agents.length - 1 ? "└─" : "├─"} ${agent.id}  [agent: ${agent.agent_type || "unknown"}]`);
  });
  if (!report.agents.length) lines.push("  └─ No subagent transcripts found");

  pushRepeatedCommands(lines, report.repeated_commands);
  pushRecommendations(lines, report.recommendations);

  lines.push("", "Accuracy notes");
  for (const warning of report.warnings) lines.push(`  - ${warning}`);
  return lines.join("\n");
}

export function renderTeamReport(report) {
  const lines = ["TokenLens Team Analysis", "", `Reports: ${report.reports}`, "", "Person | Project | Agent | Requests | Processed input | API-equivalent"];
  for (const row of report.rows) {
    lines.push(`${row.person} | ${row.project} | ${row.agent_type} | ${row.requests} | ${compact(row.processed_input)} | ${compact(row.api_equivalent?.input_units)}`);
  }
  return lines.join("\n");
}
