# ACP over stdio — grok 0.2.103 conformance reference

(design) Wire-protocol capture for the Agent Client Protocol (ACP) surface exposed by
`grok agent stdio`, pinned to the **grok 0.2.103** conformance target (issue #238 spike →
#239 client → #136 grok-provider). Captured hands-on against the live subscription CLI; no
`--debug`/`--debug-file` (those leak the OAuth JWT in cleartext — see #237).

This documents observed behavior of one agent, not the full ACP spec. The #239 client is
**agent-neutral** (transport + core ACP methods); grok-specific mapping lives in #136.

## Transport

- **Framing:** newline-delimited JSON (ndjson), one JSON-RPC 2.0 message per line. **Not**
  `Content-Length`-framed (LSP-style). A partial trailing line must be buffered across reads.
- Invocation: `grok agent stdio` (optionally `-m <model>`, `--reasoning-effort <e>`). Reads
  requests on stdin, writes responses + notifications on stdout, logs on stderr.
- Three message kinds share the pipe: responses (`id` + `result`/`error`), server→client
  requests (`id` + `method`), and notifications (`method`, no `id`). Correlate responses by
  `id`; dispatch requests by `method`; treat everything else as a notification.

## Lifecycle

1. **`initialize`** → `{ protocolVersion: 1, agentCapabilities, authMethods, _meta }`.
   - `agentCapabilities`: `loadSession: true`, `promptCapabilities.embeddedContext: true`,
     `mcpCapabilities.{http,sse}`, and `_meta["x.ai/fs_notify"]`, `_meta["x.ai/hooks"]`
     (`blockingEvents: ["pre_tool_use"]`, `decisions: ["deny"]`).
   - `authMethods`: `cached_token` (from `~/.grok/auth.json` — the headless subscription
     path) and `grok.com`. `_meta.defaultAuthMethodId = "cached_token"`.
   - `_meta` also carries `agentVersion` (`0.2.103`), `modelState` (default `grok-4.5`,
     500K ctx, `reasoningEfforts` high/medium/low), and `availableCommands`.
2. **`session/new`** `{ cwd, mcpServers: [] }` → `{ sessionId, models }`. Emits a burst of
   `_x.ai/*` notifications (mcp/announcements/settings) around it — all ignorable.
3. **`session/prompt`** `{ sessionId, prompt: [{ type: "text", text }] }` → streams
   `session/update` notifications, then resolves with
   `{ stopReason, _meta: { usage, totalTokens, inputTokens, outputTokens, ... } }`.

## `session/update` notifications (`params.update.sessionUpdate` discriminant)

| `sessionUpdate`             | Meaning / key fields                                                       |
|-----------------------------|----------------------------------------------------------------------------|
| `agent_message_chunk`       | **The answer text.** `content: {type:"text",text}`. Concatenate for output.|
| `agent_thought_chunk`       | Reasoning stream. `content.text`. **Exclude from the step's answer text.**  |
| `user_message_chunk`        | Echo of the prompt. `content.text`.                                         |
| `tool_call`                 | `toolCallId`, `title`, `rawInput`, `_meta["x.ai/tool"].{kind,name,namespace}`.|
| `tool_call_update`          | `toolCallId`, `status` (`in_progress`/`completed`/`failed`), `content`, `rawOutput`, `kind`, `title`, `locations` (file-change paths). |
| `available_commands_update` | Slash-command catalog refresh. Ignorable.                                   |
| `plan`                      | ACP plan entries (not observed in the trivial probe; handle defensively).   |

**File changes** surface as `tool_call` / `tool_call_update` with a file-writing `kind` and
populated `locations` — the reason to use ACP over `-p --output-format streaming-json`, whose
flattened stream omits tool-call/file-change events (#238 finding).

## Terminal state + usage

- Authoritative completion is the **`session/prompt` response**: `stopReason` +
  `_meta.usage` (`inputTokens`, `outputTokens`, `cachedReadTokens`, `reasoningTokens`,
  `costUsdTicks` — cost in nano-USD, so USD = `costUsdTicks / 1e9`, `modelCalls`,
  `apiDurationMs`). Prefer this over scraping the stream.
- A per-turn `turn_completed` (via `_x.ai/session_notification`) and
  `_x.ai/session/prompt_complete` also carry `stop_reason`/`usage` — redundant with the
  response; use them only for live progress.
- Observed `stopReason` values: `end_turn` (ok). Expect also `max_tokens`, `refusal`,
  `cancelled`, and a tool-loop reason — map non-`end_turn` conservatively in #136.

## Permissions (autonomous driving)

The agent requests approval before a gated tool. In the probe grok emitted a
`pending_interaction {kind:"permission"}` x.ai notification and resolved it via
`interaction_resolved`. The standard ACP path is a **server→client `session/request_permission`
request** the client must answer. For pelaggio's autonomous runs the client must auto-answer
"allow" (or launch with an always-approve option), while confinement is still enforced by the
sandbox/worktree boundary — never by declining permissions. (#136 owns the policy; #239 only
needs to route server→client requests to a handler.)

## Implications for the #239 client

- ndjson reader with cross-read line buffering; write one JSON line per message.
- Request/response correlation by monotonic integer `id`; a pending-map keyed by `id`.
- Notification sink + a server→client request handler (default: reject/allow policy injected).
- Lifecycle helpers: `initialize`, `sessionNew`, `sessionPrompt` — typed but agent-neutral.
- Lifecycle: SIGTERM→SIGKILL on abort/timeout (mirror `providers/codex.ts`); surface spawn
  errors; resolve the prompt promise on the response, not on a stream sentinel.
