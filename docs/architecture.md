# Architecture

```text
Claude hooks ───────┐
Session JSONL ──────┼─> correlation ─> attribution ─> terminal/JSON report
OTel import (later) ┘                         └──────> waste candidates
```

Hooks create one atomic spool file per event to avoid concurrent writers from the main session and subagents. The transcript is the source for conversation structure and API usage. Correlation uses session, prompt, request, message, tool-use, and agent identifiers where available.

The plugin is analysis-only in v0.1: it never blocks tools or rewrites outputs.
