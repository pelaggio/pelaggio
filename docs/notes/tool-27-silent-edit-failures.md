# TOOL-27 — Silent Edit failures on `.claude/skills/*` under bypassPermissions

## Summary

The claude-agent-sdk (v2.1.113, native binary) hardcodes a permission deny for
`Edit`/`Write` on paths matching `.claude/skills/**`. That deny **survives
both** `permissionMode: "bypassPermissions"` and
`allowDangerouslySkipPermissions: true`. The only way past it is a
`canUseTool` callback that explicitly returns `behavior: "allow"`.

In TOOL-3's pelaggio cycle this presented as a silent failure:

- `implement` step's `toolCounts` showed 5 `Edit` + 2 `Write` calls against
  `.claude/skills/charter/SKILL.md`.
- The TUI rendered many "Editing .claude/skills/charter/SKILL.md" lines.
- The post-step wip commit contained **zero** changes to that file.
- The model's final turn read "No other files change (plan scope is skill-body
  only). Waiting on your approval." — the model interpreted the rejection as a
  benign "waiting for user" state rather than retrying or escalating.
- `shakedown-code` flagged REVISE, `ship` correctly refused, and `shipwreck`
  surfaced the root cause with "please allow edits to `.claude/skills/` files".

## Reproduction

`.dev/tool-27-repro.ts` plants two fixtures in a temp dir
(`.claude/skills/xtest/SKILL.md` and `docs/x.md`), asks the SDK to edit both,
and prints every `tool_result` with `is_error`.

| Flag | Observed deny on SKILL.md? | Observed deny on docs/x.md? |
|------|:---:|:---:|
| `permissionMode: "bypassPermissions"` alone | yes | no |
| `permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions: true` | yes | no |
| `canUseTool: () => ({ behavior: "allow" })` | **no** | no |

The deny message from the SDK:

```
Claude requested permissions to write to /tmp/tool-27-*/.claude/skills/xtest/SKILL.md,
but you haven't granted it yet.
```

Hooks (`PreToolUse`) continue to fire normally under `canUseTool` — verified by
a hook that blocks `docs/x.md`; the skill edit succeeded and the doc edit was
blocked, confirming both layers run in series.

## Fix

`scripts/pelaggio/step-runner.ts` swaps `permissionMode: "bypassPermissions"`
for a `canUseTool` allow-all callback. The plan-polish and worktree-isolation
PreToolUse hooks are unchanged and still the authoritative guardrails; the
permission layer is now just "yes" for everything the hooks don't block.

## Telemetry gap (separate item)

`StepResult.outputTail` captures only the final assistant message. Per-tool
errors (`tool_result.is_error: true`) are emitted to the TUI but not retained
in the JSONL log. That's why TOOL-3's log showed `"ok": true` with no signal
of the denies. Surfacing a `toolErrors` array on `StepResult` would have made
this root cause obvious from the log alone — worth doing separately if it
happens again.

## What this means for consumer repos

If a consumer wants pelaggio to edit skill files (e.g. sync'd copies of
`.claude/skills/plan/SKILL.md` during a skill-body refactor cycle), they need
the canUseTool-based variant of `step-runner`. The fix shipped here is
universal — every cycle's step gets the allow-all callback — so consumers
inherit it automatically via the git-dep.
