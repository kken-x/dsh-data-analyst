import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'

/**
 * Convert SQLite values into JSON-safe values without losing large integers.
 * @param {unknown} value raw driver value
 * @returns {unknown} JSON-safe value
 */
function normalize(value) {
  if (typeof value === 'bigint') {
    const asNumber = Number(value)
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString()
  }
  if (value instanceof Uint8Array) return `[binary ${value.byteLength} bytes]`
  return value
}

/**
 * Execute one prepared statement with an explicit result cap.
 * @param {DatabaseSync} db open read-only database
 * @param {{sql: string, params?: unknown[], maxRows?: number}} job query job
 * @returns {{columns: {name: string, type: string}[], rows: Record<string, unknown>[], truncated: boolean}} result
 */
function runOne(db, job) {
  const statement = db.prepare(job.sql)
  try {
    statement.setReadBigInts(true)
  } catch {
    // Older SQLite builds return numbers; the normalizer still handles both.
  }
  let returnArrays = false
  try {
    statement.setReturnArrays(true)
    returnArrays = true
  } catch {
    returnArrays = false
  }
  const rawColumns = statement.columns()
  const names = []
  const seen = new Map()
  const columns = rawColumns.map((column) => {
    let name = typeof column.name === 'string' && column.name !== '' ? column.name : 'column'
    const count = seen.get(name) ?? 0
    seen.set(name, count + 1)
    if (count > 0) name = `${name}_${count + 1}`
    names.push(name)
    return { name, type: typeof column.type === 'string' ? column.type : '' }
  })
  const params = Array.isArray(job.params) ? job.params.map((value) => {
    if (value === undefined) return null
    if (typeof value === 'boolean') return value ? 1 : 0
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
    if (value !== null && typeof value === 'object' && !(value instanceof Uint8Array)) {
      try {
        return JSON.stringify(value)
      } catch {
        return String(value)
      }
    }
    return value
  }) : []
  const rawRows = statement.all(...params)
  const maxRows = Number.isInteger(job.maxRows) && job.maxRows > 0 ? job.maxRows : 500
  const truncated = rawRows.length > maxRows
  const rows = rawRows.slice(0, maxRows).map((row) => {
    if (returnArrays && Array.isArray(row)) {
      const object = {}
      for (let index = 0; index < names.length; index += 1) object[names[index]] = normalize(row[index])
      return object
    }
    const object = {}
    for (const column of rawColumns) {
      const key = typeof column.name === 'string' ? column.name : 'column'
      object[key] = normalize(row?.[key])
    }
    return object
  })
  return { columns, rows, truncated }
}

try {
  const db = new DatabaseSync(workerData.file, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 5000')
  } catch {
    // A read-only connection may reject the pragma on some builds; it is optional.
  }
  const results = []
  for (const job of workerData.queries ?? []) {
    try {
      results.push({ ok: true, ...runOne(db, job) })
    } catch (error) {
      results.push({
        ok: false,
        error: {
          code: typeof error?.code === 'string' ? error.code : 'SQLITE_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }
  db.close()
  parentPort.postMessage({ ok: true, results })
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: {
      code: typeof error?.code === 'string' ? error.code : 'SQLITE_OPEN_FAILED',
      message: error instanceof Error ? error.message : String(error),
    },
  })
}
