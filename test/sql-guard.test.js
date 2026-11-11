import test from 'node:test'
import assert from 'node:assert/strict'
import { assertReadOnly, limitSql, redactSql } from '../lib/sql-guard.js'

test('allows one read-only statement', () => {
  assert.equal(assertReadOnly('SELECT 1'), 'SELECT 1')
  assert.equal(assertReadOnly('  WITH x AS (SELECT 1) SELECT * FROM x;  '), 'WITH x AS (SELECT 1) SELECT * FROM x')
  assert.equal(assertReadOnly('EXPLAIN ANALYZE SELECT 1'), 'EXPLAIN ANALYZE SELECT 1')
  assert.equal(assertReadOnly('EXPLAIN QUERY PLAN SELECT 1'), 'EXPLAIN QUERY PLAN SELECT 1')
  assert.equal(assertReadOnly('SELECT 1; -- trailing comment'), 'SELECT 1')
})

test('ignores keywords inside strings and comments', () => {
  assert.equal(assertReadOnly("SELECT 'drop table x' AS note -- delete\nFROM t"), "SELECT 'drop table x' AS note -- delete\nFROM t")
  assert.equal(assertReadOnly("SELECT 'a; b' AS note"), "SELECT 'a; b' AS note")
})

test('rejects writes, multiple statements, and locking reads', () => {
  assert.throws(() => assertReadOnly('DELETE FROM t'), /Only SELECT/)
  assert.throws(() => assertReadOnly('WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x'), /DELETE/)
  assert.throws(() => assertReadOnly('SELECT 1; DROP TABLE t'), /one SQL statement/)
  assert.throws(() => assertReadOnly('SELECT * FROM t FOR UPDATE'), /UPDATE/)
  assert.throws(() => assertReadOnly('SELECT * FROM t LOCK IN SHARE MODE'), /Locking/)
  assert.throws(() => assertReadOnly('SELECT * INTO backup FROM t'), /INTO/)
  assert.throws(() => assertReadOnly('SELECT /*!50000 1 */'), /executable comments/)
  assert.throws(() => assertReadOnly('SELECT pg_read_file(\'/etc/passwd\')'), /pg_read_file/)
  assert.throws(() => assertReadOnly('PRAGMA table_info(t)'), /Only SELECT/)
})

test('limits a query in the database rather than in JavaScript', () => {
  assert.match(limitSql('SELECT * FROM t', 10), /LIMIT 11/)
  assert.equal(limitSql('EXPLAIN SELECT 1', 10), 'EXPLAIN SELECT 1')
})

test('redacts literals but keeps query shape', () => {
  const redacted = redactSql("SELECT * FROM users WHERE email = 'a@example.com' AND age > 21")
  assert.ok(redacted.includes('users'))
  assert.ok(!redacted.includes('a@example.com'))
  assert.ok(!redacted.includes('21'))
})
