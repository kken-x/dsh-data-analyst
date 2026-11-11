import z from '@deepseek-ai/schemastery'

const DRIVERS = ['sqlite', 'postgres', 'mysql']

const Connection = z.object({
  name: z.string().required().description('Short stable id used by the tools, for example sales.'),
  description: z.string().description('Optional human-readable description shown to the model.'),
  driver: z.union(DRIVERS.map((driver) => z.const(driver))).required().description('Database dialect.'),
  database: z.string().description('SQLite file path, or the PostgreSQL/MySQL database name.'),
  host: z.string().description('PostgreSQL/MySQL host; defaults to 127.0.0.1.'),
  port: z.number().step(1).min(1).max(65535).description('PostgreSQL/MySQL port.'),
  user: z.string().description('PostgreSQL/MySQL user. Use a read-only account.'),
  password: z.string().description('Literal password (not recommended). Prefer passwordEnv or passwordRef.'),
  passwordEnv: z.string().description('Environment variable that holds the password.'),
  passwordRef: z.string().description('Credential reference resolved by the DSH credentials service.'),
  ssl: z.boolean().description('Enable TLS for PostgreSQL/MySQL.'),
  readOnly: z.boolean().default(true).description('Must stay true. The plugin never registers a write tool.'),
  statementTimeoutMs: z.number().step(1).min(500).max(300000).description('Per-connection query timeout override.'),
  maxRows: z.number().step(1).min(1).max(5000).description('Per-connection row cap override.'),
})

export const Config = z.object({
  connections: z.array(Connection).default([]).description('Named read-only database connections.'),
  defaultConnection: z.string().description('Connection used when a tool call omits `connection`.'),
  maxRows: z.number().step(1).min(1).max(5000).default(500).description('Default result row cap.'),
  timeoutMs: z.number().step(1).min(500).max(300000).default(30000).description('Default query timeout in milliseconds.'),
  audit: z.object({
    enabled: z.boolean().default(true),
    path: z.string().description('JSONL audit path. Defaults to <DSH profile>/data/dsh-data-analyst/audit.jsonl.'),
  }).default({}),
  sqlGeneration: z.object({
    enabled: z.boolean().default(true).description('Allow db_analyze to draft SQL with the configured model.'),
    provider: z.string().description('Optional model provider override. Defaults to the active DSH model.'),
    model: z.string().description('Optional model id override. Defaults to the active DSH model.'),
    maxOutputTokens: z.number().step(1).min(256).max(8192).default(1400),
    maxSchemaTables: z.number().step(1).min(1).max(100).default(20),
    maxSchemaChars: z.number().step(1).min(2000).max(50000).default(16000),
    timeoutMs: z.number().step(1).min(1000).max(120000).default(45000),
  }).default({}),
  chart: z.object({
    width: z.number().step(1).min(480).max(1600).default(960),
    height: z.number().step(1).min(300).max(1200).default(560),
    theme: z.union(['light', 'dark', 'auto'].map((theme) => z.const(theme))).default('light'),
    maxCategories: z.number().step(1).min(3).max(60).default(24),
  }).default({}),
  profile: z.object({
    maxColumns: z.number().step(1).min(1).max(100).default(40),
    topValues: z.number().step(1).min(1).max(20).default(5),
  }).default({}),
})

/**
 * Validate and detach one connection row.
 * @param {Record<string, unknown>} raw raw config row
 * @param {number} index position for error messages
 * @returns {Record<string, unknown>} normalized connection
 */
export function normalizeConnection(raw, index) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`connections[${index}] must be an object`)
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
    throw new Error(`connections[${index}].name must be 1-64 characters of letters, digits, dot, dash, or underscore`)
  }
  if (!DRIVERS.includes(raw.driver)) {
    throw new Error(`connections[${index}] (${name}) driver must be one of: ${DRIVERS.join(', ')}`)
  }
  if (raw.readOnly === false) {
    throw new Error(`connections[${index}] (${name}) requests readOnly:false. dsh-data-analyst is read-only by design and refuses to start with a writable connection.`)
  }
  const database = typeof raw.database === 'string' ? raw.database.trim() : ''
  if (database === '') throw new Error(`connections[${index}] (${name}) requires database`)
  if (raw.driver !== 'sqlite') {
    if (typeof raw.user !== 'string' || raw.user.trim() === '') {
      throw new Error(`connections[${index}] (${name}) requires user for ${raw.driver}`)
    }
  }
  return {
    name,
    description: typeof raw.description === 'string' ? raw.description.trim() : '',
    driver: raw.driver,
    database,
    host: typeof raw.host === 'string' && raw.host.trim() !== '' ? raw.host.trim() : '127.0.0.1',
    port: Number.isInteger(raw.port) ? raw.port : raw.driver === 'postgres' ? 5432 : 3306,
    user: typeof raw.user === 'string' ? raw.user : '',
    password: typeof raw.password === 'string' ? raw.password : undefined,
    passwordEnv: typeof raw.passwordEnv === 'string' && raw.passwordEnv.trim() !== '' ? raw.passwordEnv.trim() : undefined,
    passwordRef: typeof raw.passwordRef === 'string' && raw.passwordRef.trim() !== '' ? raw.passwordRef.trim() : undefined,
    ssl: raw.ssl === true,
    readOnly: true,
    statementTimeoutMs: Number.isInteger(raw.statementTimeoutMs) ? raw.statementTimeoutMs : undefined,
    maxRows: Number.isInteger(raw.maxRows) ? raw.maxRows : undefined,
  }
}

/**
 * Validate the whole plugin configuration and apply defaults.
 * @param {Record<string, unknown>} input validated loader config
 * @returns {{connections: Record<string, unknown>[], byName: Map<string, Record<string, unknown>>, defaultConnection: string|undefined, maxRows: number, timeoutMs: number, audit: Record<string, unknown>, sqlGeneration: Record<string, unknown>, chart: Record<string, unknown>, profile: Record<string, unknown>}} resolved config
 */
export function resolveConfig(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const connections = Array.isArray(raw.connections) ? raw.connections.map(normalizeConnection) : []
  const byName = new Map()
  for (const connection of connections) {
    if (byName.has(connection.name)) throw new Error(`duplicate connection name: ${connection.name}`)
    byName.set(connection.name, connection)
  }
  const defaultConnection = typeof raw.defaultConnection === 'string' && raw.defaultConnection.trim() !== ''
    ? raw.defaultConnection.trim()
    : connections.length === 1 ? connections[0].name : undefined
  if (defaultConnection !== undefined && !byName.has(defaultConnection)) {
    throw new Error(`defaultConnection "${defaultConnection}" does not match any configured connection`)
  }
  const maxRows = Number.isInteger(raw.maxRows) ? raw.maxRows : 500
  const timeoutMs = Number.isInteger(raw.timeoutMs) ? raw.timeoutMs : 30000
  const audit = {
    enabled: raw.audit?.enabled !== false,
    path: typeof raw.audit?.path === 'string' ? raw.audit.path : undefined,
  }
  const sqlGeneration = {
    enabled: raw.sqlGeneration?.enabled !== false,
    provider: typeof raw.sqlGeneration?.provider === 'string' ? raw.sqlGeneration.provider : undefined,
    model: typeof raw.sqlGeneration?.model === 'string' ? raw.sqlGeneration.model : undefined,
    maxOutputTokens: Number.isInteger(raw.sqlGeneration?.maxOutputTokens) ? raw.sqlGeneration.maxOutputTokens : 1400,
    maxSchemaTables: Number.isInteger(raw.sqlGeneration?.maxSchemaTables) ? raw.sqlGeneration.maxSchemaTables : 20,
    maxSchemaChars: Number.isInteger(raw.sqlGeneration?.maxSchemaChars) ? raw.sqlGeneration.maxSchemaChars : 16000,
    timeoutMs: Number.isInteger(raw.sqlGeneration?.timeoutMs) ? raw.sqlGeneration.timeoutMs : 45000,
  }
  const chart = {
    width: Number.isInteger(raw.chart?.width) ? raw.chart.width : 960,
    height: Number.isInteger(raw.chart?.height) ? raw.chart.height : 560,
    theme: ['light', 'dark', 'auto'].includes(raw.chart?.theme) ? raw.chart.theme : 'light',
    maxCategories: Number.isInteger(raw.chart?.maxCategories) ? raw.chart.maxCategories : 24,
  }
  const profile = {
    maxColumns: Number.isInteger(raw.profile?.maxColumns) ? raw.profile.maxColumns : 40,
    topValues: Number.isInteger(raw.profile?.topValues) ? raw.profile.topValues : 5,
  }
  return {
    connections,
    byName,
    defaultConnection,
    maxRows,
    timeoutMs,
    audit,
    sqlGeneration,
    chart,
    profile,
  }
}

/**
 * Pick the connection a tool call names, or the configured default.
 * @param {ReturnType<typeof resolveConfig>} config resolved plugin config
 * @param {unknown} requested tool argument
 * @returns {Record<string, unknown>} connection
 */
export function selectConnection(config, requested) {
  if (config.connections.length === 0) {
    throw new Error('No database connections are configured. Add at least one read-only connection to the dsh-data-analyst plugin config (connections: [{ name, driver, database, ... }]).')
  }
  if (typeof requested === 'string' && requested.trim() !== '') {
    const found = config.byName.get(requested.trim())
    if (found === undefined) {
      throw new Error(`Unknown connection "${requested.trim()}". Configured connections: ${[...config.byName.keys()].join(', ')}.`)
    }
    return found
  }
  if (config.defaultConnection !== undefined) {
    return config.byName.get(config.defaultConnection)
  }
  if (config.connections.length === 1) return config.connections[0]
  throw new Error(`Multiple connections are configured; pass connection: one of ${[...config.byName.keys()].join(', ')}.`)
}
