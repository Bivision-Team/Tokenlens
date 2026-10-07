# Accuracy contract

TokenLens uses four provenance labels:

- **exact**: copied from an API usage object recorded by Claude Code;
- **derived**: deterministic transformation of recorded structure;
- **estimated**: model-aware token approximation without an official local Claude tokenizer;
- **heuristic**: a judgment such as whether repeated content was avoidable.

Input processing is `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. Usage is deduplicated by request ID and then provider message ID because Claude Code can persist one response as multiple transcript entries.

Per-message estimates are not forced to sum to the exact API total. The difference can include system prompts, tool schemas, hidden reminders, framing overhead, provider transformations, and estimation error.

Cumulative attribution multiplies each recorded content block by the number of later successful requests before a recorded compaction boundary. Fixed overhead uses the median per-request gap between exact input and estimated visible messages, making it resistant to one unusually small or large request while still allowing the final coverage to disagree with the exact total. Both are estimates. Reports always show coverage and the unattributed remainder, including negative values, rather than forcing categories to reconcile.

API-equivalent input is a normalized estimate, not a bill or subscription-limit measurement. It uses the standard Claude API 5-minute cache multipliers: fresh input 1x, cache creation 1.25x, and cache reads 0.1x. Model-specific cache-read exceptions and 1-hour cache writes require provider details that the transcript may not expose.

Removing content can change later model decisions, tool calls, cache behavior, and task success. Savings are therefore scenarios, not promises.
