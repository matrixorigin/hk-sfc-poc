import { useState } from 'react'
import { tpl, useT } from '../i18n'
import type { Language, MetricExplainItem } from '../types'
import { localizeMetric } from '../utils/metricLocalization'
import { apiFetch } from '../api/client'

interface Props {
  items: MetricExplainItem[]
  sqlStatements?: string[]
}

interface MetricTableGroup {
  table: string
  label: string
  items: MetricExplainItem[]
}

interface MetricScriptSection {
  id: string
  title: string
  language: 'sql' | 'python' | 'text'
  body: string
}

interface MetricScriptResponse {
  table?: string
  column?: string
  filename: string
  sections: MetricScriptSection[]
}

type ChainSection = 'preparation' | 'query' | 'calculation'
type ActiveTab = { kind: 'table'; table: string } | { kind: 'query' }

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

function scriptResponseToText(script?: MetricScriptResponse) {
  if (!script) return ''
  return script.sections
    .map((section) => stringsWithTitle(section.title, section.body))
    .filter(Boolean)
    .join('\n\n')
}

function stringsWithTitle(title: string, body: string) {
  const trimmed = body.trim()
  if (!trimmed) return ''
  return title ? `${title}\n${trimmed}` : trimmed
}

function languageLabel(language: MetricScriptSection['language']) {
  switch (language) {
    case 'sql':
      return 'SQL'
    case 'python':
      return 'Python'
    default:
      return 'Text'
  }
}

function languageForCode(code: string): MetricScriptSection['language'] {
  const normalized = code.trim().toLowerCase()
  if (!normalized) return 'text'
  if (/^(--|select|with|update|insert|delete|create|alter|drop)\b/.test(normalized)) return 'sql'
  if (/\b(select|from|where|join|update|set|create\s+table)\b/.test(normalized) && !/\b(def|import|class|lambda)\b/.test(normalized)) {
    return 'sql'
  }
  if (/^(#|def|import|from\s+\w+\s+import|class)\b/.test(normalized) || /\b(if|else|for|while)\b[\s\S]*:/.test(normalized)) {
    return 'python'
  }
  return 'text'
}

function buildChainText(group: MetricTableGroup, preparationScript: string, querySQL: string, includeQuery: boolean, t: ReturnType<typeof useT>['t']) {
  const lines: string[] = []
  lines.push(`${group.label} (${group.table})`)
  lines.push('')
  lines.push(t('metricDataPreparation'))
  lines.push(preparationScript.trim() || t('metricNoPreparationScript'))
  if (includeQuery) {
    lines.push('')
    lines.push(t('metricDataQueryStep'))
    lines.push(querySQL.trim() || t('metricNoQueryScript'))
  }
  lines.push('')
  lines.push(includeQuery ? t('metricFieldCalculation') : t('metricFieldCalculationNoQuery'))
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
  const [activeTab, setActiveTab] = useState<ActiveTab>({ kind: 'table', table: groups[0]?.table ?? '' })
  const [scriptOpenTable, setScriptOpenTable] = useState<string | null>(null)
  const [scriptTexts, setScriptTexts] = useState<Record<string, MetricScriptResponse>>({})
  const [scriptLoadingTable, setScriptLoadingTable] = useState<string | null>(null)
  const [openSections, setOpenSections] = useState<Record<string, ChainSection[]>>({})
  const [copiedTarget, setCopiedTarget] = useState<string | null>(null)

  if (groups.length === 0) return null

  const querySQL = sqlStatements.join('\n\n')
  const hasResultQueryTab = groups.length > 1 && querySQL.trim().length > 0
  const activeTableName = activeTab.kind === 'table' ? activeTab.table : null
  const safeActiveTab: ActiveTab = activeTab.kind === 'query' && hasResultQueryTab
    ? activeTab
    : {
        kind: 'table',
        table: groups.some((group) => group.table === activeTableName)
          ? activeTableName ?? groups[0].table
          : groups[0].table,
      }
  const selectedTable = safeActiveTab.kind === 'table' ? safeActiveTab.table : groups[0].table
  const selectedGroup = groups.find((group) => group.table === selectedTable) ?? groups[0]
  const includeQueryInTable = !hasResultQueryTab

  async function fetchTableScript(group: MetricTableGroup) {
    const cached = scriptTexts[group.table]
    if (cached) return cached
    setScriptLoadingTable(group.table)
    try {
      const columns = group.items.map((item) => item.column).join(',')
      const response = await apiFetch(
        `/api/feature-reproduction/script?table=${encodeURIComponent(group.table)}&columns=${encodeURIComponent(columns)}&format=json`,
      )
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const script = await response.json() as MetricScriptResponse
      setScriptTexts((prev) => ({ ...prev, [group.table]: script }))
      return script
    } finally {
      setScriptLoadingTable(null)
    }
  }

  async function buildTableChain(group: MetricTableGroup) {
    const script = await fetchTableScript(group)
    return buildChainText(group, scriptResponseToText(script), querySQL, includeQueryInTable, t)
  }

  function buildQueryText() {
    return querySQL.trim() || t('metricNoQueryScript')
  }

  function fieldCalculationLabel() {
    return includeQueryInTable ? t('metricFieldCalculation') : t('metricFieldCalculationNoQuery')
  }

  async function copyText(target: string, text: string) {
    await navigator.clipboard.writeText(text)
    setCopiedTarget(target)
    window.setTimeout(() => {
      setCopiedTarget((current) => current === target ? null : current)
    }, 1200)
  }

  function copiedLabel(target: string) {
    return copiedTarget === target ? t('metricCopiedScript') : t('metricCopyItemScript')
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
    await copyText(`table:${group.table}`, text)
  }

  async function copyQueryScript() {
    await copyText('query:all', buildQueryText())
  }

  async function copyCodeSection(target: string, body: string) {
    await copyText(target, body.trim())
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

  function downloadQueryScript() {
    const text = buildQueryText()
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'result_query.sql'
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
                aria-selected={safeActiveTab.kind === 'table' && selectedGroup.table === group.table}
                className={`metric-tab ${safeActiveTab.kind === 'table' && selectedGroup.table === group.table ? 'active' : ''}`}
                onClick={() => setActiveTab({ kind: 'table', table: group.table })}
                title={group.table}
              >
                {group.label}
              </button>
            ))}
            {hasResultQueryTab && (
              <button
                type="button"
                role="tab"
                aria-selected={safeActiveTab.kind === 'query'}
                className={`metric-tab ${safeActiveTab.kind === 'query' ? 'active' : ''}`}
                onClick={() => setActiveTab({ kind: 'query' })}
              >
                {t('metricDataQuery')}
              </button>
            )}
          </div>

          <div className="metric-card">
            {safeActiveTab.kind === 'query' ? (
              <>
                <div className="metric-card-title">
                  <span className="metric-name">{t('metricDataQuery')}</span>
                </div>

                <div className="metric-section">
                  <div className="metric-section-label">{t('metricItemScript')}</div>
                  <div className="metric-item-script-actions">
                    <button type="button" className="metric-script-btn" onClick={copyQueryScript}>
                      {copiedTarget === 'query:all' ? t('metricCopiedScript') : t('metricCopyAllScript')}
                    </button>
                    <button type="button" className="metric-script-btn download" onClick={downloadQueryScript}>
                      {t('metricDownloadItemScript')}
                    </button>
                  </div>
                  <div className="metric-script-panel metric-item-script-panel">
                    <div className="metric-code-section">
                      <div className="metric-code-section-header">
                        <span>{t('metricDataQuery')}</span>
                        <span className="metric-code-section-actions">
                          <span className="metric-code-language">SQL</span>
                          <button
                            type="button"
                            className="metric-code-copy-btn"
                            onClick={() => copyCodeSection('query:code', buildQueryText())}
                          >
                            {copiedLabel('query:code')}
                          </button>
                        </span>
                      </div>
                      <pre className="metric-code"><code>{buildQueryText()}</code></pre>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <>
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
                      {copiedTarget === `table:${selectedGroup.table}` ? t('metricCopiedScript') : t('metricCopyAllScript')}
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
                            <div className="metric-code-sections">
                              {(scriptTexts[selectedGroup.table]?.sections ?? []).length > 0 ? (
                                (scriptTexts[selectedGroup.table]?.sections ?? []).map((section) => (
                                  <div key={section.id} className="metric-code-section">
                                    <div className="metric-code-section-header">
                                      <span>{section.title}</span>
                                      <span className="metric-code-section-actions">
                                        <span className="metric-code-language">{languageLabel(section.language)}</span>
                                        <button
                                          type="button"
                                          className="metric-code-copy-btn"
                                          onClick={() => copyCodeSection(`section:${selectedGroup.table}:${section.id}`, section.body)}
                                        >
                                          {copiedLabel(`section:${selectedGroup.table}:${section.id}`)}
                                        </button>
                                      </span>
                                    </div>
                                    <pre className="metric-code"><code>{section.body}</code></pre>
                                  </div>
                                ))
                              ) : (
                                <pre className="metric-code"><code>{t('metricNoPreparationScript')}</code></pre>
                              )}
                            </div>
                          )}
                        </div>

                        {includeQueryInTable && (
                          <div className="metric-detail-item">
                            <button
                              type="button"
                              className="metric-detail-title metric-detail-title-button"
                              onClick={() => toggleSection(selectedGroup.table, 'query')}
                            >
                              <span>{t('metricDataQueryStep')}</span>
                              <span className={`metric-detail-arrow ${isSectionOpen(selectedGroup.table, 'query') ? 'open' : ''}`}>›</span>
                            </button>
                            {isSectionOpen(selectedGroup.table, 'query') && (
                              <div className="metric-code-section">
                                <div className="metric-code-section-header">
                                  <span>{t('metricDataQueryStep')}</span>
                                  <span className="metric-code-section-actions">
                                    <span className="metric-code-language">SQL</span>
                                    <button
                                      type="button"
                                      className="metric-code-copy-btn"
                                      onClick={() => copyCodeSection(`table-query:${selectedGroup.table}`, buildQueryText())}
                                    >
                                      {copiedLabel(`table-query:${selectedGroup.table}`)}
                                    </button>
                                  </span>
                                </div>
                                <pre className="metric-code"><code>{buildQueryText()}</code></pre>
                              </div>
                            )}
                          </div>
                        )}

                        <div className="metric-detail-item">
                          <button
                            type="button"
                            className="metric-detail-title metric-detail-title-button"
                            onClick={() => toggleSection(selectedGroup.table, 'calculation')}
                          >
                            <span>{fieldCalculationLabel()}</span>
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
                                  <div className="metric-code-section">
                                    <div className="metric-code-section-header">
                                      <span>{item.name}</span>
                                      <span className="metric-code-section-actions">
                                        <span className="metric-code-language">{languageLabel(languageForCode(item.code))}</span>
                                        <button
                                          type="button"
                                          className="metric-code-copy-btn"
                                          onClick={() => copyCodeSection(`calculation:${selectedGroup.table}:${item.column}`, item.code)}
                                        >
                                          {copiedLabel(`calculation:${selectedGroup.table}:${item.column}`)}
                                        </button>
                                      </span>
                                    </div>
                                    <pre className="metric-code"><code>{item.code}</code></pre>
                                  </div>
                                </div>
                              ))}
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}

          </div>
        </div>
      )}
    </div>
  )
}
