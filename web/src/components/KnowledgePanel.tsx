import { useState, useEffect, useCallback } from 'react'
import { useT } from '../i18n'
import './KnowledgePanel.css'

interface KnowledgeEntry {
  id: number
  knowledge_base_id: number
  knowledge_type: string
  knowledge_key: string
  name: string
  knowledge_value: string[]
  associate_tables: string[]
  created_at: number
  updated_at: number
}

interface KnowledgePanelProps {
  open: boolean
  onClose: () => void
}

type FilterType = 'all' | 'logic' | 'glossary' | 'case_library'

const TYPE_LABELS: Record<string, string> = {
  logic: 'knowledgeTypeLogic',
  glossary: 'knowledgeTypeGlossary',
  case_library: 'knowledgeTypeCaseLibrary',
}

const FILTER_TABS: FilterType[] = ['all', 'logic', 'glossary', 'case_library']

interface FormState {
  knowledge_type: string
  knowledge_key: string
  name: string
  knowledge_value: string
  associate_tables: string
}

const emptyForm: FormState = {
  knowledge_type: 'logic',
  knowledge_key: '',
  name: '',
  knowledge_value: '',
  associate_tables: '',
}

export function KnowledgePanel({ open, onClose }: KnowledgePanelProps) {
  const { t } = useT()
  const [entries, setEntries] = useState<KnowledgeEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState<FilterType>('all')
  const [showForm, setShowForm] = useState(false)
  const [editingEntry, setEditingEntry] = useState<KnowledgeEntry | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [saving, setSaving] = useState(false)

  const fetchEntries = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await fetch('/api/knowledge')
      const data = await resp.json()
      setEntries(data.data?.items || [])
    } catch (err) {
      console.error('[KnowledgePanel] fetch error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      fetchEntries()
    }
  }, [open, fetchEntries])

  // Close on Escape key
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showForm) {
          setShowForm(false)
          setEditingEntry(null)
        } else {
          onClose()
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, showForm, onClose])

  const filtered = filter === 'all'
    ? entries
    : entries.filter((e) => e.knowledge_type === filter)

  const handleAdd = () => {
    setEditingEntry(null)
    setForm(emptyForm)
    setShowForm(true)
  }

  const handleEdit = (entry: KnowledgeEntry) => {
    setEditingEntry(entry)
    setForm({
      knowledge_type: entry.knowledge_type,
      knowledge_key: entry.knowledge_key,
      name: entry.name,
      knowledge_value: (entry.knowledge_value || []).join('\n'),
      associate_tables: (entry.associate_tables || []).join(', '),
    })
    setShowForm(true)
  }

  const handleDelete = async (entry: KnowledgeEntry) => {
    if (!confirm(t('knowledgeConfirmDelete'))) return
    try {
      await fetch(`/api/knowledge/${entry.id}`, { method: 'DELETE' })
      await fetchEntries()
    } catch (err) {
      console.error('[KnowledgePanel] delete error:', err)
    }
  }

  const handleSave = async () => {
    if (!form.knowledge_key.trim() || !form.name.trim()) return
    setSaving(true)
    try {
      // If editing, delete old entry first (no PUT/PATCH API)
      if (editingEntry) {
        await fetch(`/api/knowledge/${editingEntry.id}`, { method: 'DELETE' })
      }
      // Create new entry
      const body = {
        knowledge_type: form.knowledge_type,
        knowledge_key: form.knowledge_key.trim(),
        name: form.name.trim(),
        knowledge_value: form.knowledge_value
          .split('\n')
          .map((v) => v.trim())
          .filter(Boolean),
        associate_tables: form.associate_tables
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean),
      }
      await fetch('/api/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      setShowForm(false)
      setEditingEntry(null)
      await fetchEntries()
    } catch (err) {
      console.error('[KnowledgePanel] save error:', err)
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = () => {
    setShowForm(false)
    setEditingEntry(null)
  }

  const getFilterLabel = (type: FilterType): string => {
    if (type === 'all') return 'All'
    return t(TYPE_LABELS[type] as any)
  }

  const getTypeBadge = (type: string) => {
    const label = TYPE_LABELS[type]
      ? t(TYPE_LABELS[type] as any)
      : type
    return (
      <span className={`knowledge-type-badge ${type}`}>{label}</span>
    )
  }

  if (!open) return null

  return (
    <>
      {/* Overlay */}
      <div className="knowledge-overlay" onClick={onClose} />

      {/* Panel */}
      <div className="knowledge-panel">
        {/* Header */}
        <div className="knowledge-panel-header">
          <div className="knowledge-panel-header-left">
            <h2>{t('knowledge')}</h2>
            <p>{t('knowledgeDesc')}</p>
          </div>
          <button className="knowledge-panel-close" onClick={onClose}>
            ×
          </button>
        </div>

        {/* Toolbar */}
        <div className="knowledge-toolbar">
          <div className="knowledge-filter-tabs">
            {FILTER_TABS.map((tab) => (
              <button
                key={tab}
                className={`knowledge-filter-tab ${filter === tab ? 'active' : ''}`}
                onClick={() => setFilter(tab)}
              >
                {getFilterLabel(tab)}
              </button>
            ))}
          </div>
          <button className="knowledge-add-btn" onClick={handleAdd}>
            + {t('knowledgeAdd')}
          </button>
        </div>

        {/* List */}
        <div className="knowledge-list">
          {loading ? (
            <div className="knowledge-loading">
              <div className="phase-spinner" />
              Loading...
            </div>
          ) : filtered.length === 0 ? (
            <div className="knowledge-empty">{t('knowledgeEmpty')}</div>
          ) : (
            filtered.map((entry) => (
              <div key={entry.id} className="knowledge-card">
                <div className="knowledge-card-header">
                  <div className="knowledge-card-title-row">
                    {getTypeBadge(entry.knowledge_type)}
                    <span className="knowledge-card-name">{entry.name}</span>
                    <span className="knowledge-card-key">{entry.knowledge_key}</span>
                  </div>
                  <div className="knowledge-card-actions">
                    <button onClick={() => handleEdit(entry)}>
                      {t('knowledgeEdit')}
                    </button>
                    <button className="delete" onClick={() => handleDelete(entry)}>
                      {t('knowledgeDelete')}
                    </button>
                  </div>
                </div>

                {entry.knowledge_value && entry.knowledge_value.length > 0 && (
                  <div className="knowledge-card-values">
                    <ul>
                      {entry.knowledge_value.map((val, i) => (
                        <li key={i}>{val}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {entry.associate_tables && entry.associate_tables.length > 0 && (
                  <div className="knowledge-card-tables">
                    {entry.associate_tables.map((tbl, i) => (
                      <span key={i} className="knowledge-table-tag">{tbl}</span>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Form Modal */}
      {showForm && (
        <div className="knowledge-modal-overlay" onClick={handleCancel}>
          <div className="knowledge-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{editingEntry ? t('knowledgeEdit') : t('knowledgeAdd')}</h3>

            <div className="knowledge-form-group">
              <label>{t('knowledgeType')}</label>
              <select
                value={form.knowledge_type}
                onChange={(e) => setForm({ ...form, knowledge_type: e.target.value })}
              >
                <option value="logic">{t('knowledgeTypeLogic' as any)}</option>
                <option value="glossary">{t('knowledgeTypeGlossary' as any)}</option>
                <option value="case_library">{t('knowledgeTypeCaseLibrary' as any)}</option>
              </select>
            </div>

            <div className="knowledge-form-group">
              <label>{t('knowledgeKey')}</label>
              <input
                type="text"
                value={form.knowledge_key}
                onChange={(e) => setForm({ ...form, knowledge_key: e.target.value })}
              />
            </div>

            <div className="knowledge-form-group">
              <label>{t('knowledgeName')}</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>

            <div className="knowledge-form-group">
              <label>{t('knowledgeValue')}</label>
              <textarea
                value={form.knowledge_value}
                onChange={(e) => setForm({ ...form, knowledge_value: e.target.value })}
              />
              <div className="form-hint">One item per line</div>
            </div>

            <div className="knowledge-form-group">
              <label>{t('knowledgeTables')}</label>
              <input
                type="text"
                value={form.associate_tables}
                onChange={(e) => setForm({ ...form, associate_tables: e.target.value })}
              />
              <div className="form-hint">Comma-separated table names</div>
            </div>

            <div className="knowledge-form-actions">
              <button className="knowledge-btn-cancel" onClick={handleCancel}>
                {t('knowledgeCancel')}
              </button>
              <button
                className="knowledge-btn-save"
                onClick={handleSave}
                disabled={saving || !form.knowledge_key.trim() || !form.name.trim()}
              >
                {saving ? '...' : t('knowledgeSave')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
