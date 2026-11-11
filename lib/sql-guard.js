/**
 * Lexical read-only guard.
 *
 * The guard intentionally does not try to be a SQL parser. It removes comments,
 * quoted strings, quoted identifiers, and dollar-quoted bodies, then checks the
 * remaining token stream for a single statement with a read-only head and no
 * data-modifying keyword. The execution layer adds a second, independent
 * defence: every database connection is opened read-only and every query runs
 * in a read-only transaction where the dialect supports one.
 */

const MAX_SQL_BYTES = 100_000

/** Keywords that imply a write, DDL, transaction control, or privileged operation. */
const FORBIDDEN = [
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT',
  'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME',
  'GRANT', 'REVOKE',
  'VACUUM', 'ATTACH', 'DETACH', 'PRAGMA', 'REINDEX',
  'CLUSTER', 'REFRESH', 'DISCARD', 'CHECKPOINT',
  'INTO', 'OUTFILE', 'DUMPFILE',
  'KILL', 'SHUTDOWN', 'INSTALL', 'UNINSTALL',
  'OPTIMIZE', 'REPAIR', 'FLUSH', 'PURGE',
]

/** Functions that read files, sleep, or reach outside the selected database. */
const FORBIDDEN_FUNCTIONS = [
  'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file',
  'pg_terminate_backend', 'pg_cancel_backend',
  'lo_import', 'lo_export', 'dblink', 'dblink_exec',
  'pg_sleep', 'pg_sleep_for', 'pg_sleep_until',
  'load_file', 'sys_exec', 'sys_eval', 'xp_cmdshell',
  'benchmark', 'sleep',
  'load_extension', 'writefile', 'readfile', 'edit',
  'nextval', 'setval', 'pg_advisory_lock', 'pg_advisory_xact_lock',
]

const FORBIDDEN_WORDS = new Set(FORBIDDEN)

class GuardError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'SqlGuardError'
    this.code = code
  }
}

function isIdentStart(ch) {
  return /[A-Za-z_\u0080-\uFFFF]/u.test(ch)
}

function isIdentPart(ch) {
  return /[A-Za-z0-9_$\u0080-\uFFFF]/u.test(ch)
}

/**
 * Remove strings and comments while retaining keyword tokens and semicolons.
 * @param {string} sql raw SQL
 * @returns {{clean: string, redacted: string}} masked spellings
 */
function scan(sql) {
  let clean = ''
  let redacted = ''
  let i = 0
  const semicolons = []
  const push = (value, redactedValue = value) => {
    clean += value
    redacted += redactedValue
  }
  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]

    if (ch === '-' && next === '-') {
      i += 2
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i += 1
      push(' ')
      continue
    }
    if (ch === '/' && next === '*') {
      if (sql[i + 2] === '!') {
        throw new GuardError('EXECUTABLE_COMMENT', 'MySQL executable comments (/*! ... */) are not allowed in read-only queries.')
      }
      let depth = 1
      i += 2
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth += 1
          i += 2
          continue
        }
        if (sql[i] === '*' && sql[i + 1] === '/') {
          depth -= 1
          i += 2
          continue
        }
        i += 1
      }
      if (depth !== 0) throw new GuardError('UNTERMINATED_COMMENT', 'SQL contains an unterminated block comment.')
      push(' ')
      continue
    }
    if (ch === "'") {
      i += 1
      let closed = false
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2
            continue
          }
          i += 1
          closed = true
          break
        }
        i += 1
      }
      if (!closed) throw new GuardError('UNTERMINATED_STRING', 'SQL contains an unterminated string literal.')
      push(' ', '?')
      continue
    }
    if (ch === '"' || ch === '`') {
      const quote = ch
      i += 1
      let value = ''
      let closed = false
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            value += quote
            i += 2
            continue
          }
          i += 1
          closed = true
          break
        }
        value += sql[i]
        i += 1
      }
      if (!closed) throw new GuardError('UNTERMINATED_IDENTIFIER', 'SQL contains an unterminated quoted identifier.')
      push(' ', `${quote}${value}${quote}`)
      continue
    }
    if (ch === '[') {
      i += 1
      let value = ''
      while (i < sql.length && sql[i] !== ']') {
        value += sql[i]
        i += 1
      }
      if (i >= sql.length) throw new GuardError('UNTERMINATED_IDENTIFIER', 'SQL contains an unterminated [identifier].')
      i += 1
      push(' ', `[${value}]`)
      continue
    }
    if (ch === '$') {
      const rest = sql.slice(i)
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(rest)
      if (tag !== null) {
        const marker = tag[0]
        const end = sql.indexOf(marker, i + marker.length)
        if (end < 0) throw new GuardError('UNTERMINATED_STRING', 'SQL contains an unterminated dollar-quoted string.')
        i = end + marker.length
        push(' ', '?')
        continue
      }
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(next ?? ''))) {
      let start = i
      if (ch === '.') i += 1
      while (i < sql.length && /[0-9]/.test(sql[i])) i += 1
      if (sql[i] === '.') {
        i += 1
        while (i < sql.length && /[0-9]/.test(sql[i])) i += 1
      }
      if (sql[i] === 'e' || sql[i] === 'E') {
        const save = i
        i += 1
        if (sql[i] === '+' || sql[i] === '-') i += 1
        if (/[0-9]/.test(sql[i] ?? '')) {
          while (i < sql.length && /[0-9]/.test(sql[i])) i += 1
        } else {
          i = save
        }
      }
      if (i === start) i += 1
      push(sql.slice(start, i), '?')
      continue
    }
    if (isIdentStart(ch)) {
      const start = i
      i += 1
      while (i < sql.length && isIdentPart(sql[i])) i += 1
      const word = sql.slice(start, i)
      push(word)
      continue
    }
    if (ch === ';') semicolons.push(i)
    push(ch)
    i += 1
  }
  return { clean, redacted, semicolons }
}

/**
 * Check one statement for a read-only head.
 * @param {string} statement comment/string-free statement text
 * @returns {{head: string, body: string}} normalized head and body
 */
function inspectHead(statement) {
  const text = statement.trim()
  const head = /^([A-Za-z]+)/.exec(text)?.[1]?.toUpperCase()
  if (head === undefined) throw new GuardError('NOT_A_QUERY', 'SQL must start with SELECT, WITH, or EXPLAIN.')
  if (head === 'SELECT') return { head, body: text.slice(6) }
  if (head === 'WITH') {
    if (!/\bSELECT\b/iu.test(text)) {
      throw new GuardError('NOT_A_QUERY', 'A WITH statement must end in a SELECT query.')
    }
    return { head, body: text.slice(4) }
  }
  if (head === 'EXPLAIN') {
    let rest = text.slice(7).trimStart()
    const queryPlan = /^QUERY\s+PLAN\b/iu.exec(rest)
    if (queryPlan !== null) rest = rest.slice(queryPlan[0].length).trimStart()
    if (rest.startsWith('(')) {
      let depth = 0
      let index = 0
      for (; index < rest.length; index += 1) {
        if (rest[index] === '(') depth += 1
        else if (rest[index] === ')') {
          depth -= 1
          if (depth === 0) {
            index += 1
            break
          }
        }
      }
      if (depth !== 0) throw new GuardError('INVALID_EXPLAIN', 'EXPLAIN has an unbalanced option list.')
      rest = rest.slice(index).trimStart()
    }
    for (;;) {
      const option = /^(ANALYZE|ANALYSE|VERBOSE)\b/iu.exec(rest)
      if (option === null) break
      rest = rest.slice(option[0].length).trimStart()
    }
    const inner = /^([A-Za-z]+)/.exec(rest)?.[1]?.toUpperCase()
    if (inner !== 'SELECT' && inner !== 'WITH') {
      throw new GuardError('NOT_A_QUERY', 'EXPLAIN must describe a SELECT or WITH ... SELECT query.')
    }
    if (inner === 'WITH' && !/\bSELECT\b/iu.test(rest)) {
      throw new GuardError('NOT_A_QUERY', 'A WITH statement must end in a SELECT query.')
    }
    return { head, body: rest }
  }
  throw new GuardError('NOT_A_QUERY', `Only SELECT, WITH ... SELECT, and EXPLAIN are allowed; got ${head}.`)
}

/**
 * Validate one read-only query and return the exact SQL to execute.
 * @param {unknown} input model-supplied SQL
 * @returns {string} SQL with one optional trailing semicolon removed
 * @throws {GuardError} when the statement is not one read-only query
 */
export function assertReadOnly(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new GuardError('EMPTY_SQL', 'SQL is required.')
  }
  if (input.length > MAX_SQL_BYTES) {
    throw new GuardError('SQL_TOO_LARGE', `SQL exceeds the ${MAX_SQL_BYTES.toLocaleString()} character limit.`)
  }
  if (input.includes('\u0000')) {
    throw new GuardError('INVALID_SQL', 'SQL contains a NUL byte.')
  }
  const { clean, semicolons } = scan(input)
  let text = clean.trim()
  const semicolon = text.lastIndexOf(';')
  if (semicolon !== -1) {
    if (text.indexOf(';') !== semicolon) {
      throw new GuardError('MULTIPLE_STATEMENTS', 'Only one SQL statement is allowed.')
    }
    if (text.slice(semicolon + 1).trim() !== '') {
      throw new GuardError('MULTIPLE_STATEMENTS', 'Only one SQL statement is allowed.')
    }
    text = text.slice(0, semicolon).trim()
  }
  if (text === '') throw new GuardError('EMPTY_SQL', 'SQL is required.')
  const { head, body } = inspectHead(text)

  const words = body.match(/[A-Za-z_][A-Za-z0-9_$]*/g) ?? []
  for (const word of words) {
    const upper = word.toUpperCase()
    if (FORBIDDEN_WORDS.has(upper)) {
      throw new GuardError('WRITE_INTENT', `Read-only guard rejected the ${upper} keyword. Only SELECT, WITH ... SELECT, and EXPLAIN are allowed.`)
    }
  }
  if (/\bREPLACE\s+INTO\b/iu.test(body)) {
    throw new GuardError('WRITE_INTENT', 'Read-only guard rejected REPLACE INTO.')
  }

  const lower = body.toLowerCase()
  for (const name of FORBIDDEN_FUNCTIONS) {
    const pattern = new RegExp(`(^|[^a-z0-9_$])${name}\\s*\\(`, 'u')
    if (pattern.test(lower)) {
      throw new GuardError('FORBIDDEN_FUNCTION', `Read-only guard rejected the ${name}() function.`)
    }
  }
  if (/\bFOR\s+(NO\s+KEY\s+)?(UPDATE|SHARE)\b/iu.test(body) || /\bFOR\s+KEY\s+SHARE\b/iu.test(body) || /\bLOCK\s+IN\s+SHARE\s+MODE\b/iu.test(body)) {
    throw new GuardError('LOCKING_READ', 'Locking reads (FOR UPDATE / FOR SHARE / LOCK IN SHARE MODE) are not allowed.')
  }
  if (head === 'EXPLAIN' && !/^\s*(SELECT|WITH)\b/iu.test(body)) {
    throw new GuardError('NOT_A_QUERY', 'EXPLAIN must describe a SELECT or WITH ... SELECT query.')
  }
  if (semicolons.length === 1) {
    return input.slice(0, semicolons[0]).trim()
  }
  return input.trim()
}

/**
 * Redact literals for audit logs while preserving the query shape.
 * @param {string} sql raw SQL
 * @returns {string} short, literal-free SQL summary
 */
export function redactSql(sql) {
  try {
    const { redacted } = scan(String(sql))
    const flat = redacted.replace(/\s+/gu, ' ').trim()
    return flat.length > 400 ? `${flat.slice(0, 397)}...` : flat
  } catch {
    return '(unparseable SQL redacted)'
  }
}

/**
 * Wrap a SELECT so the database itself stops at the row cap.
 * EXPLAIN is left untouched because it returns a small plan.
 * @param {string} sql validated SQL
 * @param {number} maxRows positive row cap
 * @returns {string} SQL with a bounded derived table
 */
export function limitSql(sql, maxRows) {
  const limit = Math.max(1, Math.trunc(maxRows))
  const trimmed = sql.trim().replace(/;+\s*$/u, '')
  if (/^\s*EXPLAIN\b/iu.test(trimmed)) return trimmed
  return `SELECT * FROM (\n${trimmed}\n) AS __dsh_limited_q LIMIT ${limit + 1}`
}

export { GuardError }
