# Contributing

Thanks for your interest in contributing to pelaggio.

## License

This project is licensed under the **Functional Source License, Version 1.1,
Apache 2.0 Future License** (`FSL-1.1-ALv2`) — see [`LICENSE`](./LICENSE). By
contributing, you agree that your contributions are licensed under the same
terms.

## Developer Certificate of Origin (DCO)

All contributions must be signed off under the
[Developer Certificate of Origin](./DCO) (DCO 1.1). The sign-off certifies that
you wrote the change or otherwise have the right to submit it under the
project's license. It is a lightweight alternative to a CLA and preserves the
project's ability to relicense in the future.

Add the sign-off by committing with `-s`:

```bash
git commit -s -m "your message"
```

This appends a line to your commit message using the identity in your git
config (`user.name` / `user.email`):

```
Signed-off-by: Jane Doe <jane@example.com>
```

Use your real name and a reachable email address. Commits without a valid
`Signed-off-by` trailer that matches the author will not be merged.

If you forgot to sign off, amend the most recent commit:

```bash
git commit --amend -s --no-edit
```

For a branch of several commits, rebase with sign-off:

```bash
git rebase --signoff main
```

## Before you open a pull request

Run the same checks CI runs:

```bash
pnpm install
pnpm -r test
pnpm check
pnpm check:skills
```

Keep changes focused and describe the intent in the PR body.
