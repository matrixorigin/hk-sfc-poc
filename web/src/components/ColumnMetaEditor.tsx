import { useState, useEffect, useCallback } from 'react'
import { useT } from '../i18n'
import { getTableColumns, updateMetadata, type ColumnInfo } from '../api/userTables'

interface Props {
  tableName: string
  tableComment: string
  onSaved: () => void
  onCancel: () => void
}

export function ColumnMetaEditor({ tableName, tableComment: initialComment, onSaved, onCancel }: Props) {
  const { t } = useT()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [columns, setColumns] = useState<ColumnInfo[]>([])
  const [comment, setComment] = useState(initialComment)

  const fetchColumns = useCallback(async () => {
    setLoading(true)
    try {
      const cols = await getTableColumns(tableName)
      setColumns(cols)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [tableName])

  useEffect(() => {
    fetchColumns()
  }, [fetchColumns])

  const handleColumnComment = (idx: number, val: string) => {
    setColumns((prev) => prev.map((c, i) => (i === idx ? { ...c, comment: val } : c)))
  }

  const handleSave = async () => {
    setSaving(true)
    setError('')
    try {
      await updateMetadata(tableName, {
        table_comment: comment.trim(),
        columns: columns.map((c) => ({ name: c.name, comment: c.comment || '' })),
      })
      onSaved()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '20px 0', color: '#64748b', fontSize: 13 }}>
        <div className="phase-spinner" />
        Loading...
      </div>
    )
  }

  return (
    <div style={{ padding: '12px 0' }}>
      {error && (
        <div style={{ color: '#ef4444', fontSize: 13, marginBottom: 12 }}>{error}</div>
      )}

      <div className="knowledge-form-group">
        <label>{t('tableComment')}</label>
        <input
          type="text"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </div>

      <div style={{ overflowX: 'auto', marginBottom: 16 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #e4e7ec' }}>
              <th style={{ textAlign: 'left', padding: '6px 8px', color: '#64748b', fontWeight: 500 }}>{t('columnName')}</th>
              <th style={{ textAlign: 'left', padding: '6px 8px', color: '#64748b', fontWeight: 500 }}>{t('columnType')}</th>
              <th style={{ textAlign: 'left', padding: '6px 8px', color: '#64748b', fontWeight: 500 }}>{t('columnComment')}</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((col, i) => (
              <tr key={col.name} style={{ borderBottom: '1px solid #f1f5f9' }}>
                <td style={{ padding: '4px 8px', fontFamily: "'SF Mono','Fira Code',monospace", color: '#1a1a2e' }}>
                  {col.name}
                </td>
                <td style={{ padding: '4px 8px', color: '#64748b', fontSize: 12 }}>
                  {col.type || col.inferred_type || ''}
                </td>
                <td style={{ padding: '4px 8px' }}>
                  <input
                    type="text"
                    value={col.comment || ''}
                    onChange={(e) => handleColumnComment(i, e.target.value)}
                    style={{ width: '100%', padding: '4px 6px', border: '1px solid #e4e7ec', borderRadius: 6, fontSize: 12, background: '#f8fafc' }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="knowledge-form-actions">
        <button className="knowledge-btn-cancel" onClick={onCancel}>
          {t('cancel')}
        </button>
        <button
          className="knowledge-btn-save"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? '...' : t('save')}
        </button>
      </div>
    </div>
  )
}
