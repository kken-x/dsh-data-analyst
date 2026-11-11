import { Worker } from 'node:worker_threads'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { limitSql } from './sql-guard.js'
import { sanitizeError } from './audit.js'

const SCHEMA_TTL_MS = 60_000

const PG_TYPES = new Map([
  [16, 'boolean'], [17, 'bytea'], [18, 'char'], [19, 'name'], [20, 'bigint'],
  [21, 'smallint'], [23, 'integer'], [25, 'text'], [26, 'oid'], [114, 'json'],
  [700, 'real'], [701, 'double precision'], [790, 'money'], [829, 'macaddr'],
  [1042, 'char'], [1043, 'varchar'], [1082, 'date'], [1083, 'time'],
  [1114, 'timestamp'], [1184, 'timestamptz'], [1186, 'interval'],
  [1266, 'timetz'], [1700, 'numeric'], [2950, 'uuid'], [3802, 'jsonb'],
])

const MYSQL_TYPES = new Map([
  [0, 'decimal'], [1, 'tinyint'], [2, 'smallint'], [3, 'int'], [4, 'float'],
  [5, 'double'], [6, 'null'], [7, 'timestamp'], [8, 'bigint'], [9, 'mediumint'],
  [10, 'date'], [11, 'time'], [12, 'datetime'], [13, 'year'], [15, 'varchar'],
  [16, 'bit'], [245, 'json'], [246, 'newdecimal'], [247, 'enum'], [248, 'set'],
  [249, 'tinyblob'], [250, 'mediumblob'], [251, 'longblob'], [252, 'blob'],
  [253, 'var_string'], [254, 'string'], [255, 'geometry'],
])

/**
 * Make driver values JSON-safe and stable across dialects.
 * @param {unknown} value raw value
 * @returns {unknown} normalized value
 */
function normalizeValue(value) {
  if (typeof value === 'bigint') {
    const asNumber = Number(value)
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString()
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (value instanceof Uint8Array) return `[binary ${value.byteLength} bytes]`
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  if (Array.isArray(value)) return value.map(normalizeValue)
  if (value !== null && typeof value === 'object') {
    const output = {}
    for (const [key, item] of Object.entries(value)) output[key] = normalizeValue(item)
    return output
  }
  return value
}

/**
 * @param {unknown} value candidate
 * @returns {boolean} true for a plain record
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function codedError(code, message, cause) {
  const error = new Error(message)
  error.code = code
  if (cause !== undefined) error.cause = cause
  return error
}

/**
 * Quote one identifier for a dialect.
 * @param {'sqlite'|'postgres'|'mysql'} driver dialect
 * @param {string} name identifier
 * @returns {string} quoted identifier
 */
export function quoteIdent(driver, name) {
  if (driver === 'mysql') return `\`${String(name).replaceAll('`', '``')}\``
  return `"${String(name).replaceAll('"', '""')}"`
}

/**
 * Qualified table name.
 * @param {'sqlite'|'postgres'|'mysql'} driver dialect
 * @param {{schema?: string, name: string}} table table
 * @returns {string} quoted table reference
 */
export function qualifiedTable(driver, table) {
  const name = quoteIdent(driver, table.name)
  return table.schema && table.schema !== 'main' && table.schema !== 'public'
    ? `${quoteIdent(driver, table.schema)}.${name}`
    : name
}

/**
 * Resolve a configured SQLite path without inventing a path the user did not name.
 * @param {string} database raw config value
 * @param {string} baseDir workspace/profile root for relative paths
 * @returns {string} absolute file path
 */
export function resolveSqlitePath(database, baseDir) {
  let value = database.trim()
  if (value.startsWith('file:')) {
    try {
      value = fileURLToPath(value)
    } catch {
      throw codedError('INVALID_SQLITE_PATH', `Invalid file URL for SQLite database: ${database}`)
    }
  }
  if (value === '~') value = homedir()
  else if (value.startsWith('~/') || value.startsWith('~\\')) value = resolve(homedir(), value.slice(2))
  return isAbsolute(value) ? value : resolve(baseDir, value)
}

/** Lazy, read-only connection manager. */
export class ConnectionManager {
  /**
   * @param {{config: ReturnType<import('./config.js').resolveConfig>, baseDir: string, ctx: any}} options
   */
  constructor({ config, baseDir, ctx }) {
    this.config = config
    this.baseDir = baseDir
    this.ctx = ctx
    this.pools = new Map()
    this.schemaCache = new Map()
    this.secrets = new Set()
  }

  /**
   * Resolve a password without retaining it in config or logs.
   * @param {Record<string, any>} connection normalized connection
   * @returns {Promise<string>} password
   */
  async passwordFor(connection) {
    if (typeof connection.passwordRef === 'string') {
      const credentials = this.ctx.get?.('credentials')
      if (credentials === undefined) {
        throw codedError('CREDENTIALS_UNAVAILABLE', `Connection ${connection.name} uses passwordRef, but the credentials service is unavailable.`)
      }
      const resolved = await credentials.resolve(connection.passwordRef)
      if (resolved === undefined || resolved.value === '') {
        throw codedError('CREDENTIAL_MISSING', `Credential "${connection.passwordRef}" for connection ${connection.name} is not configured.`)
      }
      this.secrets.add(resolved.value)
      return resolved.value
    }
    if (typeof connection.passwordEnv === 'string') {
      const value = process.env[connection.passwordEnv]
      if (value === undefined || value === '') {
        throw codedError('CREDENTIAL_MISSING', `Environment variable ${connection.passwordEnv} for connection ${connection.name} is empty or missing.`)
      }
      this.secrets.add(value)
      return value
    }
    if (typeof connection.password === 'string') {
      this.secrets.add(connection.password)
      return connection.password
    }
    return ''
  }

  /**
   * Describe a connection without credential material.
   * @param {Record<string, any>} connection connection
   * @returns {{name: string, driver: string, database: string, host?: string}} safe description
   */
  describe(connection) {
    return {
      name: connection.name,
      driver: connection.driver,
      database: connection.database,
      ...(connection.driver === 'sqlite' ? {} : { host: connection.host }),
    }
  }

  /**
   * Resolve the row and time limits for one call.
   * @param {Record<string, any>} connection connection
   * @param {unknown} requestedRows optional per-call row cap
   * @param {unknown} requestedTimeout optional per-call timeout
   * @returns {{maxRows: number, timeoutMs: number}} limits
   */
  limits(connection, requestedRows, requestedTimeout) {
    const maxRows = Number.isInteger(requestedRows) && requestedRows > 0
      ? Math.min(requestedRows, 5000)
      : connection.maxRows ?? this.config.maxRows
    const timeoutMs = Number.isInteger(requestedTimeout) && requestedTimeout > 0
      ? Math.min(requestedTimeout, 300000)
      : connection.statementTimeoutMs ?? this.config.timeoutMs
    return { maxRows, timeoutMs }
  }

  /**
   * Execute one validated read-only query.
   * @param {Record<string, any>} connection connection
   * @param {string} sql validated SQL
   * @param {unknown[]} params bound parameters
   * @param {{maxRows?: number, timeoutMs?: number}} options limits
   * @returns {Promise<{columns: {name: string, type: string}[], rows: Record<string, unknown>[], rowCount: number, truncated: boolean, durationMs: number, maxRows: number, timeoutMs: number}>} query result
   */
  async execute(connection, sql, params = [], options = {}) {
    const { maxRows, timeoutMs } = this.limits(connection, options.maxRows, options.timeoutMs)
    const started = performance.now()
    const job = { sql: limitSql(sql, maxRows), params, maxRows }
    const [result] = await this.runJobs(connection, [job], { timeoutMs })
    const durationMs = Math.round((performance.now() - started) * 10) / 10
    if (result === undefined || result.ok !== true) {
      const error = result?.error ?? { code: 'QUERY_FAILED', message: 'The query returned no result.' }
      throw codedError(error.code ?? 'QUERY_FAILED', error.message ?? 'Query failed.')
    }
    return {
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rows.length,
      truncated: result.truncated,
      durationMs,
      maxRows,
      timeoutMs,
    }
  }

  /**
   * Execute trusted internal jobs against one connection. The caller is
   * responsible for never placing model text into these jobs.
   * @param {Record<string, any>} connection connection
   * @param {{sql: string, params?: unknown[], maxRows?: number}[]} jobs jobs
   * @param {{timeoutMs?: number}} options limits
   * @returns {Promise<Array<{ok: true, columns: {name: string, type: string}[], rows: Record<string, unknown>[], truncated: boolean} | {ok: false, error: {code: string, message: string}}>>} results in job order
   */
  async runJobs(connection, jobs, options = {}) {
    const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : this.config.timeoutMs
    if (connection.driver === 'sqlite') return this.runSqlite(connection, jobs, timeoutMs)
    if (connection.driver === 'postgres') return this.runPostgres(connection, jobs, timeoutMs)
    if (connection.driver === 'mysql') return this.runMysql(connection, jobs, timeoutMs)
    throw codedError('UNSUPPORTED_DRIVER', `Unsupported driver: ${connection.driver}`)
  }

  /**
   * Execute jobs in a worker thread so a runaway SQLite query can be terminated.
   * @param {Record<string, any>} connection connection
   * @param {{sql: string, params?: unknown[], maxRows?: number}[]} jobs jobs
   * @param {number} timeoutMs timeout
   * @returns {Promise<any[]>} results
   */
  runSqlite(connection, jobs, timeoutMs) {
    const file = resolveSqlitePath(connection.database, this.baseDir)
    if (!existsSync(file) || !statSync(file).isFile()) {
      return Promise.reject(codedError('SQLITE_NOT_FOUND', `SQLite database not found: ${file}`))
    }
    return new Promise((resolvePromise, reject) => {
      let settled = false
      const worker = new Worker(new URL('./sqlite-worker.js', import.meta.url), {
        workerData: { file, queries: jobs },
      })
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn(value)
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        worker.terminate().catch(() => {})
        reject(codedError('QUERY_TIMEOUT', `SQLite query exceeded the ${timeoutMs} ms timeout and was terminated.`))
      }, timeoutMs)
      worker.once('message', (message) => {
        if (settled) return
        worker.terminate().catch(() => {})
        if (message?.ok === true) finish(resolvePromise, message.results)
        else finish(reject, codedError(message?.error?.code ?? 'SQLITE_ERROR', message?.error?.message ?? 'SQLite worker failed.'))
      })
      worker.once('error', (error) => {
        finish(reject, codedError('SQLITE_WORKER_FAILED', `SQLite worker failed: ${error.message}`))
      })
      worker.once('exit', (code) => {
        if (settled) return
        finish(reject, codedError('SQLITE_WORKER_EXIT', `SQLite worker exited before returning a result (code ${code}).`))
      })
    })
  }

  /**
   * Lazily create and reuse one PostgreSQL pool.
   * @param {Record<string, any>} connection connection
   * @returns {Promise<any>} pg Pool
   */
  async pgPool(connection) {
    const existing = this.pools.get(connection.name)
    if (existing !== undefined) return existing
    const promise = (async () => {
      let pg
      try {
        pg = await import('pg')
      } catch (error) {
        throw codedError('DRIVER_MISSING', `PostgreSQL support requires the "pg" package: ${error.message}`)
      }
      const { Pool } = pg.default ?? pg
      const password = await this.passwordFor(connection)
      const pool = new Pool({
        host: connection.host,
        port: connection.port,
        database: connection.database,
        user: connection.user,
        password,
        ssl: connection.ssl ? { rejectUnauthorized: true } : undefined,
        max: 2,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: Math.min(5_000, this.config.timeoutMs),
        application_name: 'dsh-data-analyst',
        query_timeout: this.config.timeoutMs,
        statement_timeout: this.config.timeoutMs,
      })
      pool.on('error', (error) => {
        console.error(`[dsh-data-analyst] postgres pool error on ${connection.name}: ${sanitizeError(error, [...this.secrets]).message}`)
      })
      return pool
    })()
    this.pools.set(connection.name, promise)
    try {
      return await promise
    } catch (error) {
      this.pools.delete(connection.name)
      throw error
    }
  }

  /**
   * Run jobs in one read-only PostgreSQL transaction.
   * @param {Record<string, any>} connection connection
   * @param {{sql: string, params?: unknown[], maxRows?: number}[]} jobs jobs
   * @param {number} timeoutMs timeout
   * @returns {Promise<any[]>} results
   */
  async runPostgres(connection, jobs, timeoutMs) {
    const pool = await this.pgPool(connection)
    let client
    try {
      client = await pool.connect()
    } catch (error) {
      throw codedError('CONNECTION_FAILED', `PostgreSQL connection ${connection.name} failed: ${sanitizeError(error, [...this.secrets]).message}`)
    }
    const results = []
    let transactionOpen = false
    let failed = false
    try {
      await client.query('BEGIN READ ONLY')
      transactionOpen = true
      await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.trunc(timeoutMs))}`)
      for (const job of jobs) {
        if (failed) {
          results.push({ ok: false, error: { code: 'SKIPPED_AFTER_ERROR', message: 'Skipped after an earlier statement failed.' } })
          continue
        }
        try {
          const response = await client.query({
            text: job.sql,
            values: Array.isArray(job.params) ? job.params : [],
            query_timeout: timeoutMs,
          })
          const rows = response.rows.map((row) => normalizeValue(row))
          const maxRows = Number.isInteger(job.maxRows) && job.maxRows > 0 ? job.maxRows : rows.length
          results.push({
            ok: true,
            columns: response.fields.map((field) => ({
              name: field.name,
              type: PG_TYPES.get(field.dataTypeID) ?? `oid:${field.dataTypeID}`,
            })),
            rows: rows.slice(0, maxRows),
            truncated: rows.length > maxRows,
          })
        } catch (error) {
          const safe = sanitizeError(error, [...this.secrets])
          results.push({ ok: false, error: { code: safe.code, message: safe.message } })
          failed = true
        }
      }
      if (failed) {
        await client.query('ROLLBACK')
        transactionOpen = false
      } else {
        await client.query('COMMIT')
        transactionOpen = false
      }
      return results
    } catch (error) {
      if (transactionOpen) {
        try {
          await client.query('ROLLBACK')
        } catch {
          // The connection is already broken; releasing with destroy is enough.
        }
      }
      throw codedError('QUERY_FAILED', `PostgreSQL query failed on ${connection.name}: ${sanitizeError(error, [...this.secrets]).message}`)
    } finally {
      client.release(failed)
    }
  }

  /**
   * Lazily create and reuse one MySQL pool.
   * @param {Record<string, any>} connection connection
   * @returns {Promise<any>} mysql2 pool
   */
  async mysqlPool(connection) {
    const existing = this.pools.get(connection.name)
    if (existing !== undefined) return existing
    const promise = (async () => {
      let mysql
      try {
        mysql = await import('mysql2/promise')
      } catch (error) {
        throw codedError('DRIVER_MISSING', `MySQL support requires the "mysql2" package: ${error.message}`)
      }
      const factory = mysql.default ?? mysql
      const password = await this.passwordFor(connection)
      return factory.createPool({
        host: connection.host,
        port: connection.port,
        database: connection.database,
        user: connection.user,
        password,
        ssl: connection.ssl ? { rejectUnauthorized: true } : undefined,
        waitForConnections: true,
        connectionLimit: 2,
        queueLimit: 0,
        enableKeepAlive: true,
        dateStrings: true,
        supportBigNumbers: true,
        bigNumberStrings: true,
        decimalNumbers: false,
        multipleStatements: false,
        charset: 'utf8mb4',
      })
    })()
    this.pools.set(connection.name, promise)
    try {
      return await promise
    } catch (error) {
      this.pools.delete(connection.name)
      throw error
    }
  }

  /**
   * Run jobs in one read-only MySQL transaction.
   * @param {Record<string, any>} connection connection
   * @param {{sql: string, params?: unknown[], maxRows?: number}[]} jobs jobs
   * @param {number} timeoutMs timeout
   * @returns {Promise<any[]>} results
   */
  async runMysql(connection, jobs, timeoutMs) {
    const pool = await this.mysqlPool(connection)
    let client
    try {
      client = await pool.getConnection()
    } catch (error) {
      throw codedError('CONNECTION_FAILED', `MySQL connection ${connection.name} failed: ${sanitizeError(error, [...this.secrets]).message}`)
    }
    const results = []
    let transactionOpen = false
    let failed = false
    try {
      try {
        await client.query(`SET SESSION MAX_EXECUTION_TIME = ${Math.max(1, Math.trunc(timeoutMs))}`)
      } catch {
        try {
          await client.query(`SET SESSION max_statement_time = ${Math.max(0.1, timeoutMs / 1000)}`)
        } catch {
          // Driver-side timeout remains the backstop.
        }
      }
      await client.query('START TRANSACTION READ ONLY')
      transactionOpen = true
      for (const job of jobs) {
        if (failed) {
          results.push({ ok: false, error: { code: 'SKIPPED_AFTER_ERROR', message: 'Skipped after an earlier statement failed.' } })
          continue
        }
        try {
          const [rows, fields] = await client.query({
            sql: job.sql,
            values: Array.isArray(job.params) ? job.params : [],
            timeout: timeoutMs,
          })
          const normalized = Array.isArray(rows) ? rows.map((row) => normalizeValue(row)) : []
          const maxRows = Number.isInteger(job.maxRows) && job.maxRows > 0 ? job.maxRows : normalized.length
          results.push({
            ok: true,
            columns: Array.isArray(fields)
              ? fields.map((field) => ({
                  name: field.name,
                  type: MYSQL_TYPES.get(field.type) ?? `type:${field.type}`,
                }))
              : [],
            rows: normalized.slice(0, maxRows),
            truncated: normalized.length > maxRows,
          })
        } catch (error) {
          const safe = sanitizeError(error, [...this.secrets])
          results.push({ ok: false, error: { code: safe.code, message: safe.message } })
          failed = true
        }
      }
      if (failed) {
        await client.query('ROLLBACK')
        transactionOpen = false
      } else {
        await client.query('COMMIT')
        transactionOpen = false
      }
      return results
    } catch (error) {
      if (transactionOpen) {
        try {
          await client.query('ROLLBACK')
        } catch {
          // Connection is broken; destroy below.
        }
      }
      throw codedError('QUERY_FAILED', `MySQL query failed on ${connection.name}: ${sanitizeError(error, [...this.secrets]).message}`)
    } finally {
      if (failed) client.destroy()
      else client.release()
    }
  }

  /**
   * Load a compact schema for prompt context and profiling.
   * @param {Record<string, any>} connection connection
   * @param {{maxTables?: number, force?: boolean}} options limits
   * @returns {Promise<{connection: string, driver: string, database: string, tables: any[], truncated: boolean}>} schema
   */
  async getSchema(connection, options = {}) {
    const cached = this.schemaCache.get(connection.name)
    if (options.force !== true && cached !== undefined && Date.now() - cached.at < SCHEMA_TTL_MS) {
      return this.capSchema(cached.value, options.maxTables)
    }
    const schema = connection.driver === 'sqlite'
      ? await this.loadSqliteSchema(connection)
      : connection.driver === 'postgres'
        ? await this.loadPostgresSchema(connection)
        : await this.loadMysqlSchema(connection)
    this.schemaCache.set(connection.name, { at: Date.now(), value: schema })
    return this.capSchema(schema, options.maxTables)
  }

  /**
   * @param {any} schema full schema
   * @param {number|undefined} maxTables cap
   * @returns {any} capped schema
   */
  capSchema(schema, maxTables) {
    const limit = Number.isInteger(maxTables) && maxTables > 0 ? maxTables : schema.tables.length
    if (schema.tables.length <= limit) return schema
    return { ...schema, tables: schema.tables.slice(0, limit), truncated: true }
  }

  /**
   * Invalidate one schema cache entry.
   * @param {string} name connection name
   * @returns {void}
   */
  invalidateSchema(name) {
    this.schemaCache.delete(name)
  }

  /**
   * @param {Record<string, any>} connection connection
   * @returns {Promise<any>} schema
   */
  async loadSqliteSchema(connection) {
    const file = resolveSqlitePath(connection.database, this.baseDir)
    const tablesResult = await this.runJobs(connection, [{
      sql: "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 500",
      maxRows: 500,
    }], { timeoutMs: this.config.timeoutMs })
    const listed = tablesResult[0]
    if (listed?.ok !== true) throw codedError('SCHEMA_FAILED', listed?.error?.message ?? 'Could not list SQLite tables.')
    const jobs = []
    for (const row of listed.rows) {
      const name = String(row.name)
      jobs.push({ sql: `PRAGMA table_info(${quoteIdent('sqlite', name)})`, maxRows: 500, table: name })
      jobs.push({ sql: `PRAGMA foreign_key_list(${quoteIdent('sqlite', name)})`, maxRows: 500, table: name })
    }
    const details = await this.runJobs(connection, jobs, { timeoutMs: this.config.timeoutMs })
    const tables = []
    for (let index = 0; index < listed.rows.length; index += 1) {
      const row = listed.rows[index]
      const info = details[index * 2]
      const fks = details[index * 2 + 1]
      const foreignKeys = fks?.ok === true
        ? fks.rows.map((fk) => ({
            column: String(fk.from),
            refTable: String(fk.table),
            refColumn: String(fk.to ?? ''),
          }))
        : []
      tables.push({
        name: String(row.name),
        schema: 'main',
        type: String(row.type) === 'view' ? 'view' : 'table',
        columns: info?.ok === true
          ? info.rows.map((column) => ({
              name: String(column.name),
              type: String(column.type ?? ''),
              nullable: Number(column.notnull) === 0,
              primaryKey: Number(column.pk) > 0,
              default: column.dflt_value ?? null,
            }))
          : [],
        foreignKeys,
      })
    }
    return { connection: connection.name, driver: connection.driver, database: file, tables, truncated: false }
  }

  /**
   * @param {Record<string, any>} connection connection
   * @returns {Promise<any>} schema
   */
  async loadPostgresSchema(connection) {
    const jobs = [
      {
        sql: `SELECT table_schema, table_name, table_type
              FROM information_schema.tables
              WHERE table_schema NOT IN ('pg_catalog','information_schema')
              ORDER BY table_schema, table_name
              LIMIT 500`,
        maxRows: 500,
      },
      {
        sql: `SELECT table_schema, table_name, column_name, data_type, udt_name, is_nullable, column_default
              FROM information_schema.columns
              WHERE table_schema NOT IN ('pg_catalog','information_schema')
              ORDER BY table_schema, table_name, ordinal_position
              LIMIT 10000`,
        maxRows: 10000,
      },
      {
        sql: `SELECT tc.table_schema, tc.table_name, kcu.column_name, tc.constraint_type,
                     ccu.table_schema AS foreign_table_schema,
                     ccu.table_name AS foreign_table_name,
                     ccu.column_name AS foreign_column_name
              FROM information_schema.table_constraints AS tc
              JOIN information_schema.key_column_usage AS kcu
                ON kcu.constraint_name = tc.constraint_name
               AND kcu.constraint_schema = tc.constraint_schema
               AND kcu.table_schema = tc.table_schema
               AND kcu.table_name = tc.table_name
              LEFT JOIN information_schema.constraint_column_usage AS ccu
                ON ccu.constraint_name = tc.constraint_name
               AND ccu.constraint_schema = tc.constraint_schema
              WHERE tc.constraint_type IN ('PRIMARY KEY','FOREIGN KEY')
              ORDER BY tc.table_schema, tc.table_name, kcu.ordinal_position
              LIMIT 10000`,
        maxRows: 10000,
      },
    ]
    const results = await this.runJobs(connection, jobs, { timeoutMs: this.config.timeoutMs })
    for (const result of results) {
      if (result.ok !== true) throw codedError('SCHEMA_FAILED', result.error?.message ?? 'Could not read the PostgreSQL schema.')
    }
    const [tableRows, columnRows, keyRows] = results
    const byKey = new Map()
    for (const row of tableRows.rows) {
      const key = `${row.table_schema}.${row.table_name}`
      byKey.set(key, {
        name: String(row.table_name),
        schema: String(row.table_schema),
        type: String(row.table_type) === 'VIEW' ? 'view' : 'table',
        columns: [],
        foreignKeys: [],
      })
    }
    for (const row of columnRows.rows) {
      const table = byKey.get(`${row.table_schema}.${row.table_name}`)
      if (table === undefined) continue
      table.columns.push({
        name: String(row.column_name),
        type: String(row.data_type),
        dbType: String(row.udt_name),
        nullable: row.is_nullable === 'YES',
        primaryKey: false,
        default: row.column_default ?? null,
      })
    }
    for (const row of keyRows.rows) {
      const table = byKey.get(`${row.table_schema}.${row.table_name}`)
      if (table === undefined) continue
      if (row.constraint_type === 'PRIMARY KEY') {
        const column = table.columns.find((item) => item.name === row.column_name)
        if (column !== undefined) column.primaryKey = true
      } else if (row.foreign_table_name != null) {
        table.foreignKeys.push({
          column: String(row.column_name),
          refSchema: String(row.foreign_table_schema),
          refTable: String(row.foreign_table_name),
          refColumn: String(row.foreign_column_name),
        })
      }
    }
    return { connection: connection.name, driver: connection.driver, database: connection.database, tables: [...byKey.values()], truncated: false }
  }

  /**
   * @param {Record<string, any>} connection connection
   * @returns {Promise<any>} schema
   */
  async loadMysqlSchema(connection) {
    const jobs = [
      {
        sql: `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, TABLE_ROWS
              FROM information_schema.TABLES
              WHERE TABLE_SCHEMA = ?
              ORDER BY TABLE_NAME
              LIMIT 500`,
        params: [connection.database],
        maxRows: 500,
      },
      {
        sql: `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE,
                     IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, ORDINAL_POSITION
              FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = ?
              ORDER BY TABLE_NAME, ORDINAL_POSITION
              LIMIT 10000`,
        params: [connection.database],
        maxRows: 10000,
      },
      {
        sql: `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, CONSTRAINT_NAME,
                     REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
              FROM information_schema.KEY_COLUMN_USAGE
              WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
              ORDER BY TABLE_NAME, ORDINAL_POSITION
              LIMIT 10000`,
        params: [connection.database],
        maxRows: 10000,
      },
    ]
    const results = await this.runJobs(connection, jobs, { timeoutMs: this.config.timeoutMs })
    for (const result of results) {
      if (result.ok !== true) throw codedError('SCHEMA_FAILED', result.error?.message ?? 'Could not read the MySQL schema.')
    }
    const [tableRows, columnRows, keyRows] = results
    const byKey = new Map()
    for (const row of tableRows.rows) {
      const key = `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`
      byKey.set(key, {
        name: String(row.TABLE_NAME),
        schema: String(row.TABLE_SCHEMA),
        type: String(row.TABLE_TYPE) === 'VIEW' ? 'view' : 'table',
        rowEstimate: Number(row.TABLE_ROWS ?? 0),
        columns: [],
        foreignKeys: [],
      })
    }
    for (const row of columnRows.rows) {
      const table = byKey.get(`${row.TABLE_SCHEMA}.${row.TABLE_NAME}`)
      if (table === undefined) continue
      table.columns.push({
        name: String(row.COLUMN_NAME),
        type: String(row.DATA_TYPE),
        dbType: String(row.COLUMN_TYPE),
        nullable: row.IS_NULLABLE === 'YES',
        primaryKey: row.COLUMN_KEY === 'PRI',
        default: row.COLUMN_DEFAULT ?? null,
      })
    }
    for (const row of keyRows.rows) {
      const table = byKey.get(`${row.TABLE_SCHEMA}.${row.TABLE_NAME}`)
      if (table === undefined) continue
      table.foreignKeys.push({
        column: String(row.COLUMN_NAME),
        refSchema: String(row.REFERENCED_TABLE_SCHEMA),
        refTable: String(row.REFERENCED_TABLE_NAME),
        refColumn: String(row.REFERENCED_COLUMN_NAME),
      })
    }
    return { connection: connection.name, driver: connection.driver, database: connection.database, tables: [...byKey.values()], truncated: false }
  }

  /**
   * Close every cached pool.
   * @returns {Promise<void>} settles after all closers
   */
  async closeAll() {
    const pools = [...this.pools.values()]
    this.pools.clear()
    this.schemaCache.clear()
    for (const entry of pools) {
      try {
        const pool = await entry
        await pool.end?.()
      } catch {
        // A failed pool has nothing to close.
      }
    }
  }
}

export { normalizeValue, isRecord }
