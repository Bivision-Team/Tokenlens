function compact(value) {
  if (value === null || value === undefined) return "n/a";
  const number = Number(value);
  if (Math.abs(number) >= 1_000_000) return `${(number / 1_000_000).toFixed(2)}M`;
  if (Math.abs(number) >= 1_000) return `${(number / 1_000).toFixed(1)}k`;
  return String(number);
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

  lines.push("", "Repeated unchanged reads");
  if (!report.repeated_reads.length) lines.push("  None detected in the active context.");
  for (const item of report.repeated_reads.slice(0, 10)) {
    lines.push(`  ${item.path || "unknown"}  ${item.occurrences}x  ~${compact(item.avoidable_tokens)} candidate tokens`);
  }

  lines.push("", "Accuracy notes");
  for (const warning of report.warnings) lines.push(`  - ${warning}`);
  return lines.join("\n");
}
