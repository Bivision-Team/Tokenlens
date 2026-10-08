# Accuracy contract

TokenLens uses four provenance labels:

- **exact**: copied from an API usage object recorded by Claude Code;
- **derived**: deterministic transformation of recorded structure;
- **estimated**: model-aware token approximation without an official local Claude tokenizer;
- **heuristic**: a judgment such as whether repeated content was avoidable.

Input processing is `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. Usage is deduplicated by request ID and then provider message ID because Claude Code can persist one response as multiple transcript entries.

Per-message estimates are not forced to sum to the exact API total. The difference can include system prompts, tool schemas, hidden reminders, framing overhead, provider transformations, and estimation error.

Cumulative attribution is calculated independently for every transcript and compaction segment. The baseline is the first non-zero recorded request input minus the estimated visible messages present at that request. Every request is then split with `min(input, baseline)` and `max(0, input - baseline)`, so measured fixed baseline plus conversation growth equals exact processed input and both remain non-negative. The reconciliation is exact arithmetic; the boundary is derived from an estimated visible-message count.

Growth categories estimate which recorded messages were exposed on later requests. On models that retain prior thinking, recorded output-token usage supplies the Assistant responses exposure because visible thinking summaries understate the context carried forward. `growth_coverage_percent` is estimated category exposure divided by conversation growth. The residual is always shown, may be negative, and is never reassigned to force 100% coverage. Values below 70% are labelled low confidence.

The `fixed-overhead-high` recommendation uses a 75,000-token absolute per-segment baseline threshold, not a share of total input. The threshold was placed above the observed maximum in a 19-session local calibration set (median 35,919; 90th percentile 65,876; maximum 66,536). This calibration is evidence for the sampled projects, not a universal population claim.

Period aggregates may begin inside an existing session and therefore lack the true first request of a compaction segment. They retain the decomposition for trend visibility, mark the baseline scope as incomplete, and suppress `fixed-overhead-high`. Full session and session-tree reports use complete transcript scope.

API-equivalent input is a normalized estimate, not a bill or subscription-limit measurement. It uses the standard Claude API 5-minute cache multipliers: fresh input 1x, cache creation 1.25x, and cache reads 0.1x. Model-specific cache-read exceptions and 1-hour cache writes require provider details that the transcript may not expose.

Removing content can change later model decisions, tool calls, cache behavior, and task success. Savings are therefore scenarios, not promises.
