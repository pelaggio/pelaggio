# OpenCode provider setup

Pelaggio's OpenCode provider drives the headless `opencode run --format json` path
(issue #137). One CLI fronts 75+ model backends, so a single profile can route a
step to any of them. OpenCode seats as a true peer on the ADR-0020 provider seam;
it is **not** a default authoring reviewer, so hosts without the binary are
unaffected until an operator opts in.

> Transport note: v1 follows the Gastown headless path (`run --format json`). The
> typed ACP transport (`opencode acp` over Pelaggio's ACP client) is a deferred
> follow-up. If a future OpenCode release changes the `run` argv or the JSON event
> shape, re-pin against `opencode run --help` and re-capture a fixture — the
> provider's pinned-argv comment names the exact spot.

## 1. Install OpenCode

Install the OpenCode CLI and verify the binary:

```bash
curl -fsSL https://opencode.ai/install | bash
opencode --version
```

If OpenCode lives off `PATH` (a managed or per-user install), pin its executable
in `.pelaggio.yml` — a leading `~/` expands to your home directory:

```yaml
providers:
  opencode:
    bin: ~/.opencode/bin/opencode
```

## 2. Choose authentication

OpenCode reads credentials from its own config under `HOME`, which Pelaggio
allowlists. Authenticate once, out of band:

```bash
opencode auth login
```

Do not copy tokens into environment variables. For a backend that expects a
provider API key (for example `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`), set the
variable in the environment that starts Pelaggio and allowlist its **name**,
never its value — driver subprocesses otherwise receive a deny-by-default
environment:

```bash
export OPENAI_API_KEY="sk-..."
```

```yaml
security:
  env-allowlist:
    - OPENAI_API_KEY
```

Key-billed usage is metered by the backend provider account; the operator owns
its quota and billing controls.

## 3. Autonomous permission env

Unattended runs need OpenCode's permission gate opened so tool use does not block
on an interactive prompt. Pelaggio sets this **only on the child process**, via
the deny-by-default agent environment — never by mutating the parent `process.env`:

- `OPENCODE_PERMISSION={"*":"allow"}` — auto-allow tool use for the headless run.
- `OPENCODE_CONFIG_CONTENT={"lsp":true}` — enable LSP for better edits.

`OPENCODE_PERMISSION` is a **permission policy**, not an OS sandbox. It does not
confine the filesystem or the network. Pelaggio's capability row for OpenCode
therefore declares **no** isolation (`isolation: []`); the only structural
controls are the deny-by-default child environment and the worktree working
directory. Treat an OpenCode run as unconfined at the OS level.

## 4. Select OpenCode for Pelaggio steps

Pin the binary and route steps to `opencode`. Address a backend with OpenCode's
`provider/model` form in the profile's `<step>` slot. Omitted steps keep their
normal provider.

```yaml
providers:
  opencode:
    bin: ~/.opencode/bin/opencode

models:
  profiles:
    opencode-build:
      providers:
        implement: opencode
        shakedown-code: opencode
      implement: anthropic/claude-sonnet-4-5
      shakedown-code: openai/gpt-5
```

Run with `npx pelaggio run --profile opencode-build`. OpenCode uses the shared
`model` slot (there is no `opencode` model sub-block, unlike Codex). A bare
`claude-*` id is never forwarded; drop the model lines to let the OpenCode CLI
choose its configured default.

Like Codex and Grok, the harness owns git and the roadmap/forge effects: a
provider-only prompt append tells the model to stay inside its worktree, create
and edit files only, and never run stateful git or network CLIs. The harness
commits the step's work afterward.

## Metering

OpenCode aggregates many billable backends at heterogeneous prices. Pelaggio
reports cost as **estimated** (`costMeter: usd-estimated`) — it prefers a
provider-reported `cost` field when the event stream carries one, else a neutral
token-price estimate for the budget gate. It never claims billed USD.

## Egress and containment limits

Selecting OpenCode sends prompts and repository context — including files read for
a task — to the selected model backend under that provider's retention policy.
Denying child secrets and confining the working directory reduce the blast
radius; they do not prevent legitimate prompt and file context from reaching the
model provider, and `OPENCODE_PERMISSION` does not add OS-level confinement. See
the [egress matrix](./trust/egress.md) and [sandboxing limits](./trust/sandboxing.md).
