---
description: Analyze the current Claude Code session's context and cumulative token usage
argument-hint: "[--include-agents] [--json]"
allowed-tools: Bash(node *tokenlens.js*)
---

Run the following command exactly once, then show its output verbatim. Do not summarize or reinterpret the measurements.

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/tokenlens.js" current $ARGUMENTS
```

If the command fails, show the error and suggest running `node "${CLAUDE_PLUGIN_ROOT}/bin/tokenlens.js" doctor`.
