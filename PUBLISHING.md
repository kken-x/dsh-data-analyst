# Publishing

The public source repository is
`https://github.com/kken-x/dsh-data-analyst`. npm is published at
`https://www.npmjs.com/package/dsh-data-analyst` (version `0.1.0`).

The market submission issue is open at
`https://github.com/polang233/dsh-plugin-index/issues/429`; listing is pending
maintainer review.

## 1. GitHub source (done)

- Repository: `https://github.com/kken-x/dsh-data-analyst`
- Release tag: `v0.1.0`
- Release: `https://github.com/kken-x/dsh-data-analyst/releases/tag/v0.1.0`
- Market listing issue: `#429`

## 2. npm (done)

Published to the public registry:

```bash
npm view dsh-data-analyst version
# 0.1.0
```

For future releases:

```bash
npm login --registry=https://registry.npmjs.org/
npm publish --access public --registry=https://registry.npmjs.org/
```

If CI owns the token:

```bash
NODE_AUTH_TOKEN=... npm publish --access public --registry=https://registry.npmjs.org/
```

## 3. Verify installability

From npm:

```bash
dsh plugin --profile <profile> add dsh-data-analyst
```

From the fixed Git tag:

```bash
dsh plugin --profile <profile> add github:kken-x/dsh-data-analyst
```

Then add a read-only connection and ask one analysis question; confirm the
inline chart and an `audit.jsonl` record.

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

A local directory install is not a market release; the public repository, npm
package, and submission issue are the review artifacts.
