import { createHash } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'

/** One JSONL append-only audit sink. */
export class AuditLog {
  /**
   * @param {{enabled?: boolean, path?: string}} options audit options
   */
  constructor(options = {}) {
    this.enabled = options.enabled !== false
    this.path = options.path === undefined ? defaultAuditPath() : resolveAuditPath(options.path)
    this.queue = Promise.resolve()
  }

  /**
   * Append one record. Audit failures never fail the user's query.
   * @param {Record<string, unknown>} record audit fields
   * @returns {Promise<void>} settles after the append attempt
   */
  async write(record) {
    if (!this.enabled) return
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`
    this.queue = this.queue
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true })
        await appendFile(this.path, line, { encoding: 'utf8', mode: 0o600 })
      })
      .catch((error) => {
        console.error(`[dsh-data-analyst] audit append failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    await this.queue
  }
}

/**
 * Default audit location: the current DSH profile's data directory when known.
 * @returns {string} absolute JSONL path
 */
export function defaultAuditPath() {
  const profileDir = process.env.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir.trim() !== '') {
    return resolve(profileDir, 'data', 'dsh-data-analyst', 'audit.jsonl')
  }
  return resolve(homedir(), '.dsh', 'data', 'dsh-data-analyst', 'audit.jsonl')
}

/**
 * Resolve an explicitly configured audit path.
 * @param {string} value path from config
 * @returns {string} absolute path
 */
export function resolveAuditPath(value) {
  if (isAbsolute(value)) return value
  const base = process.env.DSH_PROFILE_DIR
  return resolve(base !== undefined && base.trim() !== '' ? base : homedir(), value)
}

/**
 * Hash one SQL string for the audit record.
 * @param {string} sql SQL
 * @returns {string} hex sha256
 */
export function hashSql(sql) {
  return createHash('sha256').update(sql, 'utf8').digest('hex')
}

/**
 * Remove credential material from an error message before it reaches a log or a model.
 * @param {unknown} error thrown value
 * @param {string[]} secrets literal secrets to scrub
 * @returns {{code: string, message: string}} safe error
 */
export function sanitizeError(error, secrets = []) {
  const raw = error instanceof Error ? error.message : String(error)
  let message = raw
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 3) message = message.split(secret).join('***')
  }
  message = message
    .replace(/(password|passwd|pwd)\s*=\s*[^\s;]+/giu, '$1=***')
    .replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/giu, '$1***@')
    .replace(/(mysql:\/\/[^:\s]+:)[^@\s]+@/giu, '$1***@')
  const code = typeof error?.code === 'string' ? error.code : 'QUERY_FAILED'
  return { code, message: message.slice(0, 1200) }
}
