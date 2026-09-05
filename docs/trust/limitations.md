# Before you let the work run

Pelaggio is an open-source CLI for running development work with coding agents.
Start with a small change in a repository you know well. Review the result yourself.
This page is the starting point for the marketing site's behavior and trust claims;
the linked technical documents explain their scope and evidence.

## Before a run

Commit or back up work you want to preserve. Read the generated configuration and
setup diff, choose a work item you can evaluate, and stay nearby for the first cycle.
An agent CLI needs its own authentication and setup. Some provider paths need Linux
and additional confinement tools; installing Pelaggio alone does not configure them.
See the [setup guide](https://github.com/pelaggio/pelaggio#quickstart).

Pelaggio opens a pull request by default. Configuration can opt into other shipping
behavior, including direct pushes. Check the shipping target before starting. A PR
is a place for review; its existence does not establish that anyone reviewed it.
See [permissions and shipping defaults](https://github.com/pelaggio/pelaggio/blob/main/docs/trust/permission-model.md)
(TC-003, TC-012, TC-013).

## Where an agent can reach

A git worktree gives each item its own working files and branch. That is not a
complete machine sandbox. Protection varies by provider and execution mode. An agent
may still reach host files, credentials, networks, or tools outside the change you
intended. Worktree checks cannot establish that nothing else happened on the host.

Prompt injection remains a threat. Repository files, tool output, and remote content
can contain instructions that redirect an agent. Do not treat a successful run as
proof that those instructions were harmless or ignored.
See [sandbox scope](https://github.com/pelaggio/pelaggio/blob/main/docs/trust/sandboxing.md)
and the [threat model](https://github.com/pelaggio/pelaggio/blob/main/docs/trust/threat-model.md)
(TC-011, TC-014, TC-015, TC-018).

## Data and credentials

Running on your machine does not mean offline. Your configured model providers and
integrations receive the data needed for their work, under their own retention and
account policies. Pelaggio has no analytics channel, but that does not describe the
telemetry behavior of every agent CLI you install.

Credential filtering and log scrubbing have limits. They are not a promise that
secrets can never enter a prompt, appear in a file, or leave through a tool. Novel
credential formats and host credential files remain relevant. Avoid using sensitive
data in a trial run and inspect what your chosen providers can access.
See [data destinations and credential handling](https://github.com/pelaggio/pelaggio/blob/main/docs/trust/egress.md)
(TC-001, TC-002, TC-006, TC-014).

## Reviews and checks

An agent can write a plausible implementation and still misunderstand the task.
Another agent can miss the same problem. Passing checks establish only what those
checks exercise. They do not establish product fit, security, or completeness.

Read the diff, inspect the evidence, and exercise the change in the context where it
will be used. Decisions about policy, acceptable risk, and whether a change should
land remain yours. See the
[trust overview](https://github.com/pelaggio/pelaggio/blob/main/docs/trust/overview.md)
(TC-003, TC-012, TC-013, TC-015).

## Interruptions and recovery

Provider limits, unavailable tools, failed checks, and process failures can interrupt
work. Some paths checkpoint and park it; recovery depends on the failure and on which
state was persisted. Do not assume a partial run was rolled back, or restart it
without inspecting the branch and run state. Provider calls may already have incurred
charges.

Keep a backup and a way to inspect local changes independently of Pelaggio.
See [stopping, recovery, and rollback](https://github.com/pelaggio/pelaggio/blob/main/docs/trust/uninstall-and-rollback.md)
(TC-003, TC-012, TC-013).

## Delivery records

The landing page compares two deliberately authored medium work items on the same
small application: CSV export and interrupted import. The short requests and charter
choices were supplied by the supervising assistant as scenario design. The plans and
execution records come from actual model sessions. The page distinguishes repository
context, charter choices, planning decisions, and observed test outcomes.

These supervised local demonstrations use Codex and Grok. The operator explicitly
authorized Grok's unsandboxed fallback after the host's missing Landlock support stopped
review. Environmental containment is not established by these runs. Earlier failed
attempts and the operator's claim/resume intervention remain in the captured history.
The demos use local bare git remotes; they do not establish a GitHub PR or hosted CI
outcome. Their execution settings do not change the product's defaults.

Independent evaluation runs outside the candidate repository. Baseline results show
missing behavior before implementation; they are never substituted for candidate
verification. Candidate results identify the checked revision. CSV probes exercise
HTTP responses and browser downloads. Import probes exercise process termination and
restart, not power-loss durability or concurrent writers. Passing cases establish only
what was exercised; plan self-assessments and model reviews remain attributed judgments.

The site displays a captured state, including a failed or incomplete outcome when that
is what the records establish. Builds validate source digests and regenerate both views
offline. They do not call models or rerun the original application checks. Updating a
capture is deliberate; a rerunnable demonstration is not a reliability measurement.

The downloadable manifest is site capture metadata, not the production delivery
envelope or an attestation. Digests support byte comparison, not authorship or
correctness. Producing and signing a record for every delivery remains separate work.
See the [delivery format and its status](https://github.com/pelaggio/pelaggio/blob/main/docs/ai-delivery/v0.1/spec.md).
