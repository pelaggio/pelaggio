# Grok Build provider setup

Pelaggio's brokered Grok provider is conformance-tested against Grok Build **0.2.103** and the
explicit model **`grok-4.5`**. The binary, ACP protocol, routes, and streaming response shape are a
reviewed set: stop if the version check reports another release.

## 1. Prepare Linux containment

Install `bubblewrap` and ensure user systemd scopes work:

```bash
sudo apt-get update
sudo apt-get install bubblewrap
systemd-run --user --scope --wait --collect --quiet /bin/true
```

Landlock adds Grok's native sandbox as defense in depth:

```bash
grep landlock /sys/kernel/security/lsm
```

## 2. Install and pin Grok 0.2.103

```bash
curl -fsSL https://x.ai/cli/install.sh | bash -s 0.2.103
~/.grok/bin/grok --version
```

Pin the official installer path in `.pelaggio.yml`:

```yaml
providers:
  grok:
    bin: ~/.grok/bin/grok
```

The installer path may be a symlink. Pelaggio resolves it before containment and mounts only the
resolved regular executable read-only inside the jail.

## 3. Authenticate on the host

```bash
~/.grok/bin/grok login
```

Pelaggio requires `~/.grok/auth.json` to be a regular, non-symlink file. Each run copies only that
file into an ephemeral private `HOME` at mode `0600`; it never mounts the operator's `.grok`
directory and never copies refresh/session writes back. If cached auth needs the separate
`auth.x.ai` refresh service, the run fails closed. Run `grok login` again on the host rather than
widening the egress allowlist.

This integrated route is the local, single-developer subscription/transparent-auth path. An
`XAI_API_KEY` or custom endpoint is not silently sent to the subscription proxy. Key/external-auth
mode needs a separately reviewed origin, auth rule, and request fixture.

Never add `--debug-file`: Grok 0.2.103 can write its OAuth JWT there in cleartext.

## 4. Select Grok for steps

```yaml
models:
  profiles:
    grok-build:
      providers:
        implement: grok
        shakedown-code: grok
      implement: grok-4.5
      shakedown-code: grok-4.5
```

Run with `npx pelaggio run --profile grok-build`. When a mixed-provider profile supplies a Claude
model or no Grok model, Pelaggio uses the reviewed `grok-4.5` default explicitly. Any other Grok
model fails before the broker or driver starts.

Every Grok step runs under `systemd-run` and bubblewrap with `--unshare-all`, a private home, masked
Git metadata, the active worktree, read-only dependency targets, and one mounted Unix broker
socket. A trusted PID-1 loopback shim supports Grok's official
`--cli-chat-proxy-base-url`; no other interface in the namespace is externally routable. The broker
allows only the exact Grok 0.2.103 bootstrap/control routes and streaming model route at
`cli-chat-proxy.grok.com`, with request/response, rate, token, and spend caps.

## Landlock-less hosts

Without Landlock, Grok's nested native sandbox refuses by default. The config escape hatch:

```yaml
providers:
  grok:
    bin: ~/.grok/bin/grok
    allow-unsandboxed-fallback: true
```

This omits only Grok's nested `--sandbox` selection. The outer systemd/bubblewrap jail, private
network namespace, broker, write-set validation, and scope-level teardown remain mandatory; there
is no direct-network or uncontained fallback.

**Transparent subscription auth still refuses without Landlock.** The staged `~/.grok/auth.json`
lives in the same private HOME Grok's unsandboxed shell tools can read, and prompt-injected code
could copy the OAuth credential into the writable worktree, which write-set validation accepts. So
the fallback is safe by construction only for key auth, where no credential file is staged — and
grok's direct-key route is not yet implemented/reviewed. Until it is, Grok effectively requires
Landlock.

## Limits and release conformance

The selected model provider remains an allowed sink for prompts and repository/read-file context.
Containment prevents alternate network destinations; it cannot make legitimate model traffic
confidential from the provider or establish contractual permission for subscription automation.
Subscription mode remains local single-developer only, and the harness enforces it: any
unattended-execution signal (CI/single-shot, daemon-spawned, multi-cycle campaign, or headless
without the `PELAGGIO_OPERATOR_ATTENDED=1` attestation) refuses transparent subscription auth
fail-closed before any auth staging, for every Grok dispatch path.

The opt-in release gate requires Linux, working user scopes/bubblewrap, Grok 0.2.103, a safe auth
file, and network access:

```bash
PELAGGIO_GROK_LIVE_CONFORMANCE=1 \
node --import tsx --test --test-name-pattern='live Grok' \
  packages/pelaggio/scripts/pelaggio/__tests__/grok-sandbox.test.ts
```

It verifies real ACP traffic through the broker, the pinned model/stream shape, exact decision
routes, namespace denial of raw external traffic, and redaction of auth/query/origin/body data.
