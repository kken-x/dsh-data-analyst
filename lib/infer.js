/**
 * Column inference shared by the profiler, the chart chooser, and the answer
 * summary. It intentionally works on the result rows rather than trusting a
 * driver's declared type: SQLite and MySQL often report untyped expressions.
 */

const TEMPORAL_NAME = /(^|[_\s])(date|datetime|timestamp|time|day|week|month|quarter|year|period|created|updated|dt|ts)($|[_\s])|日期|时间|月份|年份|季度|年度/iu
const ID_NAME = /(^|[_\s])(id|key|uuid|guid|code|no|num|number)($|[_\s])|编号|序号|^id$/iu
const CATEGORY_NAME = /(type|category|status|level|rating|grade|segment|tier|group|class|kind|channel|region|country|province|city|类别|类型|状态|等级|地区|城市|渠道|分组|分类)/iu

/**
 * Parse a numeric cell without accepting junk such as "12abc" or empty text.
 * @param {unknown} value cell
 * @returns {number|null} finite number or null
 */
export function parseNumeric(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') {
    const number = Number(value)
    return Number.isSafeInteger(number) ? number : null
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (text === '' || !/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u.test(text)) return null
    const number = Number(text)
    return Number.isFinite(number) ? number : null
  }
  return null
}

/**
 * @param {string} name column name
 * @returns {boolean} whether the name suggests a temporal dimension
 */
export function isTemporalName(name) {
  return TEMPORAL_NAME.test(String(name))
}

/**
 * @param {string} name column name
 * @returns {boolean} whether the name suggests an identifier
 */
export function isIdName(name) {
  return ID_NAME.test(String(name))
}

/**
 * @param {string} name column name
 * @returns {boolean} whether the name suggests a category
 */
export function isCategoryName(name) {
  return CATEGORY_NAME.test(String(name))
}

/**
 * @param {unknown} value cell
 * @returns {boolean} whether the value reads as a date or timestamp
 */
export function isTemporalValue(value) {
  if (value instanceof Date) return !Number.isNaN(value.getTime())
  if (typeof value !== 'string') return false
  const text = value.trim()
  return /^\d{4}-\d{2}(?:-\d{2})?(?:[T ][0-2]\d:[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/u.test(text)
    || /^\d{4}[/.]\d{1,2}(?:[/.]\d{1,2})?$/u.test(text)
    || /^\d{4}年\d{1,2}月(?:\d{1,2}日)?$/u.test(text)
}

/**
 * Convert a value to a stable distinct-key.
 * @param {unknown} value cell
 * @returns {string} key
 */
export function distinctKey(value) {
  if (value === null || value === undefined) return '\u0000null'
  if (value instanceof Date) return `date:${value.toISOString()}`
  if (typeof value === 'object') {
    try {
      return `json:${JSON.stringify(value)}`
    } catch {
      return `obj:${String(value)}`
    }
  }
  return `${typeof value}:${String(value)}`
}

/**
 * Infer the analytical role of every result column.
 * @param {{name: string, type?: string}[]} columns driver columns
 * @param {Record<string, unknown>[]} rows result rows
 * @returns {Array<Record<string, any>>} enriched columns
 */
export function inferColumns(columns, rows) {
  return columns.map((column) => {
    const name = String(column.name)
    const declared = String(column.type ?? '').toLowerCase()
    const values = rows.map((row) => row?.[name])
    const nonNull = values.filter((value) => value !== null && value !== undefined)
    const numbers = nonNull.map(parseNumeric).filter((value) => value !== null)
    const numeric = nonNull.length > 0 && numbers.length === nonNull.length
    const declaredTemporal = /date|time|timestamp|datetime|year|month/u.test(declared)
    const temporal = !numeric && nonNull.length > 0 && (declaredTemporal || isTemporalName(name) || nonNull.every(isTemporalValue))
    const boolean = nonNull.length > 0 && nonNull.every((value) => typeof value === 'boolean')
    const distinct = new Set(nonNull.map(distinctKey)).size
    const unique = nonNull.length > 0 && distinct === nonNull.length
    const nullCount = values.length - nonNull.length
    const nullRate = values.length === 0 ? 0 : nullCount / values.length
    let role = 'text'
    if (nonNull.length === 0) role = 'empty'
    else if (temporal) role = 'time'
    else if (boolean) role = 'dimension'
    else if (numeric && /^(id|uuid|guid|key|pk)$/iu.test(name) && unique) role = 'id'
    else if (numeric && isIdName(name) && distinct <= 60) role = 'dimension'
    else if (numeric && isIdName(name)) role = 'id'
    else if (numeric && isCategoryName(name) && distinct <= Math.max(12, Math.ceil(values.length * 0.5))) role = 'dimension'
    else if (numeric) role = 'measure'
    else if (unique && isIdName(name)) role = 'id'
    else if (distinct <= Math.max(60, Math.ceil(values.length * 0.8))) role = 'dimension'
    else role = 'text'

    let min
    let max
    if (numeric && numbers.length > 0) {
      min = Math.min(...numbers)
      max = Math.max(...numbers)
    }
    if (temporal) {
      const times = nonNull
        .map((value) => (value instanceof Date ? value : new Date(String(value))))
        .filter((date) => !Number.isNaN(date.getTime()))
        .map((date) => date.getTime())
      if (times.length > 0) {
        min = new Date(Math.min(...times)).toISOString()
        max = new Date(Math.max(...times)).toISOString()
      }
    }
    return {
      name,
      type: declared,
      kind: nonNull.length === 0 ? 'empty' : numeric ? 'number' : temporal ? 'temporal' : boolean ? 'boolean' : 'text',
      role,
      nullable: nullCount > 0,
      nullCount,
      nullRate,
      distinct,
      unique,
      numeric: numeric && numbers.length > 0,
      sample: nonNull.slice(0, 5).map((value) => (typeof value === 'object' ? JSON.stringify(value) : value)),
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
      ...(nonNull.length === 0 ? {} : { nonNull: nonNull.length }),
    }
  })
}

/**
 * @param {Array<Record<string, any>>} columns inferred columns
 * @returns {Record<string, any>|undefined} first time column
 */
export function firstTimeColumn(columns) {
  return columns.find((column) => column.role === 'time')
}

/**
 * @param {Array<Record<string, any>>} columns inferred columns
 * @returns {Record<string, any>|undefined} first dimension column
 */
export function firstDimension(columns) {
  return columns.find((column) => column.role === 'dimension')
}

/**
 * @param {Array<Record<string, any>>} columns inferred columns
 * @returns {Array<Record<string, any>>} measure columns
 */
export function measureColumns(columns) {
  return columns.filter((column) => column.role === 'measure')
}

/**
 * Format a number for prose and axes.
 * @param {number} value number
 * @param {'en'|'zh'} lang language
 * @param {{compact?: boolean}} options formatting
 * @returns {string} formatted number
 */
export function formatNumber(value, lang = 'en', options = {}) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—'
  const number = Number(value)
  const abs = Math.abs(number)
  if (options.compact === true && abs >= 1000) {
    if (lang === 'zh') {
      if (abs >= 1e8) return `${trimZero(number / 1e8)}亿`
      if (abs >= 1e4) return `${trimZero(number / 1e4)}万`
    } else {
      if (abs >= 1e9) return `${trimZero(number / 1e9)}B`
      if (abs >= 1e6) return `${trimZero(number / 1e6)}M`
      if (abs >= 1e3) return `${trimZero(number / 1e3)}K`
    }
  }
  const maximumFractionDigits = Number.isInteger(number) ? 0 : abs < 1 ? 4 : 2
  try {
    return new Intl.NumberFormat(lang === 'zh' ? 'zh-CN' : 'en-US', {
      maximumFractionDigits,
      minimumFractionDigits: 0,
    }).format(number)
  } catch {
    return String(number)
  }
}

function trimZero(value) {
  return String(Math.round(value * 10) / 10)
}

/**
 * @param {number} value fraction in [0,1]
 * @param {'en'|'zh'} lang language
 * @returns {string} percent
 */
export function formatPercent(value, lang = 'en') {
  return `${formatNumber(value * 100, lang, { compact: false })}%`
}

/**
 * Render one cell as compact text.
 * @param {unknown} value cell
 * @param {'en'|'zh'} lang language
 * @returns {string} text
 */
export function formatCell(value, lang = 'en') {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'number') return formatNumber(value, lang)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * @param {string} text candidate
 * @returns {'zh'|'en'} language of the question
 */
export function languageOf(text) {
  return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(String(text ?? '')) ? 'zh' : 'en'
}

/**
 * Build a small list of data observations for the model and the card.
 * @param {Array<Record<string, any>>} columns inferred columns
 * @param {Record<string, unknown>[]} rows rows
 * @param {'en'|'zh'} lang language
 * @param {{truncated?: boolean, maxRows?: number}} meta limits
 * @returns {string[]} observations
 */
export function observationsFor(columns, rows, lang = 'en', meta = {}) {
  const zh = lang === 'zh'
  const out = []
  const time = firstTimeColumn(columns)
  const measures = measureColumns(columns)
  const dimension = firstDimension(columns)
  if (time !== undefined && time.min !== undefined && time.max !== undefined) {
    out.push(zh ? `时间范围：${formatCell(time.min, lang)} 至 ${formatCell(time.max, lang)}。` : `Time range: ${formatCell(time.min, lang)} to ${formatCell(time.max, lang)}.`)
  }
  if (measures.length > 0 && rows.length > 0) {
    const measure = measures[0]
    const values = rows.map((row) => parseNumeric(row[measure.name])).filter((value) => value !== null)
    if (values.length > 0) {
      const sum = values.reduce((total, value) => total + value, 0)
      const average = sum / values.length
      const min = Math.min(...values)
      const max = Math.max(...values)
      out.push(zh
        ? `${measure.name}：合计 ${formatNumber(sum, lang)}，均值 ${formatNumber(average, lang)}，范围 ${formatNumber(min, lang)}–${formatNumber(max, lang)}。`
        : `${measure.name}: total ${formatNumber(sum, lang)}, average ${formatNumber(average, lang)}, range ${formatNumber(min, lang)}–${formatNumber(max, lang)}.`)
      if (dimension !== undefined) {
        const ranked = rows
          .map((row) => ({ label: formatCell(row[dimension.name], lang), value: parseNumeric(row[measure.name]) }))
          .filter((entry) => entry.value !== null)
          .sort((a, b) => b.value - a.value)
        if (ranked.length > 0 && ranked[0] !== undefined) {
          out.push(zh
            ? `最高：${ranked[0].label}（${formatNumber(ranked[0].value, lang)}）。`
            : `Top ${dimension.name}: ${ranked[0].label} (${formatNumber(ranked[0].value, lang)}).`)
        }
      }
    }
  }
  const nullable = columns.filter((column) => column.nullCount > 0)
  if (nullable.length > 0) {
    out.push(zh
      ? `结果中 ${nullable.length} 列含空值（${nullable.slice(0, 3).map((column) => `${column.name} ${formatPercent(column.nullRate, lang)}`).join('，')}）。`
      : `${nullable.length} result column${nullable.length === 1 ? '' : 's'} contain nulls (${nullable.slice(0, 3).map((column) => `${column.name} ${formatPercent(column.nullRate, lang)}`).join(', ')}).`)
  }
  if (meta.truncated === true) {
    out.push(zh
      ? `结果已截断为前 ${meta.maxRows ?? rows.length} 行；聚合前请注意完整性。`
      : `Result truncated to ${meta.maxRows ?? rows.length} rows; account for that before drawing conclusions.`)
  }
  if (out.length === 0) out.push(zh ? `返回 ${rows.length} 行数据。` : `Returned ${rows.length} rows.`)
  return out
}
