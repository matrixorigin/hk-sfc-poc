import { useState } from 'react'
import type { MetricExplainItem } from '../types'

interface Props {
  items: MetricExplainItem[]
}

export function MetricExplanations({ items }: Props) {
  const [open, setOpen] = useState(false)
  const [activeColumn, setActiveColumn] = useState<string | null>(
    items.length > 0 ? items[0].column : null,
  )

  if (!items || items.length === 0) return null

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
        本次查询涉及 {items.length} 个预计算字段
        <span className={`metric-toggle-arrow ${open ? 'open' : ''}`}>▾</span>
      </button>

      {open && (
        <div className="metric-panel">
          <div className="metric-tabs" role="tablist">
            {items.map((it) => (
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

          {items
            .filter((it) => it.column === activeColumn)
            .map((it) => (
              <div key={it.column} className="metric-card">
                <div className="metric-card-title">
                  <span className="metric-name">{it.name}</span>
                  <code className="metric-column">{it.column}</code>
                </div>

                <div className="metric-section">
                  <div className="metric-section-label">📖 怎么算</div>
                  <div className="metric-explain">{it.explain}</div>
                </div>

                <div className="metric-section">
                  <div className="metric-section-label">🧩 核心代码</div>
                  <pre className="metric-code"><code>{it.code}</code></pre>
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}
