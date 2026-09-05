# @pelaggio/site

Public marketing site for pelaggio. Astro + Tailwind v4. Static output.

This is not the daemon UI. `packages/web` stays the control-plane shell at `/ui/`.

## Develop

```bash
pnpm --filter @pelaggio/site dev
```

## Build

```bash
pnpm --filter @pelaggio/site build
```

Output: `packages/site/dist/`.

## Host

Cloudflare Pages, on the public domain. Keep it off the daemon tunnel in `infra/cloudflare`.

- Root: repository root
- Build command: `pnpm --filter @pelaggio/site build`
- Output directory: `packages/site/dist`

Do not add this package to `deploy-server.yml`. Copy edits must not restart the daemon.
