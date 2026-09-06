# Authentication fault-sensitivity experiment

**Disposition: useful gap found** (observation-surface, not a live-code defect).

Selected authentication faults were injected into disposable copies of `packages/server/src/auth.ts` and classified against existing auth and application observations. C1 (skip the missing-bearer 401) and C2 (hollow the success handoff) are detected by the tests that already exist, including CTR-0008 for C2. C3 (`await next()` then overwrite `c.res` with 401) returns unauthorized **and still stores a run**. Status-only tests survive that fault; the existing application effect assertion does not.

**Selected fault sensitivity is not blanket boundary verification.** Startup configuration has an unchanged-test baseline only; these challenges do not exhaust route/method combinations, public exceptions, deployment behavior, timing resistance or every protected effect. An implementation-decision inventory is candidate assessment, not proof of completeness.

| ID | Injected fault | On-path existing observations | Controls | Outcome |
| --- | --- | --- | --- | --- |
| C1 | `!match` returns after `await next()` with no 401 | 4/4 **detect** (HTTP 200 instead of 401) | success, wrong-token, CTR-0008, `POST /runs` happy path all pass | Detected. No added gap. |
| C2 | success handoff replaced with 401 JSON | 4/4 **detect**, including exact `correct token authenticates state changes` (CTR-0008) | missing-header, wrong-token, unauthenticated `POST /runs` all pass | Detected. Replicates the existing mutation proof; not a fourth challenge. |
| C3 | `!match` calls `next()`, then assigns `c.res` to a 401 | 3/4 **survive** (status/code only); `unauthenticated POST /runs … before spawning` **detects** (`supervisor.list().length` 1≠0 after status 401 and `code: unauthorized`) | success, wrong-token, CTR-0008, happy path all pass | **Useful gap** in status-only observations. Patch realized “401 with effect”, not a 200. |

No candidate was substituted. No live `auth.ts` / tests / CI proof were modified. No daemon, provider, or real credential was used.

## Findings

**Observed behavior.** On a bound C3 copy, missing/malformed `Authorization` still yields HTTP 401 with `code: "unauthorized"` for auth unit tests and for `bearer gate: missing token → 401 except /healthz`. The same request that `app.test.ts` already sends as unauthenticated `POST /runs` with a JSON body and `content-type: text/plain` also yields 401 / `unauthorized`, then fails because `supervisor.list().length === 1`. C1 instead yields 200 on that path. C2 yields 401 on authorized requests, including CTR-0008 (`401 !== 200`). Live checkout and the unmutated control copy both passed every selected named observation (live: 65/65 including config; control: 47/47 auth+app).

**Consequence/meaning.** Refusing authentication is not equivalent to returning 401. Hono 4.12.33 will run the protected handler during `await next()` and still let middleware overwrite `c.res` afterward, so a status-only test can pass while `Supervisor.start` has already stored a run. That is an injected-fault demonstration, not a reproduced defect in unchanged code: live `bearerAuth` returns 401 on `!match` without calling `next()`. The application suite already contains the observation that detects the spawn. TC-010’s evidence command does not: it runs config and auth tests only, and those auth tests are exactly the C3 survivors.

**Evidence limit.** Three predeclared patches, each on a fresh fixture with a realpath/SHA-256 bind from copied `app.ts` → fixture `auth.ts`. On-path survival means only the named observation survived, not the daemon. The JSON-content-type diagnostic was **not** added: the existing text/plain `POST /runs` assertion already failed on `supervisor.list().length === 0`. Untested here: wrong-token and length-mismatch branches as faults; `loadServerConfig()`’s `CONTROL_PLANE_TOKEN` `required()` path; pause/resume/stop and repo-route effects; nested-app vs flattened-route behavior beyond Hono 4.12.33; timing side channels.

**Smallest next action.** Follow-up (not this item): make the `!match` auth unit tests assert that the protected handler did not run, and/or point TC-010’s `evidence_command` at the existing `unauthenticated POST /runs rejects a text/plain simple request before spawning` observation. Do not change production `auth.ts` on the strength of this experiment. No new framework, gate, or runner.

This added information beyond CTR-0008 and the live passing tests: the success-handoff proof still holds (C2), skipping `!match` is already visible as 200 (C1), and “401 after `next()`” is invisible to the status-only evidence surface that TC-010 records.

Reproduction, identity, receipts, and the three patches: [authentication-fault-sensitivity/](authentication-fault-sensitivity/).
