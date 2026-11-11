# Market submission packet

This file is the copy-ready checklist for listing `dsh-data-analyst` in the
Open Plugin Market (`https://dshopen.org`) and for the npm release.

## Package facts

| Field | Value |
| --- | --- |
| npm package | `dsh-data-analyst` |
| Display name | Data lens / 数据透镜 |
| Version | `0.1.0` |
| License | MIT |
| Category | `tools` |
| DSH range | `>=0.2.0-rc.1 <0.3.0-0` |
| Node range | `>=22.19` |
| Host + Client | yes (inline chart tool cards) |
| Repository | `https://github.com/kken-x/dsh-data-analyst` |

## Short description

**EN**: Conversational, read-only data analyst for DeepSeek Harness. One
`db_analyze` call turns a natural-language question into a validated SELECT,
runs it with row/time limits, picks the right chart, and renders an inline SVG
with an audit trail.

**ZH**: 对话式只读数据分析师。一次 `db_analyze` 调用完成自然语言问题 → 只读 SQL →
安全执行 → 智能选图 → 对话内 SVG 渲染，并留下可审计记录。

## Keywords

```
dsh, dsh-plugin, deepseek-harness, data-analysis, analytics, sql,
sqlite, postgresql, mysql, chart, visualization, read-only
```

## Install verification

```bash
npm view dsh-data-analyst version
# then in DSH: install bundle from the market / plugin manager
```

On a clean profile:

1. Install the bundle.
2. Add one read-only SQLite/PostgreSQL/MySQL connection in the plugin config.
3. Ask: “2025 年各地区的收入对比。”
4. Confirm the inline chart and the `audit.jsonl` record.

## Submission issue fields

- **Plugin name**: `dsh-data-analyst`
- **Title**: Data lens / 数据透镜
- **Repository**: `https://github.com/kken-x/dsh-data-analyst`
- **npm**: `https://www.npmjs.com/package/dsh-data-analyst`
- **License**: MIT
- **Category**: Tools
- **Install command**: `dsh plugin --profile <profile> add dsh-data-analyst`
- **Dependencies**: `@deepseek-ai/schemastery`, `pg`, `mysql2`; SQLite uses
  Node's built-in `node:sqlite` (Node >= 22.19).
- **Security notes**: read-only at config, lexical, and execution layers;
  no write tool; credentials via `passwordEnv`/`passwordRef`; audit excludes
  values and credentials.
- **Verification**: DSH `0.2.2-rc.1`, Windows 11, Node `22.20.0`, demo SQLite
  database; four tools exercised, chart route returns `image/svg+xml`, Client
  slot registrations confirmed.

## Blocking values

1. `GITHUB_REPOSITORY_URL` — now `https://github.com/kken-x/dsh-data-analyst`.
2. npm authentication — `npm login` or `NODE_AUTH_TOKEN`, then
   `npm publish --access public --registry=https://registry.npmjs.org/`.

The plugin is already installed and verified locally. The GitHub source is
being pushed as a fixed-commit fallback for market review; npm publishing
still needs an npm account token.
