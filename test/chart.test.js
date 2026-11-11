import test from 'node:test'
import assert from 'node:assert/strict'
import { inferColumns } from '../lib/infer.js'
import { buildChart, chooseChart, renderMarkdownTable } from '../lib/chart.js'

const opts = { title: 'Demo', subtitle: 'demo · read-only', width: 960, height: 560, lang: 'en', maxCategories: 24 }

test('time plus measure chooses a line chart', () => {
  const rows = [
    { month: '2024-01', revenue: 10 },
    { month: '2024-02', revenue: 12 },
    { month: '2024-03', revenue: 9 },
  ]
  const columns = inferColumns([{ name: 'month', type: 'text' }, { name: 'revenue', type: 'numeric' }], rows)
  const choice = chooseChart(columns, rows)
  assert.equal(choice.type, 'line')
  const chart = buildChart(columns, rows, opts)
  assert.equal(chart.type, 'line')
  assert.match(chart.svg, /<svg/)
  assert.match(chart.svg, /2024-01/)
})

test('part-to-whole chooses a donut and renders closed rings', () => {
  const rows = [
    { category: 'A', share: 60 },
    { category: 'B', share: 40 },
  ]
  const columns = inferColumns([{ name: 'category', type: 'text' }, { name: 'share', type: 'numeric' }], rows)
  const chart = buildChart(columns, rows, opts)
  assert.equal(chart.type, 'donut')
  assert.match(chart.svg, /<path/)
  assert.ok((chart.svg.match(/<path/gu) ?? []).length >= 2)
})

test('escapes data text in SVG', () => {
  const rows = [
    { label: '<script>alert(1)</script>', value: 1 },
    { label: 'safe', value: 2 },
  ]
  const columns = inferColumns([{ name: 'label', type: 'text' }, { name: 'value', type: 'numeric' }], rows)
  const chart = buildChart(columns, rows, opts)
  assert.ok(!chart.svg.includes('<script>'))
  assert.ok(chart.svg.includes('&lt;script&gt;'))
})

test('single row single measure chooses KPI', () => {
  const rows = [{ total: 42 }]
  const columns = inferColumns([{ name: 'total', type: 'numeric' }], rows)
  assert.equal(chooseChart(columns, rows).type, 'kpi')
  assert.match(buildChart(columns, rows, opts).svg, /42/)
})

test('empty result falls back to a table', () => {
  const chart = buildChart([], [], opts)
  assert.equal(chart.type, 'table')
  assert.match(chart.markdownTable, /No columns/)
})

test('markdown table escapes pipes', () => {
  const markdown = renderMarkdownTable([{ name: 'a' }, { name: 'b' }], [{ a: 'x|y', b: 1 }], { lang: 'en' })
  assert.ok(markdown.includes('x\\|y'))
})
