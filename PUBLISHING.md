# Publishing

The public source repository is
`https://github.com/kken-x/dsh-data-analyst`. The market submission issue is
open at `https://github.com/polang233/dsh-plugin-index/issues/429`; listing is
pending maintainer review.

## 1. GitHub source (done)

- Repository: `https://github.com/kken-x/dsh-data-analyst`
- Release tag: `v0.1.0`
- Fixed source commit is recorded in [market/issue.md](market/issue.md)
- Market listing issue: `#429`

## 2. npm (still pending)

The package is publish-ready except for npm authentication. Use the public
registry explicitly; the local environment may default to a mirror that cannot
accept publishes.

```bash
npm login --registry=https://registry.npmjs.org/
npm publish --access public --registry=https://registry.npmjs.org/
npm view dsh-data-analyst version
```

If CI owns the token:

```bash
NODE_AUTH_TOKEN=... npm publish --access public --registry=https://registry.npmjs.org/
```

After npm is public, add the npm URL as a comment on issue `#429` so the
listing can point at the npm version.

## 3. Verify installability

From the fixed Git commit/tag:

```bash
dsh plugin --profile <profile> add github:kken-x/dsh-data-analyst
```

Or from the market/plugin manager once the listing is approved. Then add a
read-only connection and ask one analysis question; confirm the inline chart
and an `audit.jsonl` record.

## 4. Tag the release

```bash
git tag v0.1.0
git push origin v0.1.0
```

## Local install alternative

The current profile already links this directory:

```bash
plugin_manager install_bundle target="D:\DeepSeek Harness\dsh-data-analyst"
```

A local directory install is not a market release; the public repository and
the submission issue are the review artifacts.
