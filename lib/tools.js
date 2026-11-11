import { randomUUID } from 'node:crypto'
import { assertReadOnly, redactSql } from './sql-guard.js'
import { hashSql, sanitizeError } from './audit.js'
import { jsonSafe } from './json.js'
import { selectConnection } from './config.js'
import { generateSql } from './llm-sql.js'
import { buildChart, CHART_TYPES, renderMarkdownTable } from './chart.js'
import {
  formatCell,
  formatNumber,
  formatPercent,
  inferColumns,
  languageOf,
  observationsFor,
  parseNumeric,
} from './infer.js'

const TOOL_TIMEOUT_MS = 180_000

export class MemoryStore {
  constructor({ ttlMs, max }) {
    this.ttlMs = ttlMs
    this.max = max
    this.map = new Map()
  }

  put(value) {
    const id = randomUUID().replaceAll('-', '')
    const now = Date.now()
    this.map.set(id, { at: now, value })
    this.trim(now)
    return id
  }

  get(id) {
    const entry = this.map.get(id)
    if (entry === undefined) return undefined
    if (Date.now() - entry.at > this.ttlMs) {
      this.map.delete(id)
      return undefined
    }
    return entry.value
  }

  trim(now = Date.now()) {
    for (const [key, entry] of this.map) {
      if (now - entry.at > this.ttlMs) this.map.delete(key)
    }
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      this.map.delete(oldest)
    }
  }
}

/**
 * @param {any} value unknown
 * @param {string} name field name
 * @returns {string} trimmed string
 */
function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a non-empty string.`)
  return value.trim()
}

/**
 * @param {unknown} value optional string
 * @returns {string|undefined} trimmed string
 */
function optionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * @param {unknown} value candidate
 * @returns {unknown[]} parameter array
 */
function optionalParams(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('params must be an array of bound values.')
  if (value.length > 1000) throw new Error('params is limited to 1000 values.')
  return value
}

function codeFence(sql) {
  const fence = sql.includes('```') ? '````' : '```'
  return `${fence}sql\n${sql}\n${fence}`
}

function markerFor(meta) {
  try {
    const json = JSON.stringify(meta)
    return `<!--dsh-data-analyst:${Buffer.from(json, 'utf8').toString('base64url')}-->`
  } catch {
    return ''
  }
}

function subtitleFor(connectionName, result, lang) {
  const truncated = result.truncated ? (lang === 'zh' ? ' · 已截断' : ' · capped') : ''
  return lang === 'zh'
    ? `${connectionName} · ${result.rowCount} 行${truncated} · ${result.durationMs} ms · 只读`
    : `${connectionName} · ${result.rowCount} rows${truncated} · ${result.durationMs} ms · read-only`
}

function tableSubtitle(connectionName, rowCount, truncated, durationMs, lang) {
  const cap = truncated ? (lang === 'zh' ? ' · 已截断' : ' · capped') : ''
  return lang === 'zh'
    ? `${connectionName} · ${rowCount} 行${cap} · ${durationMs} ms · 只读`
    : `${connectionName} · ${rowCount} rows${cap} · ${durationMs} ms · read-only`
}

function bullets(observations) {
  return observations.map((line) => `- ${line}`).join('\n')
}

/**
 * Render the model-visible Markdown for a chart result.
 * @param {any} chart built chart
 * @param {{sql: string, meta: any, observations: string[], lang: 'en'|'zh'}} context context
 * @returns {string} Markdown
 */
function renderChartMarkdown(chart, context) {
  const { sql, meta, observations, lang } = context
  const image = chart.svg === null
    ? chart.markdownTable ?? ''
    : `![${chart.type} chart: ${chart.title}](${meta.url})`
  const note = chart.note === undefined ? '' : `\n> ${chart.note}\n`
  const rowsLabel = lang === 'zh' ? '行' : 'rows'
  const cappedLabel = lang === 'zh' ? '（已截断）' : ' (capped)'
  const sqlSection = sql === ''
    ? []
    : [`**SQL** · ${meta.connection} · ${meta.rows} ${rowsLabel}${meta.truncated ? cappedLabel : ''}`, codeFence(sql)]
  return [
    `**${chart.title}**`,
    '',
    image,
    note,
    '**What the data says**',
    bullets(observations),
    '',
    ...sqlSection,
    markerFor(meta),
  ].filter((part) => part !== '').join('\n')
}

/**
 * Register the four data-analyst tools.
 * @param {{ctx: any, config: any, manager: any, audit: any, chartStore: MemoryStore, queryStore: MemoryStore, chartUrl: (id: string) => string}} dependencies dependencies
 * @returns {void}
 */
export function registerTools({ ctx, config, manager, audit, chartStore, queryStore, chartUrl }) {
  /**
   * @param {string} tool tool name
   * @param {Record<string, unknown>} args arguments
   * @param {any} exec execution context
   * @param {{connection?: string, sql?: string, sqlSource?: string}} initial audit fields
   * @param {() => Promise<any>} run operation
   * @returns {Promise<any>} operation result
   */
  async function audited(tool, args, exec, initial, run) {
    const started = performance.now()
    const base = () => ({
      tool,
      sessionId: exec.agent?.id,
      connection: initial.connection,
      sqlSource: initial.sqlSource,
      ...(typeof initial.sql === 'string' ? { sqlHash: hashSql(initial.sql), sqlPreview: redactSql(initial.sql) } : {}),
    })
    try {
      const result = await run()
      const safe = jsonSafe(result)
      await audit.write({
        ...base(),
        status: 'ok',
        rowCount: safe?.rowCount,
        durationMs: Math.round((performance.now() - started) * 10) / 10,
        truncated: safe?.truncated === true,
        chartType: safe?.chart?.type,
      })
      return safe
    } catch (error) {
      await audit.write({
        ...base(),
        status: 'error',
        durationMs: Math.round((performance.now() - started) * 10) / 10,
        errorCode: typeof error?.code === 'string' ? error.code : 'TOOL_ERROR',
      })
      throw error
    }
  }

  function storeQuery(exec, payload) {
    return queryStore.put({
      agentId: exec.agent?.id,
      ...payload,
      at: Date.now(),
    })
  }

  function buildResultChart({ connectionName, result, columns, title, chartType, lang, truncated }) {
    const chart = buildChart(columns, result.rows, {
      chartType,
      title,
      subtitle: subtitleFor(connectionName, { ...result, truncated }, lang),
      width: config.chart.width,
      height: config.chart.height,
      lang,
      maxCategories: config.chart.maxCategories,
    })
    let url = null
    let id = null
    if (chart.svg !== null) {
      id = chartStore.put({ svg: chart.svg, type: chart.type, title: chart.title, at: Date.now() })
      url = chartUrl(id)
    }
    return { chart, url, id }
  }

  function chartValue({ chart, url, id, connectionName, result, inferredColumns, sql, observations, truncated, lang, title, notes, sqlSource, queryId }) {
    return {
      ok: true,
      connection: connectionName,
      title: title ?? chart.title,
      sql,
      sqlSource,
      columns: (inferredColumns ?? result.columns ?? []).map((column) => ({ name: column.name, type: column.type ?? '', role: column.role, numeric: column.numeric })),
      rows: result.rows ?? [],
      rowCount: result.rowCount ?? (result.rows ?? []).length,
      truncated: truncated === true,
      durationMs: result.durationMs ?? 0,
      chart: {
        type: chart.type,
        title: chart.title,
        url: url ?? '',
        reason: chart.reason,
        ...(chart.note === undefined ? {} : { note: chart.note }),
        ...(chart.svg === null ? { markdownTable: chart.markdownTable ?? '' } : {}),
      },
      observations,
      ...(notes ? { notes } : {}),
      ...(id === null ? {} : { chartId: id }),
      queryId,
    }
  }

  // ---------------------------------------------------------------------------
  // db_analyze
  // ---------------------------------------------------------------------------
  ctx.tools.register({
    name: 'db_analyze',
    description: [
      'One-call conversational analytics. Give a natural-language question about a configured database; the plugin inspects the live schema, writes one read-only SELECT (unless you pass `sql`), executes it with a hard row/time cap, profiles the result, chooses the best chart, and returns an inline SVG plus short observations.',
      'Use this FIRST for any count, trend, comparison, distribution, top-N, percentage, or anomaly question. Do not manually chain db_profile + db_query + db_visualize.',
      'Prefer passing only `question` and `connection`. Pass `sql` only when you already have a single read-only SELECT; pass `tables` to focus SQL generation on a large schema. The plugin never writes to the database.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        question: { type: 'string', description: 'The user\'s data question, in their own language.' },
        connection: { type: 'string', description: 'Configured connection name. Omit when there is one connection or a default.' },
        sql: { type: 'string', description: 'Optional single SELECT/WITH/EXPLAIN override. Omit to let the plugin draft SQL from the question.' },
        params: { type: 'array', items: {}, description: 'Optional bound values for placeholders in `sql` (? or $1).' },
        tables: { type: 'array', items: { type: 'string' }, description: 'Optional table names to focus schema context on.' },
        chartType: { type: 'string', enum: CHART_TYPES, description: 'Optional chart override; auto by default.' },
        title: { type: 'string', description: 'Optional chart title in the user\'s language.' },
        maxRows: { type: 'integer', minimum: 1, maximum: 5000, description: 'Optional row cap for this call.' },
      },
      required: ['question'],
    },
    output: {
      schema: analysisOutputSchema(),
      render: (_args, value) => [{ type: 'text', text: value.markdown ?? 'Analysis complete.' }],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      title: 'Analyze data',
      kind: 'read',
      rawInput: { question: args?.question, connection: args?.connection },
    }),
    async execute(args, exec) {
      const question = requireString(args?.question, 'question')
      const connection = selectConnection(config, args?.connection)
      const lang = languageOf(question)
      const started = performance.now()
      const auditMeta = { connection: connection.name }
      return audited('db_analyze', args ?? {}, exec, auditMeta, async () => {
        let sql
        let sqlSource
        let generated
        if (typeof args?.sql === 'string' && args.sql.trim() !== '') {
          sql = assertReadOnly(args.sql)
          sqlSource = 'caller'
        } else {
          generated = await generateSql({
            ctx,
            config,
            connection,
            manager,
            question,
            tables: Array.isArray(args?.tables) ? args.tables : undefined,
            lang,
            signal: exec.signal,
            sessionId: exec.agent?.id,
          })
          sql = generated.sql
          sqlSource = 'model'
        }
        auditMeta.sql = sql
        auditMeta.sqlSource = sqlSource
        const params = optionalParams(args?.params)
        const result = await manager.execute(connection, sql, params, { maxRows: args?.maxRows })
        const columns = inferColumns(result.columns, result.rows)
        const title = optionalString(args?.title) ?? generated?.title ?? question.slice(0, 72)
        const requested = typeof args?.chartType === 'string' && args.chartType !== 'auto' && CHART_TYPES.includes(args.chartType)
          ? args.chartType
          : generated?.chartType ?? 'auto'
        const { chart, url, id } = buildResultChart({
          connectionName: connection.name,
          result,
          columns,
          title,
          chartType: requested,
          lang,
          truncated: result.truncated,
        })
        const observations = observationsFor(columns, result.rows, lang, { truncated: result.truncated, maxRows: result.maxRows })
        const queryId = storeQuery(exec, {
          connection: connection.name,
          sql,
          columns,
          rows: result.rows,
          rowCount: result.rowCount,
          truncated: result.truncated,
          durationMs: result.durationMs,
          maxRows: result.maxRows,
          title,
          chartType: chart.type,
        })
        const meta = {
          v: 1,
          kind: 'chart',
          title: chart.title,
          chartType: chart.type,
          url: url ?? '',
          rows: result.rowCount,
          truncated: result.truncated,
          durationMs: result.durationMs,
          connection: connection.name,
          sql,
          lang,
          observations,
          ...(generated?.notes ? { notes: generated.notes } : {}),
        }
        const markdown = `${renderChartMarkdown(chart, { sql, meta, observations, lang })}\n\nQuery ID: \`${queryId}\` — pass it to \`db_visualize\` to re-render with another chart type.`
        return {
          ...chartValue({ chart, url, id, connectionName: connection.name, result, inferredColumns: columns, sql, observations, truncated: result.truncated, lang, title, notes: generated?.notes, sqlSource, queryId }),
          markdown,
          chartType: chart.type,
          reason: chart.reason,
          elapsedMs: Math.round((performance.now() - started) * 10) / 10,
        }
      })
    },
  })

  // ---------------------------------------------------------------------------
  // db_profile
  // ---------------------------------------------------------------------------
  ctx.tools.register({
    name: 'db_profile',
    description: [
      'Profile a database before or during analysis. With no table, return the configured connections and table/column map (use this to discover schema). With a table, return row count, per-column null rate, distinct count, min/max/avg, top values, and inferred roles (time, measure, dimension, id).',
      'Use it when the user asks about data quality, when you need to choose dimensions/measures, or when db_analyze reports an unknown column. It never modifies data.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        connection: { type: 'string', description: 'Configured connection name. Omit for the default.' },
        table: { type: 'string', description: 'Table to profile. Omit to list tables and columns.' },
        column: { type: 'string', description: 'Optional single column to profile.' },
        maxColumns: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum columns to profile.' },
        topValues: { type: 'integer', minimum: 1, maximum: 20, description: 'Number of top values for categorical columns.' },
      },
    },
    output: {
      schema: profileOutputSchema(),
      render: (_args, value) => [{ type: 'text', text: value.markdown ?? 'Profile complete.' }],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      title: args?.table ? `Profile ${args.table}` : 'Profile database',
      kind: 'read',
      rawInput: args,
    }),
    async execute(args, exec) {
      const connection = selectConnection(config, args?.connection)
      const lang = languageOf(args?.table ?? args?.connection ?? '')
      return audited('db_profile', args ?? {}, exec, { connection: connection.name }, async () => {
        if (optionalString(args?.table) === undefined) {
          const schema = await manager.getSchema(connection, { maxTables: 200, force: true })
          const tables = schema.tables.map((table) => ({
            name: table.name,
            schema: table.schema,
            type: table.type,
            columnCount: table.columns.length,
            columns: table.columns.map((column) => ({
              name: column.name,
              type: column.type || column.dbType || '',
              primaryKey: column.primaryKey === true,
              nullable: column.nullable !== false,
            })),
            foreignKeys: table.foreignKeys,
          }))
          const lines = [
            `**Database schema · ${connection.name}**`,
            '',
            `Driver: ${connection.driver} · Database: ${connection.database} · Tables: ${tables.length}${schema.truncated ? ' (capped)' : ''}`,
            '',
            ...tables.map((table) => {
              const keys = table.columns.filter((column) => column.primaryKey).map((column) => column.name)
              return `- \`${table.schema}.${table.name}\` (${table.type}, ${table.columnCount} columns${keys.length > 0 ? `, PK: ${keys.join(', ')}` : ''})\n  ${table.columns.map((column) => `${column.name} ${column.type || '?'}${column.primaryKey ? ' PK' : ''}`).join(', ')}`
            }),
          ]
          const markdown = lines.join('\n') + (tables.length === 0 ? '\n\n_No user tables were found._' : '')
          return {
            ok: true,
            connection: connection.name,
            mode: 'schema',
            driver: connection.driver,
            database: connection.database,
            tables,
            tableCount: tables.length,
            markdown,
          }
        }
        const { profileTable } = await import('./profile.js')
        const profile = await profileTable(manager, connection, {
          table: optionalString(args?.table),
          column: optionalString(args?.column),
          maxColumns: args?.maxColumns,
          topValues: args?.topValues ?? config.profile.topValues,
        })
        const lines = [
          `**Profile · ${profile.table.schema}.${profile.table.name}**`,
          '',
          `Rows: ${profile.rowCount === null ? 'unknown' : formatNumber(profile.rowCount, lang)} · Columns profiled: ${profile.profiledColumns}/${profile.columnCount} · ${profile.durationMs} ms · read-only`,
          '',
          '| Column | Type | Role | Nulls | Distinct | Min | Max | Avg |',
          '| --- | --- | --- | ---: | ---: | --- | --- | ---: |',
          ...profile.columns.map((column) => `| ${column.name} | ${column.type || ''} | ${column.role} | ${formatPercent(column.nullRate, lang)} | ${formatNumber(column.distinct, lang)} | ${formatCell(column.min, lang)} | ${formatCell(column.max, lang)} | ${column.avg === undefined ? '—' : formatNumber(column.avg, lang)} |`),
        ]
        const withTop = profile.columns.filter((column) => column.topValues.length > 0)
        if (withTop.length > 0) {
          lines.push('', '**Top values**')
          for (const column of withTop.slice(0, 6)) {
            lines.push(`- \`${column.name}\`: ${column.topValues.map((item) => `${formatCell(item.value, lang)} (${formatNumber(item.count, lang)})`).join(', ')}`)
          }
        }
        if (profile.warnings.length > 0) {
          lines.push('', '**Warnings**', ...profile.warnings.map((warning) => `- ${warning}`))
        }
        return {
          ok: true,
          connection: connection.name,
          mode: 'table',
          ...profile,
          markdown: lines.join('\n'),
        }
      })
    },
  })

  // ---------------------------------------------------------------------------
  // db_query
  // ---------------------------------------------------------------------------
  ctx.tools.register({
    name: 'db_query',
    description: [
      'Execute exactly one read-only SELECT/WITH/EXPLAIN against a configured connection, with optional bound parameters, a hard row cap, a timeout, and an audit record. Returns rows, columns, `queryId`, and a compact table.',
      'Use this only when the user explicitly provides SQL or when you need raw rows that db_analyze does not expose. For natural-language questions use db_analyze; for a chart on an existing result use db_visualize with the returned queryId.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sql: { type: 'string', description: 'One SELECT, WITH ... SELECT, or EXPLAIN statement.' },
        connection: { type: 'string', description: 'Configured connection name. Omit for the default.' },
        params: { type: 'array', items: {}, description: 'Optional bound values for placeholders.' },
        maxRows: { type: 'integer', minimum: 1, maximum: 5000, description: 'Optional row cap.' },
        timeoutMs: { type: 'integer', minimum: 500, maximum: 300000, description: 'Optional timeout in milliseconds.' },
      },
      required: ['sql'],
    },
    output: {
      schema: queryOutputSchema(),
      render: (_args, value) => [{ type: 'text', text: value.markdown ?? 'Query complete.' }],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: 'Run read-only SQL', kind: 'read', rawInput: { connection: args?.connection } }),
    async execute(args, exec) {
      const connection = selectConnection(config, args?.connection)
      const auditMeta = { connection: connection.name }
      return audited('db_query', args ?? {}, exec, auditMeta, async () => {
        const sql = assertReadOnly(args?.sql)
        auditMeta.sql = sql
        auditMeta.sqlSource = 'caller'
        const params = optionalParams(args?.params)
        const result = await manager.execute(connection, sql, params, { maxRows: args?.maxRows, timeoutMs: args?.timeoutMs })
        const columns = inferColumns(result.columns, result.rows)
        const lang = languageOf(sql)
        const queryId = storeQuery(exec, {
          connection: connection.name,
          sql,
          columns,
          rows: result.rows,
          rowCount: result.rowCount,
          truncated: result.truncated,
          durationMs: result.durationMs,
          maxRows: result.maxRows,
        })
        const markdown = [
          `**Query result · ${connection.name}**`,
          '',
          tableSubtitle(connection.name, result.rowCount, result.truncated, result.durationMs, lang),
          '',
          renderMarkdownTable(columns, result.rows, { lang, maxRows: 20 }),
          '',
          codeFence(sql),
          '',
          `Query ID: \`${queryId}\` — pass it to \`db_visualize\` to render this result.`,
        ].join('\n')
        return {
          ok: true,
          connection: connection.name,
          sql,
          columns: columns.map((column) => ({ name: column.name, type: column.type, role: column.role, numeric: column.numeric })),
          rows: result.rows,
          rowCount: result.rowCount,
          truncated: result.truncated,
          durationMs: result.durationMs,
          maxRows: result.maxRows,
          queryId,
          markdown,
        }
      })
    },
  })

  // ---------------------------------------------------------------------------
  // db_visualize
  // ---------------------------------------------------------------------------
  ctx.tools.register({
    name: 'db_visualize',
    description: [
      'Render an existing result as an inline SVG chart. Supply a `queryId` returned by db_analyze/db_query, or an explicit read-only `sql`, or inline `data`. The chart type is chosen automatically from the result shape; pass `chartType` to override.',
      'Use it to switch a previous result from bar to line/pie, or to visualize SQL the user already approved. It is read-only and never changes the underlying data.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        queryId: { type: 'string', description: 'Result id returned by db_analyze or db_query.' },
        sql: { type: 'string', description: 'Alternative: one read-only SELECT to execute and render.' },
        connection: { type: 'string', description: 'Connection for `sql`; omit for the default.' },
        data: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Alternative: inline rows as objects.' },
        columns: { type: 'array', items: { type: 'string' }, description: 'Optional column names for array-shaped inline data.' },
        params: { type: 'array', items: {}, description: 'Optional bound values for `sql`.' },
        chartType: { type: 'string', enum: CHART_TYPES, description: 'Chart override; auto by default.' },
        title: { type: 'string', description: 'Optional chart title.' },
        maxRows: { type: 'integer', minimum: 1, maximum: 5000, description: 'Optional row cap for `sql`.' },
      },
    },
    output: {
      schema: visualizationOutputSchema(),
      render: (_args, value) => [{ type: 'text', text: value.markdown ?? 'Chart rendered.' }],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: 'Visualize data', kind: 'read', rawInput: { queryId: args?.queryId, connection: args?.connection } }),
    async execute(args, exec) {
      const auditMeta = {}
      return audited('db_visualize', args ?? {}, exec, auditMeta, async () => {
        let connection
        let sql = typeof args?.sql === 'string' ? args.sql : undefined
        let result
        let columns
        let queryId = optionalString(args?.queryId)
        let sourceLabel = 'inline'
        let sqlSource = 'inline'
        let lang = languageOf(args?.title ?? '')
        if (queryId !== undefined) {
          const cached = queryStore.get(queryId)
          if (cached === undefined || (cached.agentId !== undefined && exec.agent?.id !== undefined && cached.agentId !== exec.agent.id)) {
            throw new Error(`Unknown or expired queryId "${queryId}". Run db_query or db_analyze again, or pass sql/data.`)
          }
          connection = config.byName.get(cached.connection) ?? { name: cached.connection }
          result = {
            columns: cached.columns,
            rows: cached.rows,
            rowCount: cached.rowCount,
            truncated: cached.truncated,
            durationMs: cached.durationMs,
            maxRows: cached.maxRows,
          }
          columns = cached.columns
          sql = cached.sql
          sourceLabel = cached.connection
          sqlSource = 'reuse'
          lang = languageOf(cached.title ?? args?.title ?? '')
        } else if (sql !== undefined) {
          connection = selectConnection(config, args?.connection)
          const safeSql = assertReadOnly(sql)
          sql = safeSql
          sqlSource = 'caller'
          const params = optionalParams(args?.params)
          result = await manager.execute(connection, safeSql, params, { maxRows: args?.maxRows })
          columns = inferColumns(result.columns, result.rows)
          sourceLabel = connection.name
          lang = languageOf(args?.title ?? '')
        } else if (Array.isArray(args?.data)) {
          const rows = normalizeInlineRows(args.data, Array.isArray(args?.columns) ? args.columns : undefined)
          const inferred = inferColumns(inferInlineColumns(rows), rows)
          columns = inferred
          result = {
            columns: inferred.map((column) => ({ name: column.name, type: column.type })),
            rows,
            rowCount: rows.length,
            truncated: rows.length > (Number.isInteger(args?.maxRows) ? args.maxRows : 500),
            durationMs: 0,
            maxRows: Number.isInteger(args?.maxRows) ? args.maxRows : 500,
          }
          result.rows = rows.slice(0, result.maxRows)
          connection = { name: optionalString(args?.connection) ?? 'inline' }
          sql = ''
          sourceLabel = connection.name
        } else {
          throw new Error('db_visualize needs one of queryId, sql, or data.')
        }
        auditMeta.connection = sourceLabel
        auditMeta.sqlSource = sqlSource
        if (sql !== '') auditMeta.sql = sql
        const title = optionalString(args?.title) ?? (lang === 'zh' ? '数据可视化' : 'Data visualization')
        const chart = buildChart(columns, result.rows, {
          chartType: typeof args?.chartType === 'string' ? args.chartType : 'auto',
          title,
          subtitle: sourceLabel === 'inline'
            ? (lang === 'zh' ? `内联数据 · ${result.rowCount} 行` : `Inline data · ${result.rowCount} rows`)
            : subtitleFor(sourceLabel, result, lang),
          width: config.chart.width,
          height: config.chart.height,
          lang,
          maxCategories: config.chart.maxCategories,
        })
        let url = null
        let chartId = null
        if (chart.svg !== null) {
          chartId = chartStore.put({ svg: chart.svg, type: chart.type, title: chart.title, at: Date.now() })
          url = chartUrl(chartId)
        }
        const observations = observationsFor(columns, result.rows, lang, { truncated: result.truncated, maxRows: result.maxRows })
        queryId = queryId ?? (sql !== '' ? storeQuery(exec, {
          connection: sourceLabel,
          sql,
          columns,
          rows: result.rows,
          rowCount: result.rowCount,
          truncated: result.truncated,
          durationMs: result.durationMs,
          maxRows: result.maxRows,
          title,
          chartType: chart.type,
        }) : undefined)
        const meta = {
          v: 1,
          kind: 'chart',
          title: chart.title,
          chartType: chart.type,
          url: url ?? '',
          rows: result.rowCount,
          truncated: result.truncated,
          durationMs: result.durationMs,
          connection: sourceLabel,
          sql,
          lang,
          observations,
        }
        const markdown = `${renderChartMarkdown(chart, { sql, meta, observations, lang })}${queryId === undefined ? '' : `\n\nQuery ID: \`${queryId}\``}`
        return {
          ...chartValue({
            chart,
            url,
            id: chartId,
            connectionName: sourceLabel,
            result,
            inferredColumns: columns,
            sql,
            observations,
            truncated: result.truncated,
            lang,
            title,
            sqlSource,
            queryId,
          }),
          markdown,
          chartType: chart.type,
          reason: chart.reason,
        }
      })
    },
  })
}

function analysisOutputSchema() {
  return {
    type: 'object',
    additionalProperties: true,
    properties: {
      ok: { type: 'boolean' },
      connection: { type: 'string' },
      title: { type: 'string' },
      sql: { type: 'string' },
      columns: { type: 'array', items: { type: 'object', additionalProperties: true } },
      rows: { type: 'array', items: { type: 'object', additionalProperties: true } },
      rowCount: { type: 'integer' },
      truncated: { type: 'boolean' },
      durationMs: { type: 'number' },
      chartType: { type: 'string' },
      reason: { type: 'string' },
      queryId: { type: 'string' },
      markdown: { type: 'string' },
    },
  }
}

function profileOutputSchema() {
  return {
    type: 'object',
    additionalProperties: true,
    properties: {
      ok: { type: 'boolean' },
      connection: { type: 'string' },
      mode: { type: 'string' },
      tables: { type: 'array', items: { type: 'object', additionalProperties: true } },
      columns: { type: 'array', items: { type: 'object', additionalProperties: true } },
      rowCount: { type: 'integer' },
      markdown: { type: 'string' },
    },
  }
}

function queryOutputSchema() {
  return {
    type: 'object',
    additionalProperties: true,
    properties: {
      ok: { type: 'boolean' },
      connection: { type: 'string' },
      sql: { type: 'string' },
      rows: { type: 'array', items: { type: 'object', additionalProperties: true } },
      columns: { type: 'array', items: { type: 'object', additionalProperties: true } },
      rowCount: { type: 'integer' },
      truncated: { type: 'boolean' },
      queryId: { type: 'string' },
      markdown: { type: 'string' },
    },
  }
}

function visualizationOutputSchema() {
  return analysisOutputSchema()
}

/**
 * Normalize inline data rows. Accepts objects or arrays paired with columns.
 * @param {unknown[]} data inline data
 * @param {unknown[]|undefined} columns column names
 * @returns {Record<string, unknown>[]} rows
 */
function normalizeInlineRows(data, columns) {
  if (!Array.isArray(data)) return []
  const limit = 5000
  const rows = []
  for (const row of data.slice(0, limit)) {
    if (Array.isArray(row)) {
      if (!Array.isArray(columns)) throw new Error('Array-shaped inline data needs a columns array.')
      const object = {}
      columns.forEach((column, index) => {
        object[String(column)] = row[index]
      })
      rows.push(object)
    } else if (row !== null && typeof row === 'object') {
      rows.push({ ...row })
    }
  }
  return rows
}

/**
 * Infer simple column descriptors from inline rows.
 * @param {Record<string, unknown>[]} rows rows
 * @returns {{name: string, type: string}[]} columns
 */
function inferInlineColumns(rows) {
  const names = []
  const seen = new Set()
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key)
        names.push(key)
      }
    }
  }
  return names.map((name) => {
    const sample = rows.find((row) => row[name] !== null && row[name] !== undefined)?.[name]
    return {
      name,
      type: typeof sample === 'number' ? 'number' : sample instanceof Date ? 'timestamp' : 'text',
    }
  })
}
