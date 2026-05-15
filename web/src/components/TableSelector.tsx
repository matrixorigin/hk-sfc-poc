import { useState, useEffect } from 'react'
import { useT } from '../i18n'

interface TableInfo {
  name: string
  label: string
  source?: string
}

interface TableSelectorProps {
  selected: string[]
  onChange: (tables: string[]) => void
  refreshKey?: number
}

export function TableSelector({ selected, onChange, refreshKey }: TableSelectorProps) {
  const { lang } = useT()
  const [tables, setTables] = useState<TableInfo[]>([])

  useEffect(() => {
    fetch('/api/tables')
      .then((r) => r.json())
      .then(setTables)
      .catch(() => {})
  }, [refreshKey])

  if (!tables.length) return null

  const toggle = (name: string) => {
    onChange(
      selected.includes(name)
        ? selected.filter((t) => t !== name)
        : [...selected, name]
    )
  }

  const allSelected = selected.length === 0

  return (
    <div className="table-selector">
      <div className="table-selector-header">
        <span className="table-selector-label">
          {lang === 'zh' ? '查询范围' : 'Query Scope'}
        </span>
        {selected.length > 0 && (
          <span className="table-selector-count">
            {selected.length} / {tables.length}
          </span>
        )}
      </div>
      <div className="table-selector-chips">
        <button
          onClick={() => onChange([])}
          className={`table-chip${allSelected ? ' active' : ''}`}
        >
          {lang === 'zh' ? '全部' : 'All'}
        </button>
        {tables.map((t) => {
          const isOn = selected.includes(t.name)
          return (
            <button
              key={t.name}
              onClick={() => toggle(t.name)}
              title={t.name}
              className={`table-chip${isOn ? ' active' : ''}${t.source === 'user' ? ' user-table' : ''}`}
            >
              {t.source === 'user' ? t.name : (t.label.split(' / ')[lang === 'zh' ? 0 : 1] || t.label)}
            </button>
          )
        })}
      </div>
    </div>
  )
}
