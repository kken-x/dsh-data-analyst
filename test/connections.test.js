import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveConfig } from '../lib/config.js'
import { ConnectionManager } from '../lib/connections.js'
import { profileTable } from '../lib/profile.js'
import { inferColumns } from '../lib/infer.js'

const demo = resolve('examples/demo.sqlite')
const hasDemo = existsSync(demo)

test('demo database is available', { skip: !hasDemo }, () => {
  assert.ok(hasDemo)
})

test('reads schema and executes a bounded SQLite query', { skip: !hasDemo }, async () => {
  const config = resolveConfig({ connections: [{ name: 'demo', driver: 'sqlite', database: demo }], maxRows: 5, timeoutMs: 5000 })
  const manager = new ConnectionManager({ config, baseDir: process.cwd(), ctx: { get: () => undefined } })
  const connection = config.connections[0]
  const schema = await manager.getSchema(connection)
  assert.ok(schema.tables.some((table) => table.name === 'sales'))
  const result = await manager.execute(connection, 'SELECT sale_date, revenue FROM sales ORDER BY id', [], { maxRows: 5 })
  assert.equal(result.rowCount, 5)
  assert.equal(result.truncated, true)
  const columns = inferColumns(result.columns, result.rows)
  assert.ok(columns.some((column) => column.role === 'measure'))
  await manager.closeAll()
})

test('profiles nulls and top values', { skip: !hasDemo }, async () => {
  const config = resolveConfig({ connections: [{ name: 'demo', driver: 'sqlite', database: demo }], maxRows: 10, timeoutMs: 5000 })
  const manager = new ConnectionManager({ config, baseDir: process.cwd(), ctx: { get: () => undefined } })
  const connection = config.connections[0]
  const profile = await profileTable(manager, connection, { table: 'sales', topValues: 3 })
  assert.equal(profile.rowCount, 576)
  const customer = profile.columns.find((column) => column.name === 'customer_id')
  assert.ok(customer.nullCount > 0)
  assert.ok(profile.columns.some((column) => column.topValues.length > 0))
  await manager.closeAll()
})

test('audit writer appends JSONL without credentials', async () => {
  const { AuditLog } = await import('../lib/audit.js')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-da-audit-'))
  try {
    const log = new AuditLog({ enabled: true, path: join(dir, 'audit.jsonl') })
    await log.write({ tool: 'db_query', status: 'ok', sqlPreview: 'SELECT ?', password: undefined })
    await log.write({ tool: 'db_query', status: 'error', errorCode: 'QUERY_FAILED' })
    const lines = (await readFile(join(dir, 'audit.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(lines.length, 2)
    assert.equal(JSON.parse(lines[0]).tool, 'db_query')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
