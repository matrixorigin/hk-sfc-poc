import { useState } from 'react'
import type { MetricExplainItem } from '../types'

interface Props {
  items: MetricExplainItem[]
  /** repoBaseUrl, e.g. "https://github.com/.../blob/main"; if未设置则用相对路径展示。 */
  repoBaseUrl?: string
}

function parseSource(s: string): { path: string; lines?: string } {
  const hashIdx = s.indexOf('#')
  if (hashIdx < 0) return { path: s }
  return { path: s.slice(0, hashIdx), lines: s.slice(hashIdx + 1) }
}

function buildSourceHref(s: string, repoBaseUrl?: string): string {
  const { path, lines } = parseSource(s)
  if (!repoBaseUrl) {
    // 无配置时，直接返回相对路径文字（非链接），上层用 <span> 渲染
    return ''
  }
  // GitHub: blob/main/<path>#<lines>
  const ghLines = lines ? `#${lines.replace(/^L?(\d+)-L?(\d+)$/, 'L$1-L$2').replace(/^(\d+)$/, 'L$1')}` : ''
  return `${repoBaseUrl.replace(/\/$/, '')}/${path}${ghLines}`
}

export function MetricExplanations({ items, repoBaseUrl }: Props) {
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
            .map((it) => {
              const href = buildSourceHref(it.source, repoBaseUrl)
              return (
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

                  <div className="metric-section">
                    <div className="metric-section-label">📄 完整实现</div>
                    {href ? (
                      <a
                        className="metric-source"
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {it.source}
                      </a>
                    ) : (
                      <code className="metric-source">{it.source}</code>
                    )}
                  </div>
                </div>
              )
            })}
        </div>
      )}
    </div>
  )
}
