window.__ModuleLoader__.load({
  id: 'dsh-data-analyst',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-data-analyst'
    const MARKER = /<!--dsh-data-analyst:([A-Za-z0-9_-]+)-->/u

    const DICT = {
      en: {
        analyze: 'Data analysis',
        visualize: 'Data visualization',
        analyzing: 'Analyzing the database…',
        rows: 'rows',
        capped: 'capped',
        readOnly: 'read-only',
        details: 'SQL & details',
        sql: 'SQL',
        observations: 'Observations',
        openChart: 'Open chart',
        copySql: 'Copy SQL',
        copied: 'Copied',
        failed: 'Analysis failed',
        noChart: 'This result has no chart; the data summary is below.',
        chart: 'chart',
      },
      zh: {
        analyze: '数据分析',
        visualize: '数据可视化',
        analyzing: '正在分析数据库…',
        rows: '行',
        capped: '已截断',
        readOnly: '只读',
        details: 'SQL 与细节',
        sql: 'SQL',
        observations: '数据观察',
        openChart: '打开图表',
        copySql: '复制 SQL',
        copied: '已复制',
        failed: '分析失败',
        noChart: '该结果没有图表，数据摘要如下。',
        chart: '图表',
      },
    }

    const CSS = `
      .dsh-da-card{margin:6px 0 6px 4px;border:.5px solid var(--dsw-alias-border-l1,rgba(15,23,42,.14));border-radius:12px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#0f172a);overflow:hidden;font-family:ui-sans-serif,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;max-width:920px}
      .dsh-da-head{display:flex;align-items:center;gap:9px;padding:10px 13px;border-bottom:.5px solid var(--dsw-alias-border-l1,rgba(15,23,42,.1));background:linear-gradient(180deg,rgba(15,118,110,.055),transparent)}
      .dsh-da-icon{width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,#0f766e,#1d4ed8);display:inline-flex;align-items:center;justify-content:center;flex:none;color:#fff}
      .dsh-da-heading{min-width:0;flex:1}
      .dsh-da-title{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:20px}
      .dsh-da-meta{font-size:11px;color:var(--dsw-alias-label-caption,#64748b);line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .dsh-da-badge{font-size:10px;letter-spacing:.02em;text-transform:uppercase;padding:2px 7px;border-radius:999px;background:rgba(15,118,110,.1);color:#0f766e;border:.5px solid rgba(15,118,110,.18);flex:none}
      .dsh-da-body{padding:10px 12px 12px}
      .dsh-da-img{display:block;width:100%;height:auto;border-radius:8px;border:.5px solid var(--dsw-alias-border-l1,rgba(15,23,42,.12));background:#fff}
      .dsh-da-running{display:flex;align-items:center;gap:9px;padding:14px 13px;color:var(--dsw-alias-label-secondary,#475569);font-size:12px}
      .dsh-da-spinner{width:14px;height:14px;border:2px solid rgba(15,118,110,.2);border-top-color:#0f766e;border-radius:50%;animation:dsh-da-spin .8s linear infinite}
      @keyframes dsh-da-spin{to{transform:rotate(360deg)}}
      .dsh-da-error{padding:12px 14px;color:var(--dsw-alias-state-error-primary,#b91c1c);font-size:12px;white-space:pre-wrap;word-break:break-word}
      .dsh-da-pre{margin:0;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-markdown-code-block,#f8fafc);color:var(--dsw-alias-label-secondary,#334155);font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;word-break:break-word;max-height:360px;overflow:auto}
      .dsh-da-details{margin-top:10px;font-size:12px;color:var(--dsw-alias-label-secondary,#475569)}
      .dsh-da-details summary{cursor:pointer;color:var(--dsw-alias-label-caption,#64748b);font-size:11px;user-select:none;padding:2px 0}
      .dsh-da-details h4{margin:10px 0 5px;font-size:11px;color:var(--dsw-alias-label-caption,#64748b);font-weight:600;letter-spacing:.02em;text-transform:uppercase}
      .dsh-da-details ul{margin:0;padding-left:18px;line-height:1.65}
      .dsh-da-actions{display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap}
      .dsh-da-action{appearance:none;border:.5px solid var(--dsw-alias-border-l2,rgba(15,23,42,.16));background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-secondary,#475569);border-radius:7px;padding:4px 9px;font-size:11px;cursor:pointer;text-decoration:none;line-height:18px}
      .dsh-da-action:hover{background:var(--dsw-alias-bg-l2,#f8fafc);color:var(--dsw-alias-label-primary,#0f172a)}
      .dsh-da-note{color:var(--dsw-alias-label-caption,#64748b);font-size:11px;line-height:1.6;margin:8px 0 0}
      .dsh-da-nochart{color:var(--dsw-alias-label-caption,#64748b);font-size:12px;margin:0 0 8px}
      @media (max-width:640px){.dsh-da-badge{display:none}.dsh-da-head{padding:9px 11px}.dsh-da-body{padding:8px 9px 10px}}
    `

    /**
     * @param {string} text tool result text
     * @returns {any|null} chart metadata
     */
    function decodeMarker(text) {
      const match = MARKER.exec(String(text ?? ''))
      if (match === null) return null
      try {
        const base64 = match[1].replaceAll('-', '+').replaceAll('_', '/')
        const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
        const binary = atob(padded)
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
        return JSON.parse(new TextDecoder().decode(bytes))
      } catch {
        return null
      }
    }

    /**
     * @param {any} block tool result node
     * @returns {string} text content
     */
    function textOf(block) {
      if (block === null || typeof block !== 'object') return ''
      if (Array.isArray(block.content)) {
        return block.content
          .filter((part) => part?.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text)
          .join('\n')
      }
      if (typeof block.output === 'string') return block.output
      return ''
    }

    function cleanText(text) {
      return String(text ?? '')
        .replace(MARKER, '')
        .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
        .trim()
    }

    function formatNumber(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return String(value ?? '')
      try {
        return new Intl.NumberFormat(document.documentElement.lang || 'en', { maximumFractionDigits: 2 }).format(value)
      } catch {
        return String(value)
      }
    }

    function ChartIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M4 19V8m5 11V5m5 14v-7m5 7V9', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' }),
        h('path', { d: 'M3 21h18', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' }))
    }

    function Row(t) {
      return function DataAnalystRow(props) {
        const { block, phase, toolName } = props
        const [imageFailed, setImageFailed] = React.useState(false)
        const [copied, setCopied] = React.useState(false)
        const text = textOf(block)
        const meta = decodeMarker(text)
        const running = phase === 'preparing' || phase === 'start'
        const failed = block?.isError === true
        const title = meta?.title ?? (toolName === 'db_visualize' ? t('visualize') : t('analyze'))
        const chartType = typeof meta?.chartType === 'string' ? meta.chartType : ''
        const sql = typeof meta?.sql === 'string' ? meta.sql : ''
        const observations = Array.isArray(meta?.observations)
          ? meta.observations
          : String(text).split(/\n/u).filter((line) => line.startsWith('- ')).map((line) => line.slice(2))
        const detailText = cleanText(text)

        async function copySql() {
          if (sql === '') return
          try {
            await navigator.clipboard.writeText(sql)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          } catch {
            // Clipboard is optional.
          }
        }

        const metaLine = meta === null
          ? ''
          : [
              `${formatNumber(meta.rows)} ${t('rows')}`,
              meta.truncated ? t('capped') : null,
              typeof meta.durationMs === 'number' ? `${formatNumber(meta.durationMs)} ms` : null,
              meta.connection ? String(meta.connection) : null,
              t('readOnly'),
            ].filter(Boolean).join(' · ')

        const header = h('div', { className: 'dsh-da-head' },
          h('span', { className: 'dsh-da-icon' }, h(ChartIcon)),
          h('div', { className: 'dsh-da-heading' },
            h('div', { className: 'dsh-da-title' }, title),
            h('div', { className: 'dsh-da-meta' }, running ? t('analyzing') : metaLine)),
          chartType !== '' ? h('span', { className: 'dsh-da-badge' }, chartType === 'table' ? 'table' : chartType) : null)

        if (running) {
          return h('div', { className: 'dsh-da-card', 'data-tool': toolName },
            header,
            h('div', { className: 'dsh-da-running' }, h('span', { className: 'dsh-da-spinner' }), t('analyzing')))
        }

        if (failed) {
          const errorText = detailText || (block?.error?.message ?? t('failed'))
          return h('div', { className: 'dsh-da-card', 'data-tool': toolName },
            header,
            h('div', { className: 'dsh-da-error' }, errorText))
        }

        const image = meta?.url && !imageFailed
          ? h('img', {
              className: 'dsh-da-img',
              src: meta.url,
              alt: `${chartType} ${t('chart')}: ${title}`,
              loading: 'lazy',
              onError: () => setImageFailed(true),
            })
          : null

        const noImage = meta?.url && imageFailed
          ? h('p', { className: 'dsh-da-nochart' }, t('noChart'))
          : null

        const actions = h('div', { className: 'dsh-da-actions' },
          meta?.url ? h('a', { className: 'dsh-da-action', href: meta.url, target: '_blank', rel: 'noopener noreferrer' }, t('openChart')) : null,
          sql !== '' ? h('button', { type: 'button', className: 'dsh-da-action', onClick: copySql }, copied ? t('copied') : t('copySql')) : null)

        const details = h('details', { className: 'dsh-da-details' },
          h('summary', null, t('details')),
          observations.length > 0
            ? h('div', null,
                h('h4', null, t('observations')),
                h('ul', null, observations.map((line, index) => h('li', { key: index }, String(line)))))
            : null,
          meta?.notes ? h('p', { className: 'dsh-da-note' }, String(meta.notes)) : null,
          sql !== ''
            ? h('div', null,
                h('h4', null, t('sql')),
                h('pre', { className: 'dsh-da-pre' }, sql))
            : null,
          meta?.url === '' || meta === null
            ? h('pre', { className: 'dsh-da-pre' }, detailText)
            : null)

        return h('div', { className: 'dsh-da-card', 'data-tool': toolName },
          header,
          h('div', { className: 'dsh-da-body' },
            image,
            noImage,
            actions,
            details))
      }
    }

    return {
      name: 'data-analyst-client',
      inject: ['slots', 'locale'],
      apply(ctx) {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-data-analyst'
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove())

        let t = (key) => DICT.en[key] ?? key
        try {
          const locale = ctx.locale
          if (locale !== undefined) {
            for (const language of ['en', 'zh']) {
              ctx.effect(() => locale.register(NS, language, DICT[language]))
            }
            t = locale.bind(NS)
          }
        } catch (error) {
          console.error(`[dsh-data-analyst] client locale registration failed: ${error instanceof Error ? error.message : String(error)}`)
        }

        const DataAnalystRow = Row(t)
        ctx.slots.inject('tool.call.toolview', function* () {
          yield ctx.slots.register({ name: 'tool.call.toolview', key: 'db_analyze' }, DataAnalystRow)
          yield ctx.slots.register({ name: 'tool.call.toolview', key: 'db_visualize' }, DataAnalystRow)
        })
      },
    }
  },
})
