# Changelog

## 0.1.7 — 2026-11-19

First public release.

- Drive pool, idle rumination and metacognition goals for `dsh-cortex`.
- Off by default (`enabled: false`): nothing is written and no LLM is called until enabled.
- Runs on the host scheduler via `cortex.onTick()`; only falls back to its own unref timer
  when the host has no tick hook.
- Writes only to its own `agency` scope, with `facts: []`, so thoughts are never recalled
  as user speech and never become facts.
- Never sends messages and never edits prompts.
- Neutral test fixtures (no personal names).

### Verified

- 23/23 unit tests.
