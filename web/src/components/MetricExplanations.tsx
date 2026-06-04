import { useState } from 'react'
import { tpl, useT } from '../i18n'
import type { Language, MetricExplainItem } from '../types'
import { localizeMetric } from '../utils/metricLocalization'

interface Props {
  items: MetricExplainItem[]
}

interface MetricTableGroup {
  table: string
  label: string
  items: MetricExplainItem[]
}

function tableNameOf(column: string) {
  const parts = column.split('.')
  if (parts.length <= 1) return column
  return parts.slice(0, -1).join('.')
}

function columnNameOf(column: string) {
  const parts = column.split('.')
  return parts[parts.length - 1] || column
}

function labelForTable(table: string, lang: Language) {
  const zh = lang === 'zh'
  switch (table) {
    case 'ms_v_stk_hsi_daily':
      return zh ? '恒指日线加工表' : 'HSI daily derived table'
    case 'ms_t_stk_sis':
      return zh ? '个股行情加工列' : 'Stock trading derived columns'
    case 'ms_t_stk_hsi':
      return zh ? '恒指行情加工列' : 'HSI trading derived columns'
    case 'ms_v_stock_capital':
      return zh ? '市值数据加工列' : 'Market cap derived columns'
    case 'sehknews':
      return zh ? '公告数据加工列' : 'Announcement derived columns'
    default:
      return table
  }
}

function groupByTable(items: MetricExplainItem[], lang: Language): MetricTableGroup[] {
  const byTable = new Map<string, MetricExplainItem[]>()
  for (const item of items) {
    const table = tableNameOf(item.column)
    byTable.set(table, [...(byTable.get(table) ?? []), item])
  }
  return Array.from(byTable.entries())
    .map(([table, groupItems]) => ({
      table,
      label: labelForTable(table, lang),
      items: groupItems,
    }))
    .sort((a, b) => a.table.localeCompare(b.table))
}

function filenameFromDisposition(disposition: string | null, fallback: string) {
  const match = (disposition ?? '').match(/filename="([^"]+)"/)
  return match?.[1] ?? fallback
}

function fallbackTableFilename(table: string) {
  return `${table.replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'feature'}.txt`
}

export function MetricExplanations({ items }: Props) {
  const { lang, t } = useT()
  const localizedItems = items.map((item) => localizeMetric(item, lang))
  const groups = groupByTable(localizedItems, lang)
  const [open, setOpen] = useState(false)
  const [activeTable, setActiveTable] = useState<string | null>(groups[0]?.table ?? null)
  const [scriptOpenTable, setScriptOpenTable] = useState<string | null>(null)
  const [scriptTexts, setScriptTexts] = useState<Record<string, string>>({})
  const [scriptFiles, setScriptFiles] = useState<Record<string, string>>({})
  const [scriptTypes, setScriptTypes] = useState<Record<string, string>>({})
  const [scriptLoadingTable, setScriptLoadingTable] = useState<string | null>(null)
  const [detailOpenTable, setDetailOpenTable] = useState<string | null>(null)

  if (groups.length === 0) return null

  const selectedTable = groups.some((group) => group.table === activeTable) ? activeTable : groups[0].table
  const selectedGroup = groups.find((group) => group.table === selectedTable) ?? groups[0]

  async function fetchTableScript(group: MetricTableGroup) {
    const cached = scriptTexts[group.table]
    if (cached) return cached
    setScriptLoadingTable(group.table)
    try {
      const columns = group.items.map((item) => item.column).join(',')
      const response = await fetch(
        `/api/feature-reproduction/script?table=${encodeURIComponent(group.table)}&columns=${encodeURIComponent(columns)}`,
      )
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const text = await response.text()
      const filename = filenameFromDisposition(response.headers.get('Content-Disposition'), fallbackTableFilename(group.table))
      setScriptTexts((prev) => ({ ...prev, [group.table]: text }))
      setScriptFiles((prev) => ({ ...prev, [group.table]: filename }))
      setScriptTypes((prev) => ({ ...prev, [group.table]: response.headers.get('Content-Type') ?? 'text/plain;charset=utf-8' }))
      return text
    } finally {
      setScriptLoadingTable(null)
    }
  }

  async function toggleTableScript(group: MetricTableGroup) {
    if (scriptOpenTable !== group.table) {
      await fetchTableScript(group)
      setScriptOpenTable(group.table)
      return
    }
    setScriptOpenTable(null)
  }

  async function copyTableScript(group: MetricTableGroup) {
    const text = await fetchTableScript(group)
    await navigator.clipboard.writeText(text)
  }

  async function downloadTableScript(group: MetricTableGroup) {
    const text = await fetchTableScript(group)
    const blob = new Blob([text], { type: scriptTypes[group.table] ?? 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = scriptFiles[group.table] ?? fallbackTableFilename(group.table)
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="metric-explanations">
      <div className="metric-actions">
        <button
          type="button"
          className={`metric-toggle ${open ? 'open' : ''}`}
          onClick={() => setOpen((v) => !v)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18l6-6-6-6"/>
          </svg>
          {tpl(t('metricToggle'), { count: groups.length })}
          <span className={`metric-toggle-arrow ${open ? 'open' : ''}`}>▾</span>
        </button>
      </div>

      {open && (
        <div className="metric-panel">
          <div className="metric-tabs" role="tablist">
            {groups.map((group) => (
              <button
                key={group.table}
                role="tab"
                aria-selected={selectedGroup.table === group.table}
                className={`metric-tab ${selectedGroup.table === group.table ? 'active' : ''}`}
                onClick={() => setActiveTable(group.table)}
                title={group.table}
              >
                {group.label}
              </button>
            ))}
          </div>

          <div className="metric-card">
            <div className="metric-card-title">
              <span className="metric-name">{selectedGroup.label}</span>
              <code className="metric-column">{selectedGroup.table}</code>
            </div>

            <div className="metric-section">
              <div className="metric-section-label">{t('metricUsedColumns')}</div>
              <div className="metric-used-list">
                {selectedGroup.items.map((item) => (
                  <div key={item.column} className="metric-used-row">
                    <div className="metric-used-key">
                      <code>{columnNameOf(item.column)}</code>
                      <span>{item.name}</span>
                    </div>
                    <div className="metric-used-explain">{item.explain}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="metric-section">
              <div className="metric-section-label">{t('metricItemScript')}</div>
              <div className="metric-item-script-actions">
                <button
                  type="button"
                  className="metric-script-btn primary"
                  onClick={() => toggleTableScript(selectedGroup)}
                  disabled={scriptLoadingTable === selectedGroup.table}
                >
                  {scriptOpenTable === selectedGroup.table ? t('metricHideItemScript') : t('metricViewItemScript')}
                </button>
                <button
                  type="button"
                  className="metric-script-btn"
                  onClick={() => copyTableScript(selectedGroup)}
                  disabled={scriptLoadingTable === selectedGroup.table}
                >
                  {t('metricCopyItemScript')}
                </button>
                <button
                  type="button"
                  className="metric-script-btn download"
                  onClick={() => downloadTableScript(selectedGroup)}
                  disabled={scriptLoadingTable === selectedGroup.table}
                >
                  {t('metricDownloadItemScript')}
                </button>
              </div>
              {scriptOpenTable === selectedGroup.table && (
                <div className="metric-script-panel metric-item-script-panel">
                  <div className="metric-script-header">
                    <span>{t('metricItemScript')}</span>
                    <span>{scriptLoadingTable === selectedGroup.table ? t('metricScriptLoading') : (scriptFiles[selectedGroup.table] ?? fallbackTableFilename(selectedGroup.table))}</span>
                  </div>
                  <pre className="metric-script-code"><code>{scriptTexts[selectedGroup.table] ?? ''}</code></pre>
                </div>
              )}
            </div>

            <div className="metric-section">
              <button
                type="button"
                className="metric-detail-toggle"
                onClick={() => setDetailOpenTable((current) => current === selectedGroup.table ? null : selectedGroup.table)}
              >
                {detailOpenTable === selectedGroup.table ? t('metricHideTechnicalDetails') : t('metricViewTechnicalDetails')}
              </button>
              {detailOpenTable === selectedGroup.table && (
                <div className="metric-detail-list">
                  {selectedGroup.items.map((item) => (
                    <div key={item.column} className="metric-detail-item">
                      <div className="metric-detail-title">
                        <span>{item.name}</span>
                        <code>{item.column}</code>
                      </div>
                      <pre className="metric-code"><code>{item.code}</code></pre>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
