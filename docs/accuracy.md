# Accuracy contract

TokenLens uses four provenance labels:

- **exact**: copied from an API usage object recorded by Claude Code;
- **derived**: deterministic transformation of recorded structure;
- **estimated**: model-aware token approximation without an official local Claude tokenizer;
- **heuristic**: a judgment such as whether repeated content was avoidable.

Input processing is `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. Usage is deduplicated by request ID and then provider message ID because Claude Code can persist one response as multiple transcript entries.

Per-message estimates are not forced to sum to the exact API total. The difference can include system prompts, tool schemas, hidden reminders, framing overhead, provider transformations, and estimation error.

Removing content can change later model decisions, tool calls, cache behavior, and task success. Savings are therefore scenarios, not promises.
