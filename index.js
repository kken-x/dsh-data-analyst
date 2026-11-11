import { createServer } from 'node:http'
import { Config, resolveConfig } from './lib/config.js'
import { AuditLog } from './lib/audit.js'
import { ConnectionManager } from './lib/connections.js'
import { MemoryStore, registerTools } from './lib/tools.js'

export { Config }

export const name = 'data-analyst'

/** The tool registry is the only required host service. */
export const inject = ['tools']

const CHART_PREFIX = '/dsh-data-analyst/chart'

/**
 * Send one in-memory SVG chart. IDs are random and only minted by this plugin,
 * so the route never touches an attacker-selected filesystem path.
 * @param {import('node:http').IncomingMessage} req request
 * @param {import('node:http').ServerResponse} res response
 * @param {MemoryStore} store chart store
 * @returns {void}
 */
function serveChart(req, res, store) {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Method not allowed')
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const match = /^\/dsh-data-analyst\/chart\/([a-f0-9]{32})\.svg$/u.exec(url.pathname)
    if (match === null) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Chart not found')
      return
    }
    const chart = store.get(match[1])
    if (chart === undefined) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Chart not found or expired')
      return
    }
    const body = Buffer.from(chart.svg, 'utf8')
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Content-Length': body.byteLength,
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    })
    if (req.method === 'HEAD') res.end()
    else res.end(body)
  } catch (error) {
    try {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Chart rendering failed')
    } catch {
      // The socket is already gone.
    }
    console.error(`[dsh-data-analyst] chart route failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Start a loopback-only fallback server for environments without the Web
 * carrier (for example a headless profile that still wants chart files).
 * @param {MemoryStore} store chart store
 * @returns {Promise<{origin: string, close: () => Promise<void>}>} server handle
 */
async function startStandaloneServer(store) {
  const server = createServer((req, res) => serveChart(req, res, store))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/**
 * Build the analyst prompt section from live config. Credentials never enter it.
 * @param {ReturnType<typeof resolveConfig>} config resolved config
 * @returns {string} prompt text
 */
function analystPrompt(config) {
  const roster = config.connections.length === 0
    ? 'No connections are configured yet.'
    : config.connections.map((connection) => `\`${connection.name}\` (${connection.driver})`).join(', ')
  return [
    '## Conversational data analyst',
    `A read-only data analyst plugin is installed. Connections: ${roster}`,
    'For any data question (counts, trends, comparisons, distributions, top-N, percentages, anomalies), call `db_analyze` once with the user\'s exact question and, when more than one connection exists, the `connection` name. It generates one SELECT, executes it, profiles the result, and renders an inline chart.',
    'Do not manually chain `db_profile` + `db_query` + `db_visualize` for the same question. Use `db_profile` only to discover or verify schema, `db_query` only for SQL the user explicitly supplied or when you need raw rows, and `db_visualize` only to re-render an existing `queryId` with a different chart type.',
    'The plugin is read-only: it never registers a write path. Never claim it can modify data.',
    'Answer in the user\'s language. Lead with the finding, cite the row count and any truncation, and let the tool card display the chart; do not paste the image URL again. If no connection is configured, ask the user to add one in the plugin config instead of inventing data.',
  ].join('\n')
}

/**
 * Mount the data-analyst tools, audit sink, chart route, and analyst prompt.
 * @param {any} ctx host plugin context
 * @param {Record<string, unknown>} rawConfig loader config
 * @returns {Promise<void>} resolves when the plugin is mounted
 */
export async function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const workingDirectory = ctx.get?.('workingDirectory')
  const baseDir = typeof workingDirectory?.defaultDirectory === 'string' && workingDirectory.defaultDirectory !== ''
    ? workingDirectory.defaultDirectory
    : process.cwd()
  const manager = new ConnectionManager({ config, baseDir, ctx })
  const audit = new AuditLog(config.audit)
  const chartStore = new MemoryStore({ ttlMs: 30 * 60 * 1000, max: 80 })
  const queryStore = new MemoryStore({ ttlMs: 15 * 60 * 1000, max: 120 })

  let chartUrl
  let webServer
  try {
    webServer = ctx.get?.('webServer')
  } catch {
    webServer = undefined
  }
  if (webServer !== undefined && typeof webServer.register === 'function') {
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: CHART_PREFIX,
      handler: (req, res) => serveChart(req, res, chartStore),
    }))
    chartUrl = (id) => `${CHART_PREFIX}/${id}.svg`
  } else {
    const server = await startStandaloneServer(chartStore)
    ctx.effect(() => () => server.close())
    chartUrl = (id) => `${server.origin}${CHART_PREFIX}/${id}.svg`
  }

  registerTools({ ctx, config, manager, audit, chartStore, queryStore, chartUrl })

  const systemPrompt = ctx.get?.('systemPrompt')
  if (systemPrompt !== undefined && typeof systemPrompt.section === 'function') {
    try {
      ctx.effect(() => systemPrompt.section({
        name: 'data-analyst',
        order: 45,
        text: analystPrompt(config),
      }))
    } catch (error) {
      console.error(`[dsh-data-analyst] prompt section skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  ctx.effect(() => () => {
    manager.closeAll().catch((error) => {
      console.error(`[dsh-data-analyst] connection cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  })
}
