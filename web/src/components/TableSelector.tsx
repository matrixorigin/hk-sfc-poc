import { useState, useEffect } from 'react'
import { useT } from '../i18n'

interface TableInfo {
  name: string
  label: string
}

interface TableSelectorProps {
  selected: string[]
  onChange: (tables: string[]) => void
}

export function TableSelector({ selected, onChange }: TableSelectorProps) {
  const { lang } = useT()
  const [tables, setTables] = useState<TableInfo[]>([])
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    fetch('/api/tables')
      .then((r) => r.json())
      .then(setTables)
      .catch(() => {})
  }, [])

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
    <div style={{ padding: '6px 16px 0', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
      <span
        style={{ fontSize: '12px', color: '#6b7280', cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
        onClick={() => setExpanded(!expanded)}
      >
        {lang === 'zh' ? '📋 选择表' : '📋 Tables'} {expanded ? '▾' : '▸'}
      </span>
      {expanded && (
        <>
          <button
            onClick={() => onChange([])}
            style={{
              fontSize: '11px',
              padding: '2px 8px',
              borderRadius: '12px',
              border: '1px solid #d1d5db',
              background: allSelected ? '#1a2332' : '#fff',
              color: allSelected ? '#fff' : '#374151',
              cursor: 'pointer',
            }}
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
                style={{
                  fontSize: '11px',
                  padding: '2px 8px',
                  borderRadius: '12px',
                  border: `1px solid ${isOn ? '#3b82f6' : '#d1d5db'}`,
                  background: isOn ? '#eff6ff' : '#fff',
                  color: isOn ? '#1d4ed8' : '#6b7280',
                  cursor: 'pointer',
                }}
              >
                {t.label.split(' / ')[lang === 'zh' ? 0 : 1] || t.label}
              </button>
            )
          })}
        </>
      )}
    </div>
  )
}
