# Publishing

The package is publish-ready except for two account-owned values: the public
repository URL and npm authentication.

## 1. Add the repository URL

Edit `package.json` and add the repository that will host this package:

```json
"repository": {
  "type": "git",
  "url": "git+https://github.com/<owner>/dsh-data-analyst.git"
}
```

Market review checks that the listing name, package name, and repository agree.

## 2. Publish to npm

Use the public registry explicitly; the local environment may default to a
mirror that cannot accept publishes.

```bash
npm login --registry=https://registry.npmjs.org/
npm publish --access public --registry=https://registry.npmjs.org/
npm view dsh-data-analyst version
```

If CI owns the token:

```bash
NODE_AUTH_TOKEN=... npm publish --access public --registry=https://registry.npmjs.org/
```

## 3. Verify installability

In a clean profile:

```bash
dsh plugin --profile desktop add dsh-data-analyst
```

Then install it from the market UI or plugin manager, add a read-only
connection, and ask one analysis question. Confirm the inline chart and an
`audit.jsonl` record.

## 4. Submit the listing

Open the Open Plugin Market submission issue:

https://github.com/polang233/dsh-plugin-index/issues/new?template=plugin-add.yml

Use the fields in [market/submission.md](market/submission.md). Attach the
icon (`icon.svg`) and point at the npm version.

## 5. Tag the release

```bash
git tag v0.1.0
git push origin main --tags
```

## Local install alternative

The current profile already links this directory:

```bash
plugin_manager install_bundle target="D:\DeepSeek Harness\dsh-data-analyst"
```

A local directory install is not a market release; it does not satisfy the
public npm/repository requirement.
