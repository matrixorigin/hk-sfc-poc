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
  const selectedCount = selected.length

  return (
    <div style={{ padding: '8px 16px 4px' }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          padding: '4px 12px',
          borderRadius: '16px',
          border: '1px solid #d1d5db',
          background: selectedCount > 0 ? '#eff6ff' : '#f9fafb',
          cursor: 'pointer',
          userSelect: 'none',
          fontSize: '13px',
          color: selectedCount > 0 ? '#1d4ed8' : '#374151',
        }}
      >
        <span>🗂</span>
        <span>{lang === 'zh' ? '数据表' : 'Tables'}</span>
        {selectedCount > 0 && (
          <span style={{
            background: '#3b82f6',
            color: '#fff',
            borderRadius: '10px',
            padding: '0 6px',
            fontSize: '11px',
            fontWeight: 600,
          }}>
            {selectedCount}
          </span>
        )}
        <span style={{ fontSize: '10px' }}>{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '6px',
          marginTop: '8px',
          padding: '8px 0',
        }}>
          <button
            onClick={() => onChange([])}
            style={{
              fontSize: '12px',
              padding: '4px 12px',
              borderRadius: '14px',
              border: `1.5px solid ${allSelected ? '#1a2332' : '#d1d5db'}`,
              background: allSelected ? '#1a2332' : '#fff',
              color: allSelected ? '#fff' : '#374151',
              cursor: 'pointer',
              fontWeight: allSelected ? 600 : 400,
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
                  fontSize: '12px',
                  padding: '4px 12px',
                  borderRadius: '14px',
                  border: `1.5px solid ${isOn ? '#3b82f6' : '#d1d5db'}`,
                  background: isOn ? '#eff6ff' : '#fff',
                  color: isOn ? '#1d4ed8' : '#6b7280',
                  cursor: 'pointer',
                  fontWeight: isOn ? 600 : 400,
                  transition: 'all 0.15s',
                }}
              >
                {t.label.split(' / ')[lang === 'zh' ? 0 : 1] || t.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
