import { quoteIdent, qualifiedTable } from './connections.js'
import { isCategoryName, isIdName, isTemporalName, parseNumeric } from './infer.js'

function isNumericType(type) {
  return /int|numeric|decimal|float|double|real|money|number|serial/iu.test(String(type))
}

function isTemporalType(type) {
  return /date|time|timestamp|datetime|year/iu.test(String(type))
}

function isTextType(type) {
  return /char|text|string|clob|enum|set|uuid|json/iu.test(String(type))
}

function isComparableType(type) {
  return !/json|jsonb|blob|bytea|binary|array|geometry|geography/iu.test(String(type))
}

/**
 * Resolve a table by exact name, schema-qualified name, or case-insensitive name.
 * @param {any} schema schema document
 * @param {string} requested table name
 * @returns {any} table
 */
export function findTable(schema, requested) {
  const text = String(requested).trim()
  const exact = schema.tables.find((table) => `${table.schema}.${table.name}` === text || table.name === text)
  if (exact !== undefined) return exact
  const lower = text.toLowerCase()
  const matches = schema.tables.filter((table) => `${table.schema}.${table.name}`.toLowerCase() === lower || table.name.toLowerCase() === lower)
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    throw new Error(`Table "${requested}" is ambiguous. Qualify it with a schema: ${matches.map((table) => `${table.schema}.${table.name}`).join(', ')}.`)
  }
  throw new Error(`Table "${requested}" was not found. Available tables: ${schema.tables.map((table) => `${table.schema}.${table.name}`).join(', ') || '(none)'}.`)
}

/**
 * List tables without profiling data.
 * @param {any} schema schema document
 * @returns {any[]} compact table descriptions
 */
export function schemaOverview(schema) {
  return schema.tables.map((table) => ({
    name: table.name,
    schema: table.schema,
    type: table.type,
    rowEstimate: table.rowEstimate,
    columnCount: table.columns.length,
    columns: table.columns.map((column) => ({
      name: column.name,
      type: column.type || column.dbType || '',
      primaryKey: column.primaryKey === true,
      nullable: column.nullable !== false,
    })),
    foreignKeys: table.foreignKeys ?? [],
  }))
}

/**
 * Build a profile for one table or one column.
 * @param {import('./connections.js').ConnectionManager} manager connection manager
 * @param {Record<string, any>} connection connection
 * @param {{table: string, column?: string, maxColumns?: number, topValues?: number}} request profile request
 * @returns {Promise<any>} profile
 */
export async function profileTable(manager, connection, request) {
  const started = performance.now()
  const schema = await manager.getSchema(connection, { maxTables: 200 })
  const table = findTable(schema, request.table)
  const maxColumns = Number.isInteger(request.maxColumns) && request.maxColumns > 0 ? request.maxColumns : 40
  const topValues = Number.isInteger(request.topValues) && request.topValues > 0 ? request.topValues : 5
  const wanted = request.column === undefined ? table.columns : table.columns.filter((column) => {
    const lower = String(request.column).toLowerCase()
    return column.name.toLowerCase() === lower
  })
  if (request.column !== undefined && wanted.length === 0) {
    throw new Error(`Column "${request.column}" was not found in ${table.schema}.${table.name}. Columns: ${table.columns.map((column) => column.name).join(', ')}.`)
  }
  const columns = wanted.slice(0, maxColumns)
  const tableRef = qualifiedTable(connection.driver, table)
  const warnings = []
  if (wanted.length > maxColumns) warnings.push(`Profiled the first ${maxColumns} of ${wanted.length} columns.`)
  if (table.columns.length === 0) warnings.push('The schema reports no readable columns for this table.')

  let rowCount = null
  try {
    const [countResult] = await manager.runJobs(connection, [{
      sql: `SELECT COUNT(*) AS __dsh_count FROM ${tableRef}`,
      maxRows: 1,
    }], { timeoutMs: manager.config.timeoutMs })
    if (countResult?.ok === true) rowCount = Number(countResult.rows[0]?.__dsh_count ?? 0)
    else warnings.push(`Row count unavailable: ${countResult?.error?.message ?? 'query failed'}.`)
  } catch (error) {
    warnings.push(`Row count unavailable: ${error.message}.`)
  }

  const jobs = []
  const jobMeta = []
  for (const column of columns) {
    const q = quoteIdent(connection.driver, column.name)
    const type = String(column.type || column.dbType || '')
    const numeric = isNumericType(type)
    const text = isTextType(type)
    const comparable = isComparableType(type)
    const parts = [
      'COUNT(*) AS __total',
      `SUM(CASE WHEN ${q} IS NULL THEN 1 ELSE 0 END) AS __nulls`,
    ]
    if (!/json|jsonb|geometry|geography/iu.test(type)) parts.push(`COUNT(DISTINCT ${q}) AS __distinct`)
    if (comparable) {
      parts.push(`MIN(${q}) AS __min`, `MAX(${q}) AS __max`)
    }
    if (numeric) parts.push(`AVG(${q}) AS __avg`, `SUM(${q}) AS __sum`)
    const lengthExpr = connection.driver === 'postgres'
      ? `LENGTH(CAST(${q} AS TEXT))`
      : connection.driver === 'mysql'
        ? `CHAR_LENGTH(CAST(${q} AS CHAR))`
        : `LENGTH(CAST(${q} AS TEXT))`
    if (text && comparable) parts.push(`MIN(${lengthExpr}) AS __min_len`, `MAX(${lengthExpr}) AS __max_len`)
    jobs.push({
      sql: `SELECT ${parts.join(', ')} FROM ${tableRef}`,
      maxRows: 1,
      label: `stats:${column.name}`,
    })
    jobMeta.push({ kind: 'stats', column })
    if (!isIdName(column.name) && (text || isCategoryName(column.name))) {
      jobs.push({
        sql: `SELECT ${q} AS __value, COUNT(*) AS __count FROM ${tableRef} WHERE ${q} IS NOT NULL GROUP BY ${q} ORDER BY __count DESC, __value ASC LIMIT ${topValues}`,
        maxRows: topValues,
        label: `top:${column.name}`,
      })
      jobMeta.push({ kind: 'top', column })
    }
  }

  const results = jobs.length === 0 ? [] : await manager.runJobs(connection, jobs, { timeoutMs: manager.config.timeoutMs })
  const statsByColumn = new Map()
  const topByColumn = new Map()
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index]
    const meta = jobMeta[index]
    if (result?.ok !== true) {
      warnings.push(`Column ${meta.column.name}: ${result?.error?.message ?? 'profile query failed'}.`)
      continue
    }
    if (meta.kind === 'stats') statsByColumn.set(meta.column.name, result.rows[0] ?? {})
    else topByColumn.set(meta.column.name, result.rows)
  }

  const profiled = columns.map((column) => {
    const stats = statsByColumn.get(column.name) ?? {}
    const total = rowCount ?? Number(stats.__total ?? 0)
    const nullCount = Number(stats.__nulls ?? 0)
    const distinct = Number(stats.__distinct ?? 0)
    const type = String(column.type || column.dbType || '')
    const numeric = isNumericType(type)
    const temporal = isTemporalType(type) || isTemporalName(column.name)
    const category = isCategoryName(column.name)
    const id = isIdName(column.name)
    const role = temporal
      ? 'time'
      : numeric && id && total > 0 && distinct === total
        ? 'id'
        : numeric && id && distinct <= 60 && distinct < total
          ? 'dimension'
          : numeric
            ? 'measure'
            : category || (distinct > 0 && distinct <= 50)
              ? 'dimension'
              : id
                ? 'id'
                : 'text'
    const min = numeric ? parseNumeric(stats.__min) : stats.__min
    const max = numeric ? parseNumeric(stats.__max) : stats.__max
    const avg = numeric ? parseNumeric(stats.__avg) : undefined
    const sum = numeric ? parseNumeric(stats.__sum) : undefined
    const top = (topByColumn.get(column.name) ?? []).map((row) => ({
      value: row.__value,
      count: Number(row.__count ?? 0),
      share: total > 0 ? Number(row.__count ?? 0) / total : 0,
    }))
    const nullRate = total > 0 ? nullCount / total : 0
    const issues = []
    if (total === 0) issues.push('empty')
    if (nullRate > 0) issues.push(nullRate >= 0.5 ? 'mostly-null' : 'has-nulls')
    if (total > 0 && distinct === 1) issues.push('constant')
    if (role === 'text' && total > 20 && distinct / total > 0.9) issues.push('high-cardinality')
    return {
      name: column.name,
      type,
      dbType: column.dbType,
      primaryKey: column.primaryKey === true,
      nullable: column.nullable !== false,
      role,
      kind: numeric ? 'number' : temporal ? 'temporal' : 'text',
      rowCount: total,
      nullCount,
      nullRate,
      distinct,
      distinctRate: total > 0 ? distinct / total : 0,
      min,
      max,
      avg,
      sum,
      minLength: stats.__min_len === undefined ? undefined : Number(stats.__min_len),
      maxLength: stats.__max_len === undefined ? undefined : Number(stats.__max_len),
      topValues: top,
      quality: total === 0 ? 'empty' : issues.some((issue) => issue === 'mostly-null' || issue === 'constant' || issue === 'high-cardinality') ? 'watch' : issues.length > 0 ? 'good-with-notes' : 'good',
      issues,
    }
  })

  return {
    connection: connection.name,
    driver: connection.driver,
    table: { name: table.name, schema: table.schema, type: table.type },
    rowCount,
    columnCount: table.columns.length,
    profiledColumns: profiled.length,
    columns: profiled,
    warnings,
    durationMs: Math.round((performance.now() - started) * 10) / 10,
  }
}
