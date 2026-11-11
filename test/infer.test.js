import test from 'node:test'
import assert from 'node:assert/strict'
import { inferColumns } from '../lib/infer.js'

test('low-cardinality numeric keys are dimensions, high-cardinality keys stay ids', () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({
    sale_id: index + 1,
    region_id: index % 2 === 0 ? 1 : 2,
    revenue: 10 + index,
  }))
  const columns = inferColumns([
    { name: 'sale_id', type: 'INTEGER' },
    { name: 'region_id', type: 'INTEGER' },
    { name: 'revenue', type: 'REAL' },
  ], rows)
  assert.equal(columns.find((column) => column.name === 'sale_id').role, 'id')
  assert.equal(columns.find((column) => column.name === 'region_id').role, 'dimension')
  assert.equal(columns.find((column) => column.name === 'revenue').role, 'measure')
})
