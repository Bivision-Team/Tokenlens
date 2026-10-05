# TokenLens

TokenLens explains what occupies the **Messages** portion of a Claude Code session and what drove cumulative token processing.

The v0.1 MVP is local-first, analysis-only, and stores no source code, prompts, assistant text, shell commands, or tool output by default.

## Try it now

For development or an immediate local trial, clone the repository and start Claude Code with the plugin directory:

```sh
claude --plugin-dir /absolute/path/to/Tokenlens
```

Inside Claude Code:

```text
/tokenlens:report
```

After the first version is pushed to GitHub, install it persistently through its marketplace:

```sh
claude plugin marketplace add Bivision-Team/Tokenlens
claude plugin install tokenlens@tokenlens
```

Restart Claude Code after installation, then run `/tokenlens:report`. Claude Code namespaces plugin commands as `<plugin>:<command>` to avoid collisions.

For the least intrusive report, run the CLI directly from another terminal:

```sh
node /absolute/path/to/Tokenlens/bin/tokenlens.js current
```

Include every subagent transcript spawned by the current session, with combined
exact usage, per-agent breakdown, the largest consumer, and a session tree:

```sh
node /absolute/path/to/Tokenlens/bin/tokenlens.js current --include-agents
node /absolute/path/to/Tokenlens/bin/tokenlens.js current --include-agents --json
```

The normal `current` report counts only the main transcript. Its `Subagent
output` category measures the summary returned to the main session, not the
subagent's internal API usage. Use `--include-agents` for the complete cost.

If the current session only contains a failed request (for example, a usage-limit `429`), analyze the previous successful session:

```sh
node /absolute/path/to/Tokenlens/bin/tokenlens.js previous
```

`current` and `previous` select main-session transcripts only. To inspect a subagent intentionally, pass its transcript path or agent ID to `session`.

Invoking `/tokenlens:report` itself creates a small Claude turn. The standalone CLI does not.

Analyze a specific transcript or session ID:

```sh
node bin/tokenlens.js session ~/.claude/projects/.../session.jsonl
node bin/tokenlens.js session <session-id> --json
```

Analyze every main session from the last 30 days with cross-session deduplication:

```sh
node bin/tokenlens.js aggregate --since 30d
node bin/tokenlens.js aggregate --since 30d --json
```

You can also use an explicit start date, for example `--since 2026-09-01`.

Check the installation:

```sh
node bin/tokenlens.js doctor
claude plugin validate --strict .
```

## What the report means

- API request input, output, cache-read, and cache-creation totals come from Claude Code transcript usage and are marked **exact**.
- Message-category and per-file values are local estimates. Claude Code does not expose exact additive token counts for each message component.
- Repeated-read savings are heuristic counterfactuals, not guaranteed savings.
- Reported costs, when added, will be API-equivalent estimates and may not equal subscription charges or provider invoices.

## Privacy

Hook payloads may contain sensitive content. TokenLens measures that content transiently, creates an installation-keyed HMAC, and persists only sizes, estimates, safe structural metadata, and fingerprints under `~/.tokenlens`.

Default behavior is equivalent to:

```text
store_content=false
```

See [docs/privacy.md](docs/privacy.md) and [docs/accuracy.md](docs/accuracy.md).

## Current scope

v0.3 supports current-context category estimates, exact cumulative request totals, cache breakdown, branch-aware transcript analysis, optional main-plus-subagent session-tree totals, repeated unchanged read detection, period aggregation, terminal output, and JSON output.

Live OTLP ingestion, provider billing reconciliation, and behavior-changing optimizations are intentionally outside this first milestone.
