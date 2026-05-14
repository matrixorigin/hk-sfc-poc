import { useState, useRef, useCallback } from 'react'
import { useT } from '../i18n'
import {
  uploadPreview,
  createTable,
  type PreviewResult,
  type ColumnInfo,
} from '../api/userTables'

interface Props {
  open: boolean
  onClose: () => void
  onCreated: () => void
}

const TYPE_OPTIONS = ['VARCHAR', 'BIGINT', 'DECIMAL(18,6)', 'DATE', 'DATETIME', 'TEXT']

function sanitizeTableName(filename: string): string {
  return filename
    .replace(/\.xlsx?$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
}

export function ExcelUploadDialog({ open, onClose, onCreated }: Props) {
  const { t } = useT()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [tableName, setTableName] = useState('')
  const [tableComment, setTableComment] = useState('')
  const [columns, setColumns] = useState<ColumnInfo[]>([])

  const reset = useCallback(() => {
    setUploading(false)
    setCreating(false)
    setError('')
    setPreview(null)
    setTableName('')
    setTableComment('')
    setColumns([])
  }, [])

  const handleClose = useCallback(() => {
    reset()
    onClose()
  }, [reset, onClose])

  const handleFile = useCallback(async (file: File) => {
    setError('')
    setUploading(true)
    try {
      const result = await uploadPreview(file)
      setPreview(result)
      setTableName(sanitizeTableName(file.name))
      setColumns(
        result.columns.map((c) => ({
          ...c,
          type: c.inferred_type || 'VARCHAR',
        }))
      )
    } catch (err: any) {
      setError(err.message || t('uploadError'))
    } finally {
      setUploading(false)
    }
  }, [t])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const file = e.dataTransfer.files[0]
      if (file && /\.xlsx?$/i.test(file.name)) handleFile(file)
    },
    [handleFile]
  )

  const handleColumnType = (idx: number, type: string) => {
    setColumns((prev) => prev.map((c, i) => (i === idx ? { ...c, type } : c)))
  }

  const handleColumnComment = (idx: number, comment: string) => {
    setColumns((prev) => prev.map((c, i) => (i === idx ? { ...c, comment } : c)))
  }

  const handleCreate = async () => {
    if (!preview || !tableName.trim()) return
    setCreating(true)
    setError('')
    try {
      await createTable({
        file_key: preview.file_key,
        table_name: tableName.trim(),
        table_comment: tableComment.trim(),
        columns,
      })
      onCreated()
      handleClose()
    } catch (err: any) {
      setError(err.message || t('createError'))
    } finally {
      setCreating(false)
    }
  }

  const typeOptions = (col: ColumnInfo) => {
    const opts = [...TYPE_OPTIONS]
    const inferred = col.inferred_type || ''
    if (inferred && !opts.includes(inferred)) opts.push(inferred)
    return opts
  }

  if (!open) return null

  return (
    <div className="knowledge-modal-overlay" onClick={handleClose}>
      <div
        className="knowledge-modal"
        style={{ width: preview ? 860 : 520 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{t('uploadExcel')}</h3>

        {!preview && !uploading && (
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            onClick={() => fileRef.current?.click()}
            style={{
              border: '2px dashed #cbd5e1',
              borderRadius: 10,
              padding: '40px 20px',
              textAlign: 'center',
              cursor: 'pointer',
              color: '#64748b',
              fontSize: 13,
              transition: 'border-color 0.2s',
            }}
          >
            {t('uploadDragHint')}
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) handleFile(file)
              }}
            />
          </div>
        )}

        {uploading && (
          <div style={{ textAlign: 'center', padding: '40px 0', color: '#64748b', fontSize: 13 }}>
            <div className="phase-spinner" style={{ marginBottom: 12 }} />
            {t('uploading')}
          </div>
        )}

        {error && (
          <div style={{ color: '#ef4444', fontSize: 13, marginBottom: 12 }}>{error}</div>
        )}

        {preview && !uploading && (
          <>
            <div className="knowledge-form-group">
              <label>{t('tableName')}</label>
              <input
                type="text"
                value={tableName}
                onChange={(e) => setTableName(e.target.value.replace(/[^a-z0-9_]/g, ''))}
              />
              <div className="form-hint">{t('tableNameHint')}</div>
            </div>

            <div className="knowledge-form-group">
              <label>{t('tableComment')}</label>
              <input
                type="text"
                value={tableComment}
                onChange={(e) => setTableComment(e.target.value)}
              />
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: '#475569', marginBottom: 6 }}>
                {t('columnName')}
              </label>
              <div style={{ overflowX: 'auto', maxHeight: 260 }}>
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
                        <td style={{ padding: '4px 8px' }}>
                          <select
                            value={col.type || col.inferred_type || 'VARCHAR'}
                            onChange={(e) => handleColumnType(i, e.target.value)}
                            style={{ padding: '4px 6px', border: '1px solid #e4e7ec', borderRadius: 6, fontSize: 12, background: '#f8fafc' }}
                          >
                            {typeOptions(col).map((opt) => (
                              <option key={opt} value={opt}>{opt}</option>
                            ))}
                          </select>
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
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: '#475569', marginBottom: 6 }}>
                {t('previewData')} ({preview.total_rows} {t('rowCount')})
              </label>
              <div style={{ overflowX: 'auto', maxHeight: 220, border: '1px solid #e4e7ec', borderRadius: 8 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: '#f8fafc' }}>
                      {preview.columns.map((c) => (
                        <th key={c.name} style={{ padding: '6px 8px', textAlign: 'left', borderBottom: '1px solid #e4e7ec', color: '#64748b', fontWeight: 500, whiteSpace: 'nowrap' }}>
                          {c.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.preview_rows.map((row, ri) => (
                      <tr key={ri} style={{ borderBottom: '1px solid #f1f5f9' }}>
                        {row.map((cell, ci) => (
                          <td key={ci} style={{ padding: '4px 8px', whiteSpace: 'nowrap', color: '#475569' }}>
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="knowledge-form-actions">
              <button className="knowledge-btn-cancel" onClick={handleClose}>
                {t('cancel')}
              </button>
              <button
                className="knowledge-btn-save"
                onClick={handleCreate}
                disabled={creating || !tableName.trim()}
              >
                {creating ? t('creating') : t('confirmCreate')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
