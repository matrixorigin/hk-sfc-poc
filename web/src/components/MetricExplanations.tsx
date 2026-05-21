import { useState } from 'react'
import { tpl, useT } from '../i18n'
import type { MetricExplainItem } from '../types'
import { localizeMetric } from '../utils/metricLocalization'

interface Props {
  items: MetricExplainItem[]
}

export function MetricExplanations({ items }: Props) {
  const { lang, t } = useT()
  const localizedItems = items.map((item) => localizeMetric(item, lang))
  const [open, setOpen] = useState(false)
  const [activeColumn, setActiveColumn] = useState<string | null>(
    localizedItems.length > 0 ? localizedItems[0].column : null,
  )

  if (!localizedItems || localizedItems.length === 0) return null

  return (
    <div className="metric-explanations">
      <button
        type="button"
        className={`metric-toggle ${open ? 'open' : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 18l6-6-6-6"/>
        </svg>
        {tpl(t('metricToggle'), { count: localizedItems.length })}
        <span className={`metric-toggle-arrow ${open ? 'open' : ''}`}>▾</span>
      </button>

      {open && (
        <div className="metric-panel">
          <div className="metric-tabs" role="tablist">
            {localizedItems.map((it) => (
              <button
                key={it.column}
                role="tab"
                aria-selected={activeColumn === it.column}
                className={`metric-tab ${activeColumn === it.column ? 'active' : ''}`}
                onClick={() => setActiveColumn(it.column)}
                title={it.column}
              >
                {it.name}
              </button>
            ))}
          </div>

          {localizedItems
            .filter((it) => it.column === activeColumn)
            .map((it) => (
              <div key={it.column} className="metric-card">
                <div className="metric-card-title">
                  <span className="metric-name">{it.name}</span>
                  <code className="metric-column">{it.column}</code>
                </div>

                <div className="metric-section">
                  <div className="metric-section-label">{t('metricMethodology')}</div>
                  <div className="metric-explain">{it.explain}</div>
                </div>

                <div className="metric-section">
                  <div className="metric-section-label">{t('metricCoreCode')}</div>
                  <pre className="metric-code"><code>{it.code}</code></pre>
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}
