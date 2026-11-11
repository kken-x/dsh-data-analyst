# Security

`dsh-data-analyst` is designed for read-only analytical access to databases that may contain production data. The plugin does not rely on the DSH file sandbox as a security boundary; it carries its own three-layer read-only model.

## Reporting

Open a private security advisory on the repository, or contact the maintainer listed in `package.json`. Please include the plugin version, DSH version, database driver, and a minimal reproduction. Do not include real credentials or customer data.

## Threat model

In scope:

- A model or prompt injection attempts to turn a SELECT into a write, a multi-statement script, a file read, or a privilege operation.
- A malicious result value attempts HTML/script injection into the SVG chart or the inline card.
- A query attempts to exhaust memory or the Host event loop.
- Credentials leak through logs, errors, audit records, or tool output.

Out of scope:

- A database account that already has write privileges: the plugin blocks writes it can see, but database permissions remain the real boundary.
- A user who intentionally configures a writable SQLite file path or a superuser account.
- Data exfiltration through ordinary SELECT results by an authorized analyst; the plugin does not classify or redact business data.

## Controls

### Read-only at three layers

1. **Configuration**: `readOnly: false` is rejected at activation. No write tool is registered.
2. **Lexical**: `lib/sql-guard.js` strips comments/strings/identifiers and accepts exactly one `SELECT`, `WITH ... SELECT`, or `EXPLAIN`. It rejects DML, DDL, transaction control, `PRAGMA`, `ATTACH`, `COPY`, `CALL`, `INTO`, `FOR UPDATE`, `LOCK IN SHARE MODE`, MySQL executable comments, and a denylist of file/network/side-effect functions.
3. **Execution**: SQLite opens with `readOnly: true` in a worker; PostgreSQL runs `BEGIN READ ONLY`; MySQL runs `START TRANSACTION READ ONLY`. Row caps are enforced by a derived-table `LIMIT` and a driver-side slice; timeouts terminate or destroy the query.

### Credentials

- Use `passwordEnv` or `passwordRef`. Literal `password` is supported only as a fallback and is not recommended.
- Passwords are resolved per connection and never placed in tool arguments, tool output, audit records, or error messages.
- Error sanitization removes `password=...`, URL userinfo, and configured literal secrets.
- Audit records store a SHA-256 of the SQL plus a literal-redacted preview; they do not store bound parameter values or result rows.

### Chart and UI safety

- Chart IDs are 128-bit random values and map only to in-memory SVGs. The HTTP route never reads a filesystem path from the request.
- All data-derived text is XML-escaped before entering SVG.
- The chart response sets `Content-Type: image/svg+xml`, `X-Content-Type-Options: nosniff`, a restrictive CSP, and `Referrer-Policy: no-referrer`.
- The Client card renders data through React text nodes; no `dangerouslySetInnerHTML`.

### Resource limits

- Default 500 rows, 30 s query timeout, 80 retained charts, 120 retained query snapshots.
- SQLite query runs in a Worker and is terminated on timeout.
- PostgreSQL/MySQL statement timeouts are set server-side where supported; broken connections are destroyed rather than returned to the pool.
- SQL text is capped at 100 KB; inline visualization data is capped at 5,000 rows.

## Safe deployment checklist

- Create a database account with `SELECT` (and optionally `EXPLAIN`) only.
- Restrict that account to the schemas needed for analysis.
- Prefer `passwordRef`/`passwordEnv` over a literal password.
- Keep audit enabled and ship `audit.jsonl` to your normal log pipeline.
- Review the configured `database` path/host before enabling the plugin in a shared profile.
- Treat query results as sensitive business data; the plugin does not redact them.
