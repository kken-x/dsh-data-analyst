import test from 'node:test'
import assert from 'node:assert/strict'
import { jsonSafe } from '../lib/json.js'

test('removes undefined and normalizes non-JSON values', () => {
  const value = {
    a: undefined,
    b: NaN,
    c: Infinity,
    d: 1n,
    e: new Date('2026-01-02T03:04:05.000Z'),
    f: new Uint8Array([1, 2, 3]),
    g: [undefined, 2],
    h: { nested: undefined, keep: true },
  }
  const safe = jsonSafe(value)
  assert.deepEqual(safe, {
    b: null,
    c: null,
    d: 1,
    e: '2026-01-02T03:04:05.000Z',
    f: '[binary 3 bytes]',
    g: [null, 2],
    h: { keep: true },
  })
  assert.deepEqual(JSON.parse(JSON.stringify(safe)), safe)
})
