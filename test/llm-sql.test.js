import test from 'node:test'
import assert from 'node:assert/strict'
import { formatSchemaForPrompt, parseSqlResponse, generateSql } from '../lib/llm-sql.js'

const schema = {
  connection: 'demo',
  driver: 'sqlite',
  database: 'demo.sqlite',
  tables: [{
    name: 'sales',
    schema: 'main',
    type: 'table',
    columns: [
      { name: 'id', type: 'INTEGER', primaryKey: true },
      { name: 'sale_date', type: 'TEXT' },
      { name: 'revenue', type: 'REAL' },
    ],
    foreignKeys: [],
  }],
  truncated: false,
}

test('formats schema with column roles and no data', () => {
  const formatted = formatSchemaForPrompt(schema, { question: 'revenue by month', maxTables: 20, maxChars: 5000 })
  assert.match(formatted.text, /main\.sales/)
  assert.match(formatted.text, /revenue REAL/)
  assert.ok(!formatted.text.includes('21,000'))
})

test('parses fenced JSON and plain SQL rescue', () => {
  assert.deepEqual(parseSqlResponse('```json\n{"sql":"SELECT 1","title":"x"}\n```'), { sql: 'SELECT 1', title: 'x' })
  assert.equal(parseSqlResponse('SELECT 1').sql, 'SELECT 1')
})

test('generates one validated SQL from a mocked model', async () => {
  const calls = []
  const ctx = {
    get(name) {
      if (name === 'llm') {
        return {
          async *stream(options) {
            calls.push(options)
            yield { type: 'text-delta', index: 0, text: '{"sql":"SELECT substr(sale_date,1,7) AS month, SUM(revenue) AS revenue FROM sales GROUP BY month ORDER BY month","title":"Revenue trend","chartType":"line","notes":"monthly"}' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'test', model: 'test-model' }) }
      return undefined
    },
  }
  const manager = { getSchema: async () => schema }
  const result = await generateSql({
    ctx,
    config: { sqlGeneration: { enabled: true, maxOutputTokens: 500, maxSchemaTables: 20, maxSchemaChars: 5000, timeoutMs: 5000 } },
    connection: { name: 'demo', driver: 'sqlite' },
    manager,
    question: '按月看收入趋势',
    lang: 'zh',
  })
  assert.equal(result.provider, 'test')
  assert.match(result.sql, /^SELECT/)
  assert.equal(result.chartType, 'line')
  assert.equal(calls.length, 1)
})
