import { useState } from 'react'
import { tpl, useT } from '../i18n'
import type { Language, MetricExplainItem } from '../types'
import { localizeMetric } from '../utils/metricLocalization'

interface Props {
  items: MetricExplainItem[]
  sqlStatements?: string[]
}

interface MetricTableGroup {
  table: string
  label: string
  items: MetricExplainItem[]
}

type ChainSection = 'preparation' | 'query' | 'calculation'

const DEFAULT_OPEN_SECTIONS: ChainSection[] = ['preparation', 'query', 'calculation']

function tableNameOf(column: string) {
  const parts = column.split('.')
  if (parts.length <= 1) return column
  return parts.slice(0, -1).join('.')
}

function labelForTable(table: string, lang: Language) {
  const zh = lang === 'zh'
  switch (table) {
    case 'ms_v_stk_hsi_daily':
      return zh ? '恒指日线计算' : 'HSI daily calculation'
    case 'ms_t_stk_sis':
      return zh ? '个股行情计算' : 'Stock trading calculation'
    case 'ms_t_stk_hsi':
      return zh ? '恒指行情计算' : 'HSI trading calculation'
    case 'ms_v_stock_capital':
      return zh ? '市值数据计算' : 'Market cap calculation'
    case 'sehknews':
      return zh ? '公告数据计算' : 'Announcement date calculation'
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

function fallbackTableFilename(table: string) {
  return `${table.replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'feature'}.txt`
}

function buildChainText(group: MetricTableGroup, preparationScript: string, querySQL: string, t: ReturnType<typeof useT>['t']) {
  const lines: string[] = []
  lines.push(`${group.label} (${group.table})`)
  lines.push('')
  lines.push(t('metricDataPreparation'))
  lines.push(preparationScript.trim() || t('metricNoPreparationScript'))
  lines.push('')
  lines.push(t('metricDataQuery'))
  lines.push(querySQL.trim() || t('metricNoQueryScript'))
  lines.push('')
  lines.push(t('metricFieldCalculation'))
  for (const item of group.items) {
    lines.push('')
    lines.push(`${item.name} (${item.column})`)
    if (item.explain) lines.push(item.explain)
    if (item.code) lines.push(item.code)
  }
  return lines.join('\n')
}

export function MetricExplanations({ items, sqlStatements = [] }: Props) {
  const { lang, t } = useT()
  const localizedItems = items.map((item) => localizeMetric(item, lang))
  const groups = groupByTable(localizedItems, lang)
  const [open, setOpen] = useState(false)
  const [activeTable, setActiveTable] = useState<string | null>(groups[0]?.table ?? null)
  const [scriptOpenTable, setScriptOpenTable] = useState<string | null>(null)
  const [scriptTexts, setScriptTexts] = useState<Record<string, string>>({})
  const [scriptLoadingTable, setScriptLoadingTable] = useState<string | null>(null)
  const [openSections, setOpenSections] = useState<Record<string, ChainSection[]>>({})

  if (groups.length === 0) return null

  const selectedTable = groups.some((group) => group.table === activeTable) ? activeTable : groups[0].table
  const selectedGroup = groups.find((group) => group.table === selectedTable) ?? groups[0]
  const querySQL = sqlStatements.join('\n\n')

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
      setScriptTexts((prev) => ({ ...prev, [group.table]: text }))
      return text
    } finally {
      setScriptLoadingTable(null)
    }
  }

  async function buildTableChain(group: MetricTableGroup) {
    const preparationScript = await fetchTableScript(group)
    return buildChainText(group, preparationScript, querySQL, t)
  }

  async function toggleTableScript(group: MetricTableGroup) {
    if (scriptOpenTable !== group.table) {
      await fetchTableScript(group)
      setOpenSections((prev) => ({ ...prev, [group.table]: prev[group.table] ?? DEFAULT_OPEN_SECTIONS }))
      setScriptOpenTable(group.table)
      return
    }
    setScriptOpenTable(null)
  }

  function isSectionOpen(table: string, section: ChainSection) {
    return (openSections[table] ?? DEFAULT_OPEN_SECTIONS).includes(section)
  }

  function toggleSection(table: string, section: ChainSection) {
    setOpenSections((prev) => {
      const current = prev[table] ?? DEFAULT_OPEN_SECTIONS
      const next = current.includes(section)
        ? current.filter((item) => item !== section)
        : [...current, section]
      return { ...prev, [table]: next }
    })
  }

  async function copyTableScript(group: MetricTableGroup) {
    const text = await buildTableChain(group)
    await navigator.clipboard.writeText(text)
  }

  async function downloadTableScript(group: MetricTableGroup) {
    const text = await buildTableChain(group)
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fallbackTableFilename(group.table)
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
                  <div className="metric-detail-list">
                    <div className="metric-detail-item">
                      <button
                        type="button"
                        className="metric-detail-title metric-detail-title-button"
                        onClick={() => toggleSection(selectedGroup.table, 'preparation')}
                      >
                        <span>{t('metricDataPreparation')}</span>
                        <span className={`metric-detail-arrow ${isSectionOpen(selectedGroup.table, 'preparation') ? 'open' : ''}`}>›</span>
                      </button>
                      {isSectionOpen(selectedGroup.table, 'preparation') && (
                        <pre className="metric-code"><code>{scriptTexts[selectedGroup.table] ?? ''}</code></pre>
                      )}
                    </div>

                    <div className="metric-detail-item">
                      <button
                        type="button"
                        className="metric-detail-title metric-detail-title-button"
                        onClick={() => toggleSection(selectedGroup.table, 'query')}
                      >
                        <span>{t('metricDataQuery')}</span>
                        <span className={`metric-detail-arrow ${isSectionOpen(selectedGroup.table, 'query') ? 'open' : ''}`}>›</span>
                      </button>
                      {isSectionOpen(selectedGroup.table, 'query') && (
                        <pre className="metric-code"><code>{querySQL || t('metricNoQueryScript')}</code></pre>
                      )}
                    </div>

                    <div className="metric-detail-item">
                      <button
                        type="button"
                        className="metric-detail-title metric-detail-title-button"
                        onClick={() => toggleSection(selectedGroup.table, 'calculation')}
                      >
                        <span>{t('metricFieldCalculation')}</span>
                        <span className={`metric-detail-arrow ${isSectionOpen(selectedGroup.table, 'calculation') ? 'open' : ''}`}>›</span>
                      </button>
                      {isSectionOpen(selectedGroup.table, 'calculation') && (
                        <>
                          {selectedGroup.items.map((item) => (
                            <div key={item.column} className="metric-detail-block">
                              <div className="metric-detail-subtitle">
                                <span>{item.name}</span>
                                <code>{item.column}</code>
                              </div>
                              <div className="metric-detail-explain">{item.explain}</div>
                              <pre className="metric-code"><code>{item.code}</code></pre>
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

          </div>
        </div>
      )}
    </div>
  )
}
