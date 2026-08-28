---
name: charter
description: Charter a new work item — normalize intent, define scope, dependencies, and destination roadmap
argument-hint: "<description> [--to <roadmap>] [--create] [--prefix <PFX>] [--format checkbox|table] [--scope XS|S|M|L|XL] [--after <id>] [--priority high|normal]"
allowed-tools: Read Glob Grep Bash(npx:*)
---

# /charter — Charter a Work Item

A ship's charter is its mission document — what the voyage is trying to accomplish, what constrains it, and what evidence will show progress. `/charter` defines a new work item so `/pick` can claim it and pelaggio can execute it.

The raw request is attributable source material, not automatically a normalized charter. Before creating the item, cheaply test whether the request has fused a desired outcome to one proposed mechanism. Preserve the raw request even when normalization changes the charter wording.

## Context

All item creation goes through `npx pelaggio roadmap create-item`. The CLI dispatches to the configured adapter (markdown writes a roadmap row + task-index entry; github-issues opens a labeled issue; linear creates a team issue).

Parse `$ARGUMENTS` — the full text is the raw request. Extract flags if present:
- `--to <roadmap>` — target roadmap (partial match for markdown; ignored by gh/linear).
- `--create` — markdown-only: if `--to <roadmap>` has no existing match, create `docs/roadmap-<roadmap>.md`.
- `--prefix <PFX>` — markdown-only: explicit item ID prefix, letters only, e.g. `INST`.
- `--format checkbox|table` — markdown-only: explicit roadmap row format, bypassing adapter inference.
- `--scope XS|S|M|L|XL` — estimated scope. Default: infer from the normalized charter (see "Scope inference" below).
- `--after <id>` — insert after this item ID (markdown-only; ignored elsewhere).
- `--priority high|normal` — priority hint.
- `--bug` — shorthand: prefix title with "Fix:", scope S, mark as a bug-fix item.

## Normalize intent before planning

This is an intake falsification pass, not a design review and not permission to overwrite what the requester said.

First decompose the raw request into whatever is actually present:
- **desired outcome** — the state the requester appears to want;
- **constraints** — requirements that remain binding across acceptable solutions;
- **mechanism hypotheses** — requested or suggested ways to achieve the outcome;
- **acceptance/evidence** — observations that would demonstrate success or failure;
- **assumptions** — premises the request relies on;
- **residuals** — material ambiguity that cannot be resolved from the request and repository context.

Then attack intent/solution coupling with four cheap probes:
1. **Mechanism substitution:** if the requested mechanism vanished tomorrow, what outcome would still be wanted?
2. **False success:** can the requested deliverable be completed exactly as stated while the apparent desired outcome still fails?
3. **Alternative success:** can the apparent desired outcome be satisfied without the requested mechanism?
4. **Boundary counterexample:** what plausible edge condition defeats the obvious interpretation?

The primary early-exit question is: **Can the requested deliverable be completed exactly as stated while the apparent desired outcome still fails?**

If confidently **no**, and there is no material outcome/mechanism confusion, do not manufacture a normalization essay. Preserve the request as-is apart from ordinary concise charter editing.

If **yes or uncertain**, write the smallest outcome statement that survives the probes. Keep requested mechanisms as hypotheses or explicit constraints only when the requester actually requires that mechanism independent of the outcome. Preserve meaningful acceptance details and constraints; normalization must not make the charter vaguer.

Do not invent a new product objective merely because no existing purpose is obvious. A normalized outcome does not automatically become a durable Goal. If repository assurance semantics are available, prefer resolving against existing propositions, decisions, realizations, or admitted goals; otherwise keep the local charter self-contained.

### Human-mediated invocation

When a human is directly invoking `/charter`, use interaction only when it can change the admitted intent:

- **Silent pass-through:** if the request is already bounded and survives the probes, create it without asking for confirmation.
- **Propose-and-confirm:** if normalization materially strips or demotes an explicitly requested mechanism, show one concise proposed outcome, name the mechanism being treated as a hypothesis, and give the strongest counterexample. Ask at most one focused question before creation, e.g. whether the mechanism itself is a hard requirement or merely a suggested solution.
- **Human-value / authority residual:** if the unresolved point is a product-value choice, negotiability/scope choice, new durable objective, or authority/policy choice that repository context cannot settle, do not silently choose it. Surface the residual and ask the human for the missing judgment before creating the item.

A correction from the human supersedes the model's interpretation but does not erase the original request; preserve both in the charter when the distinction is material.

### Agent-mediated invocation

When `/charter` is invoked by an agent, harness, or other non-interactive caller that cannot answer a clarification turn:

- run the same normalization probes;
- never turn interpretation confidence into authority;
- if the work is safely charterable, preserve any unresolved interpretation explicitly under `Residuals` and continue with the narrowest non-invented charter;
- if proceeding would require choosing a new product objective, relaxing a governing constraint, or making a human-value/authority decision, do **not** fabricate that choice. Return the proposed normalization + residual instead of creating an executable item.

The semantic result should be portable across callers: human and agent-mediated paths differ in who may resolve a residual, not in what the normalization means.

## Charter body

For adapters that preserve a description/body, prefer this compact shape when normalization is material:

```markdown
## Outcome
<smallest desired outcome that survived counterexamples>

## Constraints
- <binding constraint, if any>

## Acceptance evidence
- <observable evidence, if known>

## Mechanism hypotheses
- <requested/suggested mechanism that is not itself the outcome>

## Residuals
- <unresolved material ambiguity, if any>

## Raw request
<verbatim request after charter flags are removed>
```

Omit empty sections. If there was no material normalization delta, do not wrap a simple request in ceremonial sections merely for consistency.

The normalized body is the operative work-item description for planning; `Raw request` remains attributable source context. Neither the model's normalization nor a mechanism hypothesis gains architectural authority merely by appearing earlier in the pipeline.

## Scope inference

If `--scope` was supplied, use it verbatim and skip this section. If `--bug` was supplied, scope is **S** — skip inference. Otherwise run the heuristic below against the **normalized charter**, not mechanism-heavy raw wording (case-insensitive, word-boundary matches — `\bfix\b` not bare `fix`).

Scan ranks top-down; **first match wins**. Broadest-first so "migrate and rename" correctly infers XL, not XS.

| Rank | Scope | Trigger keywords (any match, word-boundary) | Rationale phrase |
|------|-------|---------------------------------------------|------------------|
| 1 | XL | `migration`, `migrate`, `rewrite`, `schema change`, `re-architect` | migration / rewrite / schema change |
| 2 | L  | `new system`, `new engine`, `new pipeline`, `new framework` | new system / engine |
| 3 | M  | `new screen`, `new page`, `new component`, `new hook`, `new adapter`, `new command` | new screen / component / adapter |
| 4 | S  | `add`, `one file`, `small`, `extract`, `wire up` | add X / single-file change |
| 5 | XS | `fix`, `typo`, `rename`, `tweak`, `bump` | fix / typo / rename |
| — | M  | (no keyword matched) | default — no keyword matched |

Default on no match is **M**, not S. S routes through `isQuickScope` straight to `/implement`, skipping planning — too risky for an ambiguous description. Over-scoping to M adds a plan step; under-scoping to S skips one.

Remember the chosen scope and its rationale phrase for the Report step below.

## Create the item

Build the argument list from the parsed flags and call the adapter:

```bash
npx pelaggio roadmap create-item \
  --title "<concise imperative title derived from normalized intent>" \
  --description "<normalized charter body, preserving raw request when material>" \
  [--scope <XS|S|M|L|XL>] \
  [--to <roadmap>] \
  [--create] \
  [--prefix <PFX>] \
  [--format checkbox|table] \
  [--after <id>] \
  [--priority high|normal] \
  [--deps "<csv of existing IDs>"] \
  --json
```

The CLI prints JSON with `id`, `title`, `deps`, `sourceRef`. The `id` is adapter-assigned — markdown allocates the next prefixed ID in the chosen roadmap file, github-issues returns the new issue number, linear returns the team-prefixed identifier. All file/format detection (checkbox vs table, prefix scanning, task-index update) lives in the adapter; only pass `--prefix` or `--format` when the user explicitly wants to override markdown inference.

GitHub, Linear, and Beads persist the body. Markdown roadmaps retain their compact row format and ignore descriptions; do not pretend the normalized body is durably stored there if the adapter cannot preserve it.

## Report

Confirm: item ID (from the JSON response), title, roadmap/source (from `sourceRef`). Mention that `/pick {ID}` or `/pick next` will pick it up.

If material normalization occurred, briefly report the normalized outcome and any mechanism demoted to a hypothesis or residual retained. Do not dump the whole analysis unless asked.

If scope was inferred (i.e. neither `--scope` nor `--bug` was supplied), append two lines after the confirmation:

```
Inferred scope: {scope} ({rationale phrase})
Override with `/charter ... --scope <XS|S|M|L|XL>` if wrong.
```

Skip these lines when `--scope` or `--bug` was explicit — the absence signals the user supplied the value.
