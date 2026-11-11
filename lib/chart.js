import {
  distinctKey,
  firstDimension,
  firstTimeColumn,
  formatCell,
  formatNumber,
  formatPercent,
  isCategoryName,
  measureColumns,
  parseNumeric,
} from './infer.js'

export const CHART_TYPES = [
  'auto', 'line', 'area', 'bar', 'grouped_bar', 'stacked_bar',
  'pie', 'donut', 'scatter', 'histogram', 'kpi', 'table',
]

const PALETTE = ['#0f766e', '#0e7490', '#1d4ed8', '#7c3aed', '#db2777', '#ea580c', '#ca8a04', '#475569']
const INK = '#0f172a'
const MUTED = '#64748b'
const GRID = '#e2e8f0'
const CARD = '#ffffff'
const BORDER = '#e2e8f0'

/**
 * @param {unknown} value text
 * @returns {string} XML-safe text
 */
export function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function truncate(text, max) {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, Math.max(1, max - 1))}…`
}

function estimateTextWidth(text, fontSize) {
  let units = 0
  for (const char of String(text ?? '')) {
    units += /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(char) ? 1 : 0.56
  }
  return units * fontSize
}

function fitText(text, maxWidth, fontSize) {
  const value = String(text ?? '')
  if (estimateTextWidth(value, fontSize) <= maxWidth) return value
  let output = ''
  for (const char of value) {
    if (estimateTextWidth(`${output}${char}…`, fontSize) > maxWidth) break
    output += char
  }
  return `${output || value.slice(0, 1)}…`
}

/**
 * @param {number} min data min
 * @param {number} max data max
 * @param {number} count desired tick count
 * @returns {{min: number, max: number, ticks: number[]}} nice domain
 */
function niceTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, ticks: [0, 0.5, 1] }
  if (min === max) {
    if (min === 0) return { min: 0, max: 1, ticks: [0, 0.5, 1] }
    const padding = Math.abs(min) * 0.2 || 1
    min -= padding
    max += padding
  }
  const span = max - min
  const rough = span / Math.max(2, count)
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const normalized = rough / magnitude
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude
  const start = Math.floor(min / step) * step
  const end = Math.ceil(max / step) * step
  const ticks = []
  for (let value = start; value <= end + step * 0.5; value += step) {
    ticks.push(Math.abs(value) < step * 1e-9 ? 0 : Number(value.toFixed(10)))
  }
  return { min: start, max: end, ticks }
}

function totalForSeries(series, categoryCount) {
  let total = 0
  for (const item of series) {
    for (let index = 0; index < categoryCount; index += 1) total += item.values[index] ?? 0
  }
  return total
}

function sumByCategory(series, categoryCount) {
  const totals = new Array(categoryCount).fill(0)
  for (const item of series) {
    for (let index = 0; index < categoryCount; index += 1) totals[index] += item.values[index] ?? 0
  }
  return totals
}

/**
 * Build aligned category/series values.
 * @param {Record<string, unknown>[]} rows rows
 * @param {{key: string, label: string, kind: 'measure'|'dimension'}[]} seriesDefs series definitions
 * @param {string|undefined} measureKey measure for dimension series
 * @param {string} xKey x column
 * @param {{time?: boolean, maxCategories: number, sort?: 'time'|'value'|'none'}} options options
 * @returns {{categories: {raw: unknown, label: string, sort: number}[], series: {key: string, label: string, values: number[]}[], omittedCategories: number}} matrix
 */
function buildMatrix(rows, seriesDefs, measureKey, xKey, options) {
  const categoryMap = new Map()
  const series = seriesDefs.map((definition) => ({ ...definition, values: [] }))
  const categoryIndex = new Map()
  for (const row of rows) {
    const raw = row[xKey]
    const id = distinctKey(raw)
    if (!categoryIndex.has(id)) {
      categoryIndex.set(id, categoryMap.size)
      categoryMap.set(id, {
        raw,
        label: formatCell(raw, options.lang ?? 'en'),
        sort: options.time === true ? dateOrder(raw) : categoryMap.size,
        total: 0,
      })
      for (const item of series) item.values.push(0)
    }
    const index = categoryIndex.get(id)
    for (let seriesIndex = 0; seriesIndex < seriesDefs.length; seriesIndex += 1) {
      const definition = seriesDefs[seriesIndex]
      let value
      if (definition.kind === 'measure') value = parseNumeric(row[definition.key])
      else if (distinctKey(row[definition.key]) === definition.rawKey) value = parseNumeric(row[measureKey])
      if (value !== null && value !== undefined) {
        series[seriesIndex].values[index] += value
        categoryMap.get(id).total += value
      }
    }
  }
  let categories = [...categoryMap.values()]
  if (options.sort === 'time') categories.sort((a, b) => a.sort - b.sort)
  else if (options.sort === 'value') categories.sort((a, b) => b.total - a.total)
  let omittedCategories = 0
  if (categories.length > options.maxCategories) {
    omittedCategories = categories.length - options.maxCategories
    const keep = options.sort === 'time'
      ? sampleEvenly(categories, options.maxCategories)
      : categories.slice(0, options.maxCategories)
    const keepIds = new Set(keep.map((category) => distinctKey(category.raw)))
    categories = categories.filter((category) => keepIds.has(distinctKey(category.raw)))
    for (const item of series) {
      item.values = categories.map((category) => {
        const originalIndex = [...categoryMap.values()].indexOf(category)
        return item.values[originalIndex] ?? 0
      })
    }
  }
  return { categories, series, omittedCategories }
}

function sampleEvenly(items, count) {
  if (items.length <= count) return items
  const output = []
  for (let index = 0; index < count; index += 1) {
    output.push(items[Math.round((index * (items.length - 1)) / Math.max(1, count - 1))])
  }
  return [...new Set(output)]
}

function dateOrder(value) {
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? Number.MAX_SAFE_INTEGER : date.getTime()
}

/**
 * Choose a chart type from the result shape. This is the "auto" half of
 * db_analyze; explicit requests are honoured when compatible.
 * @param {Array<Record<string, any>>} columns inferred columns
 * @param {Record<string, unknown>[]} rows rows
 * @param {{lang?: 'en'|'zh', requested?: string}} options options
 * @returns {{type: string, reason: string, note?: string}} choice
 */
export function chooseChart(columns, rows, options = {}) {
  const lang = options.lang ?? 'en'
  const zh = lang === 'zh'
  const requested = options.requested && options.requested !== 'auto' ? options.requested : undefined
  const time = firstTimeColumn(columns)
  const dims = columns.filter((column) => column.role === 'dimension')
  const measures = measureColumns(columns)
  const dim = dims[0]
  const n = rows.length

  let choice
  if (n === 0) {
    choice = { type: 'table', reason: zh ? '结果为空，用表格展示。' : 'The result is empty, so a table is the clearest output.' }
  } else if (measures.length === 0 && dim === undefined && time === undefined) {
    choice = { type: 'table', reason: zh ? '结果中没有可绘制的数值或维度。' : 'No numeric measure or dimension is available to plot.' }
  } else if (measures.length === 0 && dim !== undefined) {
    choice = { type: 'bar', reason: zh ? '按类别统计行数。' : 'Counts by category make a bar chart.' }
  } else if (time !== undefined && measures.length > 0) {
    choice = { type: 'line', reason: zh ? '检测到时间维度，使用折线图展示趋势。' : 'A time dimension is present, so a line chart shows the trend.' }
  } else if (n === 1 && measures.length > 0 && dim === undefined) {
    choice = { type: 'kpi', reason: zh ? '只有一行一个指标，使用 KPI 卡片。' : 'One row and one measure is best shown as a KPI.' }
  } else if (dim !== undefined && measures.length > 0) {
    const first = measures[0]
    const values = rows.map((row) => parseNumeric(row[first.name])).filter((value) => value !== null)
    const total = values.reduce((sum, value) => sum + value, 0)
    const shareLike = /share|percent|pct|ratio|rate|占比|比例|份额/iu.test(first.name) || Math.abs(total - 100) <= 1
    if (shareLike && values.every((value) => value >= 0) && dim.distinct <= 12) {
      choice = {
        type: shareLike ? 'donut' : 'pie',
        reason: zh
          ? (shareLike ? '各分项合计接近 100%，使用环形图展示构成。' : '类别不多，使用饼图展示构成。')
          : (shareLike ? 'The parts add up to roughly 100%, so a donut shows the composition.' : 'There are few categories, so a pie shows the composition.'),
      }
    } else if (dims.length >= 2 && dims[1].distinct <= 8) {
      choice = { type: 'grouped_bar', reason: zh ? '两个低基数维度，使用分组柱状图对比。' : 'Two low-cardinality dimensions are present, so grouped bars compare them.' }
    } else if (dim.distinct > 30) {
      choice = { type: 'table', reason: zh ? '类别过多，表格比拥挤的坐标轴更清晰。' : 'Too many categories for readable axes; a table is clearer.' }
    } else {
      choice = { type: 'bar', reason: zh ? '类别对比使用柱状图。' : 'A categorical comparison is clearest as a bar chart.' }
    }
  } else if (measures.length >= 2) {
    choice = { type: 'scatter', reason: zh ? '检测到两个数值列，使用散点图观察关系。' : 'Two numeric measures are present, so a scatter shows their relationship.' }
  } else if (measures.length === 1 && n >= 5) {
    choice = { type: 'histogram', reason: zh ? '单一数值列且行数较多，使用直方图展示分布。' : 'One numeric column with many rows is best shown as a histogram.' }
  } else {
    choice = { type: 'table', reason: zh ? '当前结果形状更适合表格。' : 'The result shape is better served by a table.' }
  }

  if (requested !== undefined) {
    const compatible = compatibility(choice.type, requested)
    if (compatible) return { ...choice, type: requested, reason: zh ? `按请求使用 ${requested} 图表。` : `Using the requested ${requested} chart.` }
    return { ...choice, note: zh ? `请求的 ${requested} 图表与结果形状不兼容，已自动改用 ${choice.type}。` : `The requested ${requested} chart does not fit this result shape; using ${choice.type} instead.` }
  }
  return choice
}

function compatibility(selected, requested) {
  if (requested === selected) return true
  if (requested === 'area' && selected === 'line') return true
  if (requested === 'line' && (selected === 'line' || selected === 'area')) return true
  if (requested === 'bar' && ['bar', 'grouped_bar', 'stacked_bar', 'line', 'area'].includes(selected)) return true
  if (requested === 'grouped_bar' && ['bar', 'grouped_bar', 'stacked_bar', 'line', 'area'].includes(selected)) return true
  if (requested === 'stacked_bar' && ['bar', 'grouped_bar', 'stacked_bar', 'line', 'area'].includes(selected)) return true
  if (requested === 'pie' && ['pie', 'donut', 'bar', 'grouped_bar', 'stacked_bar'].includes(selected)) return true
  if (requested === 'donut' && ['pie', 'donut', 'bar', 'grouped_bar', 'stacked_bar'].includes(selected)) return true
  if (requested === 'table') return true
  if (requested === 'histogram' && selected === 'histogram') return true
  if (requested === 'scatter' && selected === 'scatter') return true
  if (requested === 'kpi' && selected === 'kpi') return true
  return false
}

function seriesFromColumns(columns, rows, x, options) {
  const dims = columns.filter((column) => column.role === 'dimension')
  const measures = measureColumns(columns)
  const time = x.role === 'time'
  const otherDim = dims.find((column) => column.name !== x.name && column.distinct > 1 && column.distinct <= 8)
  if (otherDim !== undefined && measures.length >= 1) {
    const values = [...new Set(rows.map((row) => distinctKey(row[otherDim.name])))]
      .map((key) => rows.find((row) => distinctKey(row[otherDim.name]) === key)?.[otherDim.name])
      .filter((value) => value !== undefined)
      .slice(0, 8)
    return {
      seriesDefs: values.map((value) => ({
        key: otherDim.name,
        rawKey: distinctKey(value),
        label: formatCell(value, options.lang),
        kind: 'dimension',
      })),
      measureKey: measures[0].name,
      seriesKind: 'dimension',
      time,
    }
  }
  return {
    seriesDefs: measures.slice(0, 6).map((column) => ({ key: column.name, label: column.name, kind: 'measure' })),
    measureKey: undefined,
    seriesKind: 'measure',
    time,
  }
}

/**
 * @param {Array<Record<string, any>>} columns inferred columns
 * @param {Record<string, unknown>[]} rows rows
 * @param {{lang: 'en'|'zh', maxCategories: number}} options options
 * @returns {any} chart data
 */
function prepareCategorical(columns, rows, options) {
  const measures = measureColumns(columns)
  const time = firstTimeColumn(columns)
  const dims = columns.filter((column) => column.role === 'dimension')
  const x = time ?? dims[0] ?? measures[0] ?? columns[0]
  if (x === undefined) return undefined
  if (measures.length === 0) {
    const counts = new Map()
    for (const row of rows) {
      const key = distinctKey(row[x.name])
      if (!counts.has(key)) counts.set(key, { raw: row[x.name], label: formatCell(row[x.name], options.lang), count: 0 })
      counts.get(key).count += 1
    }
    const categories = [...counts.values()].sort((a, b) => b.count - a.count)
    const series = [{ key: '__count', label: options.lang === 'zh' ? '行数' : 'Rows', values: categories.map((category) => category.count) }]
    return { x, categories: categories.map((category) => ({ raw: category.raw, label: category.label, total: category.count })), series, seriesKind: 'count', omittedCategories: 0 }
  }
  const plan = seriesFromColumns(columns, rows, x, options)
  const matrix = buildMatrix(rows, plan.seriesDefs, plan.measureKey, x.name, {
    time: plan.time,
    maxCategories: Math.max(3, options.maxCategories),
    sort: plan.time ? 'time' : 'value',
    lang: options.lang,
  })
  return {
    x,
    categories: matrix.categories,
    series: matrix.series,
    seriesKind: plan.seriesKind,
    omittedCategories: matrix.omittedCategories,
  }
}

function preparePie(columns, rows, options) {
  const measures = measureColumns(columns)
  const time = firstTimeColumn(columns)
  const dims = columns.filter((column) => column.role === 'dimension')
  const x = dims[0] ?? time ?? columns.find((column) => column.role !== 'measure')
  const measure = measures[0]
  if (x === undefined || measure === undefined) return undefined
  const map = new Map()
  for (const row of rows) {
    const value = parseNumeric(row[measure.name])
    if (value === null || value < 0) continue
    const key = distinctKey(row[x.name])
    if (!map.has(key)) map.set(key, { raw: row[x.name], label: formatCell(row[x.name], options.lang), value: 0 })
    map.get(key).value += value
  }
  let slices = [...map.values()].filter((slice) => slice.value > 0).sort((a, b) => b.value - a.value)
  if (slices.length === 0) return undefined
  let omitted = 0
  if (slices.length > 8) {
    const rest = slices.slice(7)
    omitted = rest.length
    slices = slices.slice(0, 7)
    slices.push({ raw: '__other', label: options.lang === 'zh' ? '其他' : 'Other', value: rest.reduce((sum, slice) => sum + slice.value, 0) })
  }
  const total = slices.reduce((sum, slice) => sum + slice.value, 0)
  return { x, measure, slices, total, omitted }
}

function prepareScatter(columns, rows, options) {
  const measures = measureColumns(columns)
  if (measures.length < 2) return undefined
  const dim = columns.find((column) => column.role === 'dimension' && column.distinct <= 8)
  const x = measures[0]
  const y = measures[1]
  const values = rows
    .map((row) => ({ x: parseNumeric(row[x.name]), y: parseNumeric(row[y.name]), series: dim === undefined ? undefined : row[dim.name] }))
    .filter((point) => point.x !== null && point.y !== null)
  if (values.length === 0) return undefined
  const seriesKeys = dim === undefined
    ? []
    : [...new Set(values.map((point) => distinctKey(point.series)))].slice(0, 8)
  return {
    x,
    y,
    dim,
    seriesKeys: seriesKeys.map((key) => ({
      key,
      label: formatCell(values.find((point) => distinctKey(point.series) === key)?.series, options.lang),
    })),
    points: values,
  }
}

function prepareHistogram(columns, rows, options) {
  const measure = measureColumns(columns)[0] ?? columns.find((column) => column.numeric)
  if (measure === undefined) return undefined
  const values = rows.map((row) => parseNumeric(row[measure.name])).filter((value) => value !== null)
  if (values.length === 0) return undefined
  const min = Math.min(...values)
  const max = Math.max(...values)
  const count = Math.max(5, Math.min(12, Math.round(Math.sqrt(values.length))))
  const width = max === min ? 1 : (max - min) / count
  const bins = new Array(count).fill(0)
  for (const value of values) {
    const index = max === min ? 0 : Math.min(count - 1, Math.floor((value - min) / width))
    bins[index] += 1
  }
  return {
    measure,
    bins: bins.map((value, index) => ({
      from: min + index * width,
      to: index === count - 1 ? max : min + (index + 1) * width,
      count: value,
    })),
    values,
  }
}

function svgShell({ width, height, title, subtitle, body, legend = [], lang = 'en', footer }) {
  const legendRows = legend.length > 1 ? Math.ceil(legend.length / 4) : 0
  const legendSvg = legendRows === 0 ? '' : legend.map((item, index) => {
    const column = index % 4
    const row = Math.floor(index / 4)
    const x = 32 + column * 220
    const y = 80 + row * 22
    return `<g><rect x="${x}" y="${y - 9}" width="10" height="10" rx="2" fill="${item.color}"/><text x="${x + 16}" y="${y}" font-size="12" fill="${MUTED}" font-family="ui-sans-serif, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif">${escapeXml(fitText(item.label, 190, 12))}</text></g>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="dsh-da-title dsh-da-desc">
  <title id="dsh-da-title">${escapeXml(title)}</title>
  <desc id="dsh-da-desc">${escapeXml(subtitle)}</desc>
  <defs>
    <linearGradient id="dsh-da-area" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${PALETTE[0]}" stop-opacity="0.28"/>
      <stop offset="1" stop-color="${PALETTE[0]}" stop-opacity="0.02"/>
    </linearGradient>
    <clipPath id="dsh-da-clip"><rect x="0" y="0" width="${width}" height="${height}"/></clipPath>
  </defs>
  <rect x="0" y="0" width="${width}" height="${height}" fill="${CARD}"/>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="0" fill="none" stroke="${BORDER}"/>
  <text x="32" y="38" font-size="20" font-weight="650" fill="${INK}" font-family="ui-sans-serif, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif">${escapeXml(fitText(title, width - 64, 20))}</text>
  <text x="32" y="60" font-size="12" fill="${MUTED}" font-family="ui-sans-serif, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif">${escapeXml(fitText(subtitle, width - 64, 12))}</text>
  ${legendSvg}
  ${body}
</svg>`
}

function plotFrame(width, height, hasLegend, legendRows = 0) {
  const top = hasLegend ? 90 + Math.max(1, legendRows) * 22 : 88
  return { left: 76, right: width - 30, top, bottom: height - 70 }
}

function axisSvg({ left, right, top, bottom, ticks, min, max, xLabels, xPositions, lang, rotateLabels }) {
  const plotHeight = bottom - top
  const plotWidth = right - left
  const yOf = (value) => bottom - ((value - min) / Math.max(1e-9, max - min)) * plotHeight
  const grid = ticks.map((tick) => {
    const y = yOf(tick)
    return `<line x1="${left}" y1="${y.toFixed(1)}" x2="${right}" y2="${y.toFixed(1)}" stroke="${GRID}" stroke-width="1"/><text x="${left - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${MUTED}" font-family="ui-sans-serif, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif">${escapeXml(formatNumber(tick, lang, { compact: true }))}</text>`
  }).join('')
  const rotate = rotateLabels || xLabels.some((label) => estimateTextWidth(label, 11) > 64)
  const labels = xLabels.map((label, index) => {
    const x = xPositions[index]
    const y = bottom + 20
    return rotate
      ? `<text x="${x.toFixed(1)}" y="${y}" text-anchor="end" font-size="10" fill="${MUTED}" transform="rotate(-28 ${x.toFixed(1)} ${y})" font-family="ui-sans-serif, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif">${escapeXml(fitText(label, 96, 10))}</text>`
      : `<text x="${x.toFixed(1)}" y="${y}" text-anchor="middle" font-size="10" fill="${MUTED}" font-family="ui-sans-serif, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif">${escapeXml(fitText(label, 80, 10))}</text>`
  }).join('')
  return `<g>${grid}<line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="${INK}" stroke-opacity="0.25" stroke-width="1"/>${labels}</g>`
}

function noDataSvg(width, height, message) {
  return `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-size="14" fill="${MUTED}" font-family="ui-sans-serif, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif">${escapeXml(message)}</text>`
}

function renderLineChart(data, options) {
  const { width, height, lang } = options
  const scale = niceScaleForValues(data.series.flatMap((item) => item.values), false)
  const min = scale.min
  const max = scale.max
  const legendRows = data.series.length > 1 ? Math.ceil(data.series.length / 4) : 0
  const { left, right, top, bottom } = plotFrame(width, height, legendRows > 0, legendRows)
  const plotWidth = right - left
  const plotHeight = bottom - top
  const count = data.categories.length
  const xPositions = data.categories.map((_, index) => count === 1 ? left + plotWidth / 2 : left + (index / (count - 1)) * plotWidth)
  const yOf = (value) => bottom - ((value - min) / Math.max(1e-9, max - min)) * plotHeight
  const labels = data.categories.map((category) => category.label)
  const axis = axisSvg({ left, right, top, bottom, ticks: scale.ticks, min, max, xLabels: labels, xPositions, lang, rotateLabels: count > 12 })
  const seriesSvg = data.series.map((item, seriesIndex) => {
    const color = PALETTE[seriesIndex % PALETTE.length]
    const segments = []
    let current = []
    item.values.forEach((value, index) => {
      if (value === null || value === undefined || !Number.isFinite(value)) {
        if (current.length > 0) segments.push(current)
        current = []
      } else {
        current.push([xPositions[index], yOf(value), value])
      }
    })
    if (current.length > 0) segments.push(current)
    const lines = segments.map((segment) => {
      const points = segment.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
      return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`
    }).join('')
    const area = options.type === 'area' && segments[0] !== undefined
      ? `<polygon points="${segments[0].map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')} ${xPositions[xPositions.length - 1].toFixed(1)},${bottom} ${xPositions[0].toFixed(1)},${bottom}" fill="url(#dsh-da-area)"/>`
      : ''
    const points = count <= 42
      ? item.values.map((value, index) => value === null || value === undefined || !Number.isFinite(value) ? '' : `<circle cx="${xPositions[index].toFixed(1)}" cy="${yOf(value).toFixed(1)}" r="3.2" fill="${CARD}" stroke="${color}" stroke-width="2"><title>${escapeXml(`${item.label} · ${data.categories[index].label}: ${formatNumber(value, lang)}`)}</title></circle>`).join('')
      : ''
    return `${area}${lines}${points}`
  }).join('')
  return svgShell({
    width, height, lang,
    title: data.title,
    subtitle: data.subtitle,
    legend: data.series.length > 1 ? data.series.map((item, index) => ({ label: item.label, color: PALETTE[index % PALETTE.length] })) : [],
    body: `${axis}${seriesSvg}`,
  })
}

function niceScaleForValues(values, includeZero) {
  const finite = values.filter((value) => Number.isFinite(value))
  let min = finite.length === 0 ? 0 : Math.min(...finite)
  let max = finite.length === 0 ? 1 : Math.max(...finite)
  if (includeZero) {
    min = Math.min(0, min)
    max = Math.max(0, max)
  } else {
    const padding = (max - min) * 0.08 || Math.abs(max) * 0.1 || 1
    min -= padding
    max += padding
    if (min > 0 && min < max * 0.15) min = 0
  }
  return niceTicks(min, max, 5)
}

function renderBarChart(data, options) {
  const { width, height, lang, type } = options
  const stacked = type === 'stacked_bar'
  const totals = sumByCategory(data.series, data.categories.length)
  const maxValue = stacked ? Math.max(1, ...totals) : Math.max(1, ...data.series.flatMap((item) => item.values.filter((value) => Number.isFinite(value))))
  const minValue = Math.min(0, ...(stacked ? totals : data.series.flatMap((item) => item.values.filter((value) => Number.isFinite(value)))))
  const scale = niceTicks(minValue, Math.max(0, maxValue), 5)
  const min = scale.min
  const max = scale.max
  const legendRows = data.series.length > 1 ? Math.ceil(data.series.length / 4) : 0
  const { left, right, top, bottom } = plotFrame(width, height, legendRows > 0, legendRows)
  const plotWidth = right - left
  const plotHeight = bottom - top
  const count = data.categories.length
  const band = plotWidth / Math.max(1, count)
  const groupWidth = Math.min(band * 0.78, 120)
  const barWidth = stacked ? groupWidth : groupWidth / Math.max(1, data.series.length)
  const xPositions = data.categories.map((_, index) => left + band * index + band / 2)
  const yOf = (value) => bottom - ((value - min) / Math.max(1e-9, max - min)) * plotHeight
  const zeroY = yOf(0)
  const labels = data.categories.map((category) => category.label)
  const axis = axisSvg({ left, right, top, bottom, ticks: scale.ticks, min, max, xLabels: labels, xPositions, lang, rotateLabels: count > 10 })
  const bars = []
  data.categories.forEach((category, categoryIndex) => {
    let stackedTotal = 0
    data.series.forEach((item, seriesIndex) => {
      const value = item.values[categoryIndex]
      if (!Number.isFinite(value)) return
      const color = PALETTE[seriesIndex % PALETTE.length]
      if (stacked) {
        if (value <= 0) return
        const y0 = yOf(stackedTotal)
        const y1 = yOf(stackedTotal + value)
        stackedTotal += value
        const x = xPositions[categoryIndex] - groupWidth / 2
        bars.push(`<rect x="${x.toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${groupWidth.toFixed(1)}" height="${Math.max(0.8, Math.abs(y1 - y0)).toFixed(1)}" fill="${color}" opacity="0.94"><title>${escapeXml(`${category.label} · ${item.label}: ${formatNumber(value, lang)}`)}</title></rect>`)
      } else {
        const x = xPositions[categoryIndex] - groupWidth / 2 + seriesIndex * barWidth
        const y = value >= 0 ? yOf(value) : zeroY
        const heightValue = Math.abs(zeroY - yOf(value))
        bars.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, barWidth - 2).toFixed(1)}" height="${Math.max(0.8, heightValue).toFixed(1)}" rx="3" fill="${color}" opacity="0.94"><title>${escapeXml(`${category.label} · ${item.label}: ${formatNumber(value, lang)}`)}</title></rect>`)
      }
    })
    if (data.series.length === 1 && count <= 14 && data.series[0].values[categoryIndex] !== undefined) {
      const value = data.series[0].values[categoryIndex]
      if (Number.isFinite(value)) {
        const y = yOf(value) - 7
        bars.push(`<text x="${xPositions[categoryIndex].toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" font-size="10" fill="${MUTED}" font-family="ui-sans-serif, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif">${escapeXml(formatNumber(value, lang, { compact: true }))}</text>`)
      }
    }
  })
  const legend = data.series.map((item, index) => ({ label: item.label, color: PALETTE[index % PALETTE.length] }))
  return svgShell({
    width, height, lang,
    title: data.title,
    subtitle: data.subtitle,
    legend,
    body: `${axis}${bars.join('')}`,
  })
}

function polar(cx, cy, radius, angle) {
  const radians = (angle - 90) * (Math.PI / 180)
  return [cx + radius * Math.cos(radians), cy + radius * Math.sin(radians)]
}

function arcPath(cx, cy, radius, startAngle, endAngle) {
  const [x1, y1] = polar(cx, cy, radius, endAngle)
  const [x2, y2] = polar(cx, cy, radius, startAngle)
  const large = endAngle - startAngle <= 180 ? 0 : 1
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${radius} ${radius} 0 ${large} 0 ${x2.toFixed(2)} ${y2.toFixed(2)}`
}

function pieSlicePath(cx, cy, radius, startAngle, endAngle) {
  const [sx, sy] = polar(cx, cy, radius, startAngle)
  const [ex, ey] = polar(cx, cy, radius, endAngle)
  const large = endAngle - startAngle > 180 ? 1 : 0
  return `M ${cx} ${cy} L ${sx.toFixed(2)} ${sy.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${ex.toFixed(2)} ${ey.toFixed(2)} Z`
}

function donutSlicePath(cx, cy, radius, innerRadius, startAngle, endAngle) {
  const [osx, osy] = polar(cx, cy, radius, startAngle)
  const [oex, oey] = polar(cx, cy, radius, endAngle)
  const [isx, isy] = polar(cx, cy, innerRadius, startAngle)
  const [iex, iey] = polar(cx, cy, innerRadius, endAngle)
  const large = endAngle - startAngle > 180 ? 1 : 0
  return `M ${osx.toFixed(2)} ${osy.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${oex.toFixed(2)} ${oey.toFixed(2)} L ${iex.toFixed(2)} ${iey.toFixed(2)} A ${innerRadius} ${innerRadius} 0 ${large} 0 ${isx.toFixed(2)} ${isy.toFixed(2)} Z`
}

function renderPieChart(data, options) {
  const { width, height, lang, type } = options
  const cx = 316
  const cy = 300
  const radius = 158
  const total = data.total
  if (data.slices.length === 1) {
    const slice = data.slices[0]
    const color = PALETTE[0]
    const center = type === 'donut'
      ? `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${color}" opacity="0.96"/><circle cx="${cx}" cy="${cy}" r="${radius * 0.56}" fill="${CARD}"/><text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="13" fill="${MUTED}" font-family="ui-sans-serif, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif">${escapeXml(lang === 'zh' ? '合计' : 'Total')}</text><text x="${cx}" y="${cy + 24}" text-anchor="middle" font-size="24" font-weight="650" fill="${INK}" font-family="ui-sans-serif, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif">${escapeXml(formatNumber(total, lang, { compact: true }))}</text>`
      : `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${color}" opacity="0.96"/><text x="${cx}" y="${cy + 5}" text-anchor="middle" font-size="18" font-weight="650" fill="#ffffff" font-family="ui-sans-serif, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif">100%</text>`
    const legendX = width > 760 ? 540 : 32
    const legendY = width > 760 ? 160 : 500
    const item = `<g><rect x="${legendX}" y="${legendY - 11}" width="12" height="12" rx="3" fill="${color}"/><text x="${legendX + 20}" y="${legendY}" font-size="12" fill="${INK}" font-family="ui-sans-serif, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif">${escapeXml(fitText(slice.label, 230, 12))}</text><text x="${width - 32}" y="${legendY}" text-anchor="end" font-size="12" fill="${MUTED}" font-family="ui-sans-serif, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif">${escapeXml(`${formatNumber(slice.value, lang, { compact: true })} · 100%`)}</text></g>`
    return svgShell({
      width, height, lang,
      title: data.title,
      subtitle: data.subtitle,
      legend: [],
      body: `${center}${item}`,
    })
  }
  let angle = 0
  const slices = []
  data.slices.forEach((slice, index) => {
    const share = slice.value / total
    const end = angle + share * 360
    const color = PALETTE[index % PALETTE.length]
    if (type === 'donut') {
      slices.push(`<path d="${donutSlicePath(cx, cy, radius, radius * 0.56, angle, end)}" fill="${color}" opacity="0.96"><title>${escapeXml(`${slice.label}: ${formatNumber(slice.value, lang)} (${formatPercent(share, lang)})`)}</title></path>`)
    } else {
      slices.push(`<path d="${pieSlicePath(cx, cy, radius, angle, end)}" fill="${color}" opacity="0.96"><title>${escapeXml(`${slice.label}: ${formatNumber(slice.value, lang)} (${formatPercent(share, lang)})`)}</title></path>`)
    }
    if (share >= 0.06) {
      const [lx, ly] = polar(cx, cy, radius * (type === 'donut' ? 0.78 : 0.64), angle + (end - angle) / 2)
      slices.push(`<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" font-size="11" font-weight="600" fill="#ffffff" font-family="ui-sans-serif, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif">${escapeXml(formatPercent(share, lang))}</text>`)
    }
    angle = end
  })
  if (type === 'donut') {
    slices.push(`<text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="13" fill="${MUTED}" font-family="ui-sans-serif, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif">${escapeXml(lang === 'zh' ? '合计' : 'Total')}</text><text x="${cx}" y="${cy + 24}" text-anchor="middle" font-size="24" font-weight="650" fill="${INK}" font-family="ui-sans-serif, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif">${escapeXml(formatNumber(total, lang, { compact: true }))}</text>`)
  }
  const legendX = width > 760 ? 540 : 32
  const legendY = width > 760 ? 132 : 500
  const legendItems = data.slices.map((slice, index) => {
    const y = legendY + index * 30
    return `<g><rect x="${legendX}" y="${y - 11}" width="12" height="12" rx="3" fill="${PALETTE[index % PALETTE.length]}"/><text x="${legendX + 20}" y="${y}" font-size="12" fill="${INK}" font-family="ui-sans-serif, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif">${escapeXml(fitText(slice.label, 230, 12))}</text><text x="${width - 32}" y="${y}" text-anchor="end" font-size="12" fill="${MUTED}" font-family="ui-sans-serif, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif">${escapeXml(`${formatNumber(slice.value, lang, { compact: true })} · ${formatPercent(slice.value / total, lang)}`)}</text></g>`
  }).join('')
  return svgShell({
    width, height, lang,
    title: data.title,
    subtitle: data.subtitle,
    legend: [],
    body: `${slices.join('')}${legendItems}`,
  })
}

function renderScatterChart(data, options) {
  const { width, height, lang } = options
  const legendRows = data.seriesKeys.length > 1 ? Math.ceil(data.seriesKeys.length / 4) : 0
  const { left, right, top, bottom } = plotFrame(width, height, legendRows > 0, legendRows)
  const plotWidth = right - left
  const plotHeight = bottom - top
  const xScale = niceScaleForValues(data.points.map((point) => point.x), false)
  const yScale = niceScaleForValues(data.points.map((point) => point.y), false)
  const xOf = (value) => left + ((value - xScale.min) / Math.max(1e-9, xScale.max - xScale.min)) * plotWidth
  const yOf = (value) => bottom - ((value - yScale.min) / Math.max(1e-9, yScale.max - yScale.min)) * plotHeight
  const grid = yScale.ticks.map((tick) => `<line x1="${left}" y1="${yOf(tick).toFixed(1)}" x2="${right}" y2="${yOf(tick).toFixed(1)}" stroke="${GRID}"/><text x="${left - 10}" y="${(yOf(tick) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${MUTED}" font-family="ui-sans-serif, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif">${escapeXml(formatNumber(tick, lang, { compact: true }))}</text>`).join('')
  const xTicks = xScale.ticks.map((tick) => `<text x="${xOf(tick).toFixed(1)}" y="${bottom + 20}" text-anchor="middle" font-size="11" fill="${MUTED}" font-family="ui-sans-serif, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif">${escapeXml(formatNumber(tick, lang, { compact: true }))}</text>`).join('')
  const seriesColor = (point) => {
    if (data.seriesKeys.length === 0) return PALETTE[0]
    const index = data.seriesKeys.findIndex((item) => item.key === distinctKey(point.series))
    return PALETTE[Math.max(0, index) % PALETTE.length]
  }
  const points = data.points.map((point) => `<circle cx="${xOf(point.x).toFixed(1)}" cy="${yOf(point.y).toFixed(1)}" r="4.2" fill="${seriesColor(point)}" opacity="0.7"><title>${escapeXml(`${data.x.name}: ${formatNumber(point.x, lang)} · ${data.y.name}: ${formatNumber(point.y, lang)}`)}</title></circle>`).join('')
  const axis = `${grid}<line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="${INK}" stroke-opacity="0.25"/>${xTicks}`
  return svgShell({
    width, height, lang,
    title: data.title,
    subtitle: data.subtitle,
    legend: data.seriesKeys.length > 1 ? data.seriesKeys.map((item, index) => ({ label: item.label, color: PALETTE[index % PALETTE.length] })) : [],
    body: `${axis}${points}<text x="${(left + right) / 2}" y="${height - 32}" text-anchor="middle" font-size="11" fill="${MUTED}" font-family="ui-sans-serif, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif">${escapeXml(data.x.name)}</text><text x="18" y="${(top + bottom) / 2}" text-anchor="middle" font-size="11" fill="${MUTED}" transform="rotate(-90 18 ${(top + bottom) / 2})" font-family="ui-sans-serif, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif">${escapeXml(data.y.name)}</text>`,
  })
}

function renderHistogramChart(data, options) {
  const { width, height, lang } = options
  const maxCount = Math.max(1, ...data.bins.map((bin) => bin.count))
  const scale = niceTicks(0, maxCount, 4)
  const { left, right, top, bottom } = plotFrame(width, height, false)
  const plotWidth = right - left
  const plotHeight = bottom - top
  const band = plotWidth / data.bins.length
  const yOf = (value) => bottom - (value / Math.max(1e-9, scale.max)) * plotHeight
  const grid = scale.ticks.map((tick) => `<line x1="${left}" y1="${yOf(tick).toFixed(1)}" x2="${right}" y2="${yOf(tick).toFixed(1)}" stroke="${GRID}"/><text x="${left - 10}" y="${(yOf(tick) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${MUTED}" font-family="ui-sans-serif, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif">${escapeXml(formatNumber(tick, lang))}</text>`).join('')
  const bars = data.bins.map((bin, index) => {
    const x = left + index * band + band * 0.08
    const y = yOf(bin.count)
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, band * 0.84).toFixed(1)}" height="${Math.max(0.8, bottom - y).toFixed(1)}" rx="3" fill="${PALETTE[index % PALETTE.length]}" opacity="0.9"><title>${escapeXml(`${formatNumber(bin.from, lang)} – ${formatNumber(bin.to, lang)}: ${bin.count}`)}</title></rect>`
  }).join('')
  const labels = data.bins.map((bin, index) => {
    if (data.bins.length > 8 && index % 2 !== 0) return ''
    const x = left + index * band + band / 2
    return `<text x="${x.toFixed(1)}" y="${bottom + 20}" text-anchor="middle" font-size="10" fill="${MUTED}" font-family="ui-sans-serif, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif">${escapeXml(formatNumber(bin.from, lang, { compact: true }))}</text>`
  }).join('')
  return svgShell({
    width, height, lang,
    title: data.title,
    subtitle: data.subtitle,
    body: `${grid}<line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="${INK}" stroke-opacity="0.25"/>${bars}${labels}<text x="${(left + right) / 2}" y="${height - 30}" text-anchor="middle" font-size="11" fill="${MUTED}" font-family="ui-sans-serif, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif">${escapeXml(data.measure.name)}</text>`,
  })
}

function renderKpi(data, options) {
  const { width, height, lang } = options
  const value = formatNumber(data.value, lang, { compact: false })
  const fontSize = value.length > 16 ? 40 : value.length > 10 ? 54 : 68
  return svgShell({
    width, height, lang,
    title: data.title,
    subtitle: data.subtitle,
    body: `<text x="${width / 2}" y="${height / 2 - 8}" text-anchor="middle" font-size="${fontSize}" font-weight="700" fill="${INK}" font-family="ui-sans-serif, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif">${escapeXml(value)}</text><text x="${width / 2}" y="${height / 2 + 38}" text-anchor="middle" font-size="14" fill="${MUTED}" font-family="ui-sans-serif, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif">${escapeXml(data.measure.name)}</text>`,
  })
}

/**
 * Render a Markdown table for plain-data output.
 * @param {Array<{name: string}>} columns columns
 * @param {Record<string, unknown>[]} rows rows
 * @param {{maxRows?: number, maxColumns?: number, lang?: 'en'|'zh'}} options options
 * @returns {string} Markdown table
 */
export function renderMarkdownTable(columns, rows, options = {}) {
  const lang = options.lang ?? 'en'
  const maxRows = options.maxRows ?? 20
  const maxColumns = options.maxColumns ?? 8
  const chosen = columns.slice(0, maxColumns)
  if (chosen.length === 0) return lang === 'zh' ? '_没有可展示的列。_' : '_No columns to display._'
  const header = `| ${chosen.map((column) => escapeMarkdown(column.name)).join(' | ')} |`
  const align = `| ${chosen.map((column) => (column.numeric === true ? '---:' : '---')).join(' | ')} |`
  const body = rows.slice(0, maxRows).map((row) => `| ${chosen.map((column) => escapeMarkdown(formatCell(row[column.name], lang))).join(' | ')} |`).join('\n')
  const more = rows.length > maxRows
    ? `\n\n_${lang === 'zh' ? `仅显示前 ${maxRows} 行，共 ${rows.length} 行。` : `Showing the first ${maxRows} of ${rows.length} rows.`}_`
    : ''
  return `${header}\n${align}\n${body || `| ${chosen.map(() => '—').join(' | ')} |`}${more}`
}

function escapeMarkdown(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ').replaceAll('\r', ' ')
}

/**
 * Build a complete chart: auto choice, data shaping, and SVG.
 * @param {Array<Record<string, any>>} columns inferred columns
 * @param {Record<string, unknown>[]} rows rows
 * @param {{chartType?: string, title: string, subtitle: string, width: number, height: number, lang: 'en'|'zh', maxCategories?: number}} options options
 * @returns {{type: string, title: string, subtitle: string, svg: string|null, markdownTable: string|null, reason: string, note?: string, spec: any}} chart
 */
export function buildChart(columns, rows, options) {
  const choice = chooseChart(columns, rows, { lang: options.lang, requested: options.chartType })
  const type = choice.type
  const width = options.width
  const height = options.height
  const lang = options.lang
  const maxCategories = options.maxCategories ?? 24
  const base = {
    title: options.title,
    subtitle: options.subtitle,
    type,
    reason: choice.reason,
    ...(choice.note === undefined ? {} : { note: choice.note }),
    width,
    height,
  }
  if (type === 'table') {
    return {
      ...base,
      svg: null,
      markdownTable: renderMarkdownTable(columns, rows, { lang, maxRows: 20 }),
      spec: { type: 'table', columns: columns.map((column) => ({ name: column.name, role: column.role })) },
    }
  }
  if (type === 'kpi') {
    const measure = measureColumns(columns)[0]
    const value = measure === undefined ? undefined : parseNumeric(rows[0]?.[measure.name])
    if (value === undefined || value === null) {
      return { ...base, type: 'table', svg: null, markdownTable: renderMarkdownTable(columns, rows, { lang }), spec: { type: 'table' } }
    }
    const data = { ...base, value, measure }
    return { ...base, svg: renderKpi(data, { width, height, lang }), markdownTable: null, spec: { type: 'kpi', value, label: measure.name } }
  }
  if (type === 'pie' || type === 'donut') {
    const pie = preparePie(columns, rows, { lang })
    if (pie === undefined) {
      const fallback = chooseChart(columns, rows, { lang, requested: 'bar' })
      return buildChart(columns, rows, { ...options, chartType: fallback.type, title: options.title })
    }
    const data = { ...base, ...pie }
    return {
      ...base,
      svg: renderPieChart(data, { width, height, lang, type }),
      markdownTable: null,
      spec: { type, total: pie.total, slices: pie.slices.map((slice) => ({ label: slice.label, value: slice.value })) },
    }
  }
  if (type === 'scatter') {
    const scatter = prepareScatter(columns, rows, { lang })
    if (scatter === undefined) {
      return { ...base, type: 'table', svg: null, markdownTable: renderMarkdownTable(columns, rows, { lang }), spec: { type: 'table' } }
    }
    const data = { ...base, ...scatter }
    return {
      ...base,
      svg: renderScatterChart(data, { width, height, lang }),
      markdownTable: null,
      spec: { type, x: scatter.x.name, y: scatter.y.name, points: scatter.points.length },
    }
  }
  if (type === 'histogram') {
    const histogram = prepareHistogram(columns, rows, { lang })
    if (histogram === undefined) {
      return { ...base, type: 'table', svg: null, markdownTable: renderMarkdownTable(columns, rows, { lang }), spec: { type: 'table' } }
    }
    const data = { ...base, ...histogram }
    return {
      ...base,
      svg: renderHistogramChart(data, { width, height, lang }),
      markdownTable: null,
      spec: { type, measure: histogram.measure.name, bins: histogram.bins.length },
    }
  }
  const categorical = prepareCategorical(columns, rows, { lang, maxCategories })
  if (categorical === undefined || categorical.categories.length === 0) {
    return { ...base, type: 'table', svg: null, markdownTable: renderMarkdownTable(columns, rows, { lang }), spec: { type: 'table' } }
  }
  const data = { ...base, ...categorical }
  const svg = type === 'line' || type === 'area'
    ? renderLineChart(data, { width, height, lang, type })
    : renderBarChart(data, { width, height, lang, type })
  return {
    ...base,
    svg,
    markdownTable: null,
    spec: {
      type,
      x: categorical.x.name,
      series: categorical.series.map((item) => ({ label: item.label, values: item.values })),
      categories: categorical.categories.map((category) => category.label),
      ...(categorical.omittedCategories > 0 ? { omittedCategories: categorical.omittedCategories } : {}),
    },
  }
}
