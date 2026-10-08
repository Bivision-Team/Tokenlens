# Privacy model

TokenLens defaults to `store_content=false`.

Persisted hook records may contain session IDs, event names, safe project-relative paths, tool names, durations, byte/character counts, estimated token counts, and installation-keyed HMAC fingerprints.

They must not contain source text, prompts, assistant responses, tool output, raw MCP results, full shell commands, environment variables, authorization headers, or external absolute paths.

Absolute paths outside the working directory are replaced with keyed fingerprints. The active-session index stores only a session ID under a working-directory HMAC; it does not store the working directory or transcript path. HMAC keys are generated locally under `~/.tokenlens/key`.

Hook event files are retained for 30 days by default and pruned on `SessionStart`. Set `TOKENLENS_RETENTION_DAYS` to a positive whole-day retention period. Reports need hook metadata only to resolve agent types and the active session. If the hook spool has no agent type, TokenLens reads only the `agentType` field from Claude Code's adjacent `agent-<id>.meta.json`; it does not persist or report the metadata description.

Claude Code itself stores session transcripts independently. TokenLens reads those transcripts but does not copy their content into its event store or reports.
