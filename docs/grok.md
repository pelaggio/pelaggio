# Grok Build provider setup

Pelaggio's Grok provider is conformance-tested against Grok Build **0.2.103**. The ACP and sandbox contracts are release-specific: stop if the version check below reports anything else.

## 1. Prepare Linux sandbox support

On Debian or Ubuntu, install Grok's Linux sandbox helper:

```bash
sudo apt-get update
sudo apt-get install bubblewrap
```

Then verify that the running kernel exposes Landlock:

```bash
grep landlock /sys/kernel/security/lsm
```

The command must print a list containing `landlock`. A missing file or no match means Pelaggio's managed Grok sandbox will refuse to start. Default WSL2 kernels commonly lack Landlock; see [Landlock-less hosts](#landlock-less-hosts) before using Grok there.

## 2. Install and pin Grok 0.2.103

The Grok 0.2.103 installer documents a positional version argument. Install that exact release, then verify the binary at its managed, normally off-PATH location:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash -s 0.2.103
~/.grok/bin/grok --version
```

The output must contain `grok 0.2.103`. Do not continue on a mismatch and do not replace the versioned command with a latest-release install. Pin the same executable in `.pelaggio.yml` even if your shell can find `grok`:

```yaml
providers:
  grok:
    bin: ~/.grok/bin/grok
```

## 3. Choose authentication

### Subscription device login

Use a SuperGrok or X Premium+ subscription:

```bash
~/.grok/bin/grok login
```

The device login is cached in `~/.grok/auth.json`. Pelaggio passes the allowlisted `HOME` variable, so Grok can read and refresh this file; do not copy the token into an environment variable. Usage is metered against the signed-in subscription.

### API key

For provider-billed API-key usage, set `XAI_API_KEY` in the environment that starts Pelaggio and allowlist its **name**, never its value:

```bash
export XAI_API_KEY="xai-..."
```

```yaml
security:
  env-allowlist:
    - XAI_API_KEY
```

Driver subprocesses otherwise receive a deny-by-default environment. API-key usage is billed and metered by the endpoint/provider account, not a SuperGrok or X Premium+ subscription; the operator owns its quota and billing controls.

> Never add `--debug-file` to a Grok invocation. Grok 0.2.103 writes the OAuth JWT to that file in cleartext. Pelaggio neither needs nor enables the flag; a debug file inside a repository could also be committed accidentally.

## 4. Optionally choose a compatible endpoint

Grok 0.2.103 accepts custom OpenAI-compatible model endpoints in `~/.grok/config.toml`. Give the endpoint a model name and select that name in Pelaggio:

```toml
[model.company-grok]
model = "grok-build"
base_url = "https://grok-proxy.example.com/"
name = "Company Grok proxy"
```

This is a Grok CLI endpoint override chosen and operated by you. It does not by itself prove that all vendor traffic is removed; validate the configured endpoint, authentication path, and observed traffic for your deployment. The unmodified, conformance-tested Grok 0.2.103 path was observed contacting `cli-chat-proxy.grok.com`.

## 5. Select Grok for Pelaggio steps

This complete example pins the executable and defines a profile that uses Grok for implementation and code review. Omitted steps retain their normal provider.

```yaml
providers:
  grok:
    bin: ~/.grok/bin/grok

models:
  profiles:
    grok-build:
      providers:
        implement: grok
        shakedown-code: grok
      implement: grok-4.5
      shakedown-code: grok-4.5
```

Run with `npx pelaggio run --profile grok-build`. Remove the two model lines to let the Grok CLI select its default, or use the custom model name from the optional endpoint example.

For every Grok step, Pelaggio installs a namespaced `pelaggio-worktree-v1` block in `~/.grok/sandbox.toml` and invokes Grok with `--sandbox pelaggio-worktree-v1 --disable-web-search`. The profile extends Grok's `strict` policy: project access is confined to the invocation worktree, and on supported Linux hosts child commands cannot use the network. Grok still needs system runtime files and its own auth, session, and sandbox-event state under `~/.grok`.

## Landlock-less hosts

Without Linux Landlock, including on typical default WSL2 kernels, the managed profile fails closed. For a **local, actively supervised run only**, this escape hatch is available:

```yaml
providers:
  grok:
    bin: ~/.grok/bin/grok
    allow-unsandboxed-fallback: true
```

Pelaggio then starts Grok without its CLI sandbox and prints a warning. The remaining controls are the deny-by-default child environment and CWD guidance; there is no Grok CLI filesystem or child-network enforcement. Never use this fallback for unattended, CI, or shared-host operation.

## Egress and containment limits

Selecting Grok sends prompts and repository context—including files read for a task—to the selected Grok service endpoint under that provider's retention policy. Denying child secrets, confining files, blocking child networking, and disabling web search reduce the blast radius; they do not prevent legitimate prompt and file context from reaching the selected model provider.

Grok 0.2.103 exempts its in-process model client from the child-network rule and exposes no hostname allowlist. Pelaggio's release probe observed and locks `cli-chat-proxy.grok.com`, but that is a conformance assertion, not kernel- or L7-enforced routing. See the [egress matrix](./trust/egress.md) and [sandboxing limits](./trust/sandboxing.md).
