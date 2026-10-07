# Architecture

```text
Claude hooks ───────┐
Session JSONL ──────┼─> correlation ─> attribution ─> terminal/JSON report
OTel import (later) ┘                         └──────> waste candidates
```

Four hooks (`SessionStart`, `UserPromptSubmit`, `SubagentStart`, and `SubagentStop`) create atomic spool files only for active-session correlation and agent-type metadata. Old event files are retention-pruned. The transcript is the source for conversation structure and API usage. Correlation uses session, prompt, request, message, tool-use, and agent identifiers where available.

The plugin is analysis-only in v0.1: it never blocks tools or rewrites outputs.
