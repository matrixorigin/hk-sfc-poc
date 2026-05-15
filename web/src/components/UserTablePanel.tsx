import { useState, useEffect, useCallback } from 'react'
import { useT } from '../i18n'
import {
  listUserTables,
  deleteUserTable,
  previewTableData,
  type UserTableMeta,
  type DataPreviewResult,
} from '../api/userTables'
import { ExcelUploadDialog } from './ExcelUploadDialog'
import { ColumnMetaEditor } from './ColumnMetaEditor'
import './UserTablePanel.css'

interface Props {
  open: boolean
  onClose: () => void
  onTablesChanged?: () => void
}

export function UserTablePanel({ open, onClose, onTablesChanged }: Props) {
  const { t } = useT()
  const [tables, setTables] = useState<UserTableMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [showUpload, setShowUpload] = useState(false)
  const [editingTable, setEditingTable] = useState<string | null>(null)
  const [previewTable, setPreviewTable] = useState<string | null>(null)
  const [previewData, setPreviewData] = useState<DataPreviewResult | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  const fetchTables = useCallback(async () => {
    setLoading(true)
    try {
      const list = await listUserTables()
      setTables(Array.isArray(list) ? list : [])
    } catch (err) {
      console.error('[UserTablePanel] fetch error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) fetchTables()
  }, [open, fetchTables])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showUpload) return
        if (editingTable) {
          setEditingTable(null)
        } else {
          onClose()
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, showUpload, editingTable, onClose])

  const handleDelete = async (name: string) => {
    if (!confirm(t('confirmDeleteTable'))) return
    try {
      await deleteUserTable(name)
      await fetchTables()
      onTablesChanged?.()
    } catch (err) {
      console.error('[UserTablePanel] delete error:', err)
    }
  }

  const handlePreview = async (name: string) => {
    if (previewTable === name) {
      setPreviewTable(null)
      setPreviewData(null)
      return
    }
    setPreviewTable(name)
    setPreviewData(null)
    setPreviewLoading(true)
    try {
      const data = await previewTableData(name)
      setPreviewData(data)
    } catch (err) {
      console.error('[UserTablePanel] preview error:', err)
    } finally {
      setPreviewLoading(false)
    }
  }

  const handleEditToggle = (name: string) => {
    setEditingTable(editingTable === name ? null : name)
  }

  if (!open) return null

  return (
    <>
      <div className="usertable-overlay" onClick={onClose} />

      <div className="usertable-panel">
        <div className="usertable-panel-header">
          <div>
            <h2>{t('tableManagement')}</h2>
            <p>{t('tableManagementDesc')}</p>
          </div>
          <button className="usertable-panel-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="usertable-toolbar">
          <button className="usertable-upload-btn" onClick={() => setShowUpload(true)}>
            + {t('uploadExcel')}
          </button>
        </div>

        <div className="usertable-list">
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '40px 0', color: '#64748b', fontSize: 13 }}>
              <div className="phase-spinner" />
              Loading...
            </div>
          ) : tables.length === 0 ? (
            <div className="usertable-empty">{t('noUserTables')}</div>
          ) : (
            tables.map((tbl) => (
              <div key={tbl.table_name} className="usertable-card">
                <div className="usertable-card-header">
                  <div>
                    <div className="usertable-card-name">{tbl.table_name}</div>
                    {tbl.table_comment && (
                      <div className="usertable-card-comment">{tbl.table_comment}</div>
                    )}
                    <div className="usertable-card-meta">
                      {tbl.row_count} {t('rowCount')} · {tbl.created_at}
                    </div>
                  </div>
                  <div className="usertable-card-actions">
                    <button onClick={() => handleEditToggle(tbl.table_name)}>
                      {t('editMetadata')}
                    </button>
                    <button onClick={() => handlePreview(tbl.table_name)}>
                      {t('previewTable')}
                    </button>
                    <button className="delete" onClick={() => handleDelete(tbl.table_name)}>
                      {t('deleteTable')}
                    </button>
                  </div>
                </div>

                {editingTable === tbl.table_name && (
                  <ColumnMetaEditor
                    tableName={tbl.table_name}
                    tableComment={tbl.table_comment}
                    onSaved={() => {
                      setEditingTable(null)
                      fetchTables()
                    }}
                    onCancel={() => setEditingTable(null)}
                  />
                )}

                {previewTable === tbl.table_name && (
                  <div className="usertable-preview-section">
                    {previewLoading ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 20, color: '#64748b', fontSize: 13 }}>
                        <div className="phase-spinner" />
                        Loading...
                      </div>
                    ) : previewData ? (
                      <table>
                        <thead>
                          <tr>
                            {previewData.columns.map((col) => (
                              <th key={col}>{col}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {previewData.rows.map((row, ri) => (
                            <tr key={ri}>
                              {row.map((cell, ci) => (
                                <td key={ci}>{cell}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : null}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      <ExcelUploadDialog
        open={showUpload}
        onClose={() => setShowUpload(false)}
        onCreated={() => {
          setShowUpload(false)
          fetchTables()
          onTablesChanged?.()
        }}
      />
    </>
  )
}
