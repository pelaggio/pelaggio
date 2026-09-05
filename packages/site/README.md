# @pelaggio/site

Public static site. Astro + Tailwind. The daemon UI remains in `packages/web`.

## Work on the site

```bash
pnpm --filter @pelaggio/site dev
pnpm --filter @pelaggio/site example:refresh
pnpm --filter @pelaggio/site test
pnpm --filter @pelaggio/site check:types
pnpm --filter @pelaggio/site build
pnpm --filter @pelaggio/site exec playwright-core install --with-deps chromium
pnpm --filter @pelaggio/site test:browser
```

For an existing Chrome installation, set `SITE_CHROME_PATH` to its executable when
running `test:browser`. `SITE_SCREENSHOT_DIR` optionally saves desktop/mobile captures.

`build` regenerates the example and social image before Astro writes `dist/`.
No agent calls, credentials, live work items, or scheduled refresh job are needed.

## The example

The landing page uses the model-run capture selected by `exampleDir` in
`scripts/example.ts`, under `experiments/model-delivery/captures/`. Both scenarios use
the same component layout and native radio controls; the toggle works without JavaScript.
The experiment README documents preparation, execution, independent evaluation, and
capture. Build scripts never invoke models or fetch fresh run evidence.

Each capture contains the actual charters, plans, attempt summaries, baseline checks,
and any captured candidate checks. Digests are validated before publishing downloads.
Candidate checks must identify the displayed revision. Missing candidate checks remain
missing; baseline passes cannot fill that gap. Copy summarizes the sources and keeps
charter choices separate from model planning decisions.

After an execution exits, evaluate the resulting candidate and capture it into a new
directory. Inspect the artifacts, update the selected directory, and revise editorial
summaries if the plan or result changed. Keep failed attempts and operator interventions.
The user authorized Grok's supervised unsandboxed fallback for these local demos; the
receipts and limitations document retain that qualification. Do not describe these local
deliveries as GitHub PRs or environmental containment demonstrations.

The canonical `docs/ai-delivery/v0.1` files are copied to their public schema URLs.
These captures do not claim to be emitted production delivery envelopes; #782 owns the
richer production handoff. CI checks both views, native no-JavaScript switching,
expanded plans/receipts, mobile widths, exact downloadable bytes, and revision binding.

`docs/trust/limitations.md` is rendered directly at `/limitations`. Edit it there;
do not maintain a separate marketing copy of the trust statements.

## Temporary GitHub Pages publication

The temporary public URL is `https://pelaggio.github.io/pelaggio/`. Build with
`pnpm --filter @pelaggio/site build:pages`, then run the browser smoke with
`SITE_ORIGIN=https://pelaggio.github.io SITE_BASE=/pelaggio` in addition to any Chrome
settings. `SITE_ORIGIN` controls canonical/social URLs; `SITE_BASE` controls links and
assets. Ordinary builds retain the Cloudflare root-domain configuration.

Pages publishes static output from the root of `gh-pages`, with an empty `.nojekyll`
file. Publish only the contents of `packages/site/dist`, omit the Cloudflare-only
`_headers` and `_redirects`, and record the source commit in the publication commit.
Subsequent source pushes do not automatically refresh this temporary branch: rebuild,
check, and update `gh-pages` to publish another version. GitHub runs its Pages deployment
when that branch changes. The Cloudflare workflow below remains the intended automation.
GitHub Pages does not apply Cloudflare's custom headers or redirects.

## Deployment: GitHub Actions to Cloudflare Pages

CI tests and builds the site on GitHub-hosted runners, runs browser smoke checks, and
uploads `site-<github.sha>`. The dependent `site-deploy` job downloads that exact artifact
and uploads it with a pinned Wrangler action/version. It does not check out or execute
PR scripts. Production is `main`; same-repository PRs use `pr-<number>` preview branches.
Fork PRs receive build checks and downloadable artifacts, with no deployment credentials.
Cloudflare adds `X-Robots-Tag: noindex` to previews; the post-deploy check verifies it.

Initial account setup, before enabling deployments:

1. Create a **Direct Upload** Pages project with production branch `main`. Leave Functions,
   runtime bindings, and Git-integrated automatic builds unconfigured for this static site.
2. Set repository variables `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_PAGES_PROJECT`.
   Set `CLOUDFLARE_API_TOKEN` as a GitHub Actions secret with Cloudflare Pages Edit access
   for the intended account. Use the `site-production` / `site-preview` environments for
   access controls appropriate to the repository. The credential belongs only in the
   deployment job. Never enable `pull_request_target` to build fork code with it.
3. Run CI on `main` (push or manual dispatch). An unset project variable skips deployment;
   passing CI alone does not mean the site is live. Once enabled, bad/missing credentials
   fail deployment visibly. The job verifies the returned immutable deployment URL.
4. Associate `pelaggio.com`, `www.pelaggio.com`, `pelaggio.dev`, and `www.pelaggio.dev`
   with the Pages project **before** configuring their DNS records. Wait for domain/TLS
   activation. Canonical URLs use `https://pelaggio.com`. Configure the host redirects
   below in Cloudflare Redirect Rules; Pages `_redirects` does not support host matching.
   The `.dev` predicate identifiers remain
   unchanged; `/ai-delivery/v0.1/predicate.schema.json` and the other format files are
   published so redirected schema URLs resolve. The predicate root links to its spec.
5. Check all four hosts over HTTPS and HTTP, path/query preservation, `/limitations`,
   a missing page's 404, the social image, and the schema URL. Set a Cloudflare redirect
   for the production `<project>.pages.dev` alias to `.com` if desired; do not redirect
   preview hosts. A canonical tag is already present.

Host redirect rules (301, preserve query string):

| Zone | Matching expression | Dynamic target |
|---|---|---|
| `pelaggio.com` | `http.host eq "www.pelaggio.com"` | `concat("https://pelaggio.com", http.request.uri.path)` |
| `pelaggio.dev` | `http.host in {"pelaggio.dev" "www.pelaggio.dev"}` | `concat("https://pelaggio.com", http.request.uri.path)` |

Keep these rules independent of the path-only `_redirects` file. Ensure DNS is proxied
for host redirect rules, and enable HTTPS redirection for the canonical host.

Do not route this site through the daemon tunnel. Site copy changes do not match the
daemon workflow. **A shared lockfile change still triggers `deploy-server.yml`, including
a site dependency update.** That existing deployment coupling is not solved by adding
this site. Keep dependency updates deliberate; this PR adds no new runtime guard.

For rollback, use Cloudflare Pages' rollback to an earlier successful **production**
deployment, then revert the source change and let CI redeploy it. The 14-day Actions
artifact is useful for inspection but is not the long-term rollback store. A failed
post-deploy smoke means the new deployment may already be live; it does not roll back
by itself. Inspect the deployment before retrying.

Provider instructions:
[Direct Upload from CI](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/),
[custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/),
[preview deployments](https://developers.cloudflare.com/pages/configuration/preview-deployments/).
