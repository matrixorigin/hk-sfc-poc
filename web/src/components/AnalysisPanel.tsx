import { useState, useEffect, useCallback, useRef } from 'react'
import { useT } from '../i18n'
import { apiFetch } from '../api/client'
import './AnalysisPanel.css'

interface FeedbackTask {
  id: string
  question: string
  sql: string
  sql_result: any
  session_id: string
  user_note?: string
  status: 'pending' | 'analyzing' | 'done' | 'error'
  analysis?: {
    problems?: Array<{
      description: string
      severity?: 'error' | 'warning' | 'info'
    }>
    corrected_sql?: string
    system_actions?: Array<{
      category: string
      title: string
      detail: string
      priority?: 'high' | 'medium' | 'low'
      reason?: string
    }>
  }
  error_msg?: string
  created_at: string
  finished_at?: string
}

interface AnalysisPanelProps {
  open: boolean
  onClose: () => void
}

const categoryLabels: Record<string, string> = {
  knowledge_rule: 'Knowledge Rule',
  case_library: 'Fewshot Example',
  glossary: 'Glossary',
  schema_comment: 'Schema Comment',
  data_preprocessing: 'Data Preprocessing',
  param_validation: 'Param Validation',
  other: 'Other',
}

function formatTime(ts: string): string {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

export function AnalysisPanel({ open, onClose }: AnalysisPanelProps) {
  const { t } = useT()
  const [tasks, setTasks] = useState<FeedbackTask[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchTasks = useCallback(async () => {
    try {
      const resp = await apiFetch('/api/feedback')
      const data = await resp.json()
      const items: FeedbackTask[] = data.tasks || []
      setTasks(items)
      return items
    } catch (err) {
      console.error('[AnalysisPanel] fetch error:', err)
      return []
    }
  }, [])

  const startPolling = useCallback((items: FeedbackTask[]) => {
    if (pollTimerRef.current) return
    const hasPending = items.some(
      (t) => t.status === 'pending' || t.status === 'analyzing'
    )
    if (!hasPending) return

    pollTimerRef.current = setTimeout(async () => {
      pollTimerRef.current = null
      const updated = await fetchTasks()
      startPolling(updated)
    }, 5000)
  }, [fetchTasks])

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (open) {
      setLoading(true)
      fetchTasks().then((items) => {
        setLoading(false)
        startPolling(items)
      })
    } else {
      stopPolling()
    }
    return () => stopPolling()
  }, [open])

  // Restart polling when tasks update (to catch newly done tasks)
  useEffect(() => {
    if (!open) return
    startPolling(tasks)
  }, [tasks])

  // Close on Escape key
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  const selectedTask = tasks.find((t) => t.id === selectedId) || null

  const getStatusLabel = (status: string) => {
    const key = `analysisStatus_${status}` as any
    return t(key)
  }

  if (!open) return null

  return (
    <div className="analysis-overlay" onClick={onClose}>
      <div className="analysis-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="analysis-modal-header">
          <h2>{t('analysisCenter' as any)}</h2>
          <button className="analysis-modal-close" onClick={onClose}>×</button>
        </div>

        {/* Body */}
        <div className="analysis-modal-body">
          {/* Left: task list */}
          <div className="analysis-list">
            {loading ? (
              <div className="analysis-loading">
                <div className="phase-spinner" />
                Loading...
              </div>
            ) : tasks.length === 0 ? (
              <div className="analysis-empty">{t('analysisEmpty' as any)}</div>
            ) : (
              tasks.map((task) => (
                <div
                  key={task.id}
                  className={`analysis-task-item ${selectedId === task.id ? 'active' : ''}`}
                  onClick={() => setSelectedId(task.id)}
                >
                  <div className="analysis-task-item-header">
                    <span className={`analysis-status-badge ${task.status}`}>
                      {getStatusLabel(task.status)}
                    </span>
                    <span className="analysis-task-time">{formatTime(task.created_at)}</span>
                  </div>
                  <div className="analysis-task-question">
                    {task.question?.slice(0, 60)}{(task.question?.length || 0) > 60 ? '…' : ''}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Right: detail */}
          <div className="analysis-detail">
            {!selectedTask ? (
              <div className="analysis-detail-placeholder">
                选择左侧任务查看分析详情
              </div>
            ) : (
              <>
                {/* Question */}
                <div className="analysis-detail-section">
                  <h3>{t('analysisCenter' as any)}</h3>
                  <div className="analysis-detail-text">{selectedTask.question}</div>
                </div>

                {/* User note */}
                {selectedTask.user_note && (
                  <div className="analysis-detail-section">
                    <h3>{t('analysisUserNote' as any)}</h3>
                    <div className="analysis-detail-note">{selectedTask.user_note}</div>
                  </div>
                )}

                {/* Original SQL */}
                {selectedTask.sql && (
                  <div className="analysis-detail-section">
                    <h3>{t('analysisOriginalSQL' as any)}</h3>
                    <div className="analysis-sql-block">
                      <button
                        className="analysis-sql-copy"
                        onClick={() => navigator.clipboard.writeText(selectedTask.sql)}
                      >
                        Copy
                      </button>
                      <pre>{selectedTask.sql}</pre>
                    </div>
                  </div>
                )}

                {/* Status indicator when not done */}
                {(selectedTask.status === 'pending' || selectedTask.status === 'analyzing') && (
                  <div className="analysis-loading" style={{ justifyContent: 'flex-start', padding: '12px 0' }}>
                    <div className="phase-spinner" />
                    <span>{getStatusLabel(selectedTask.status)}</span>
                  </div>
                )}

                {/* Problems */}
                {selectedTask.analysis?.problems && selectedTask.analysis.problems.length > 0 && (
                  <div className="analysis-detail-section">
                    <h3>{t('analysisProblem' as any)}</h3>
                    <div className="analysis-problems-list">
                      {selectedTask.analysis.problems.map((p, i) => (
                        <div
                          key={i}
                          className={`analysis-problem-item ${p.severity || ''}`}
                        >
                          {p.severity && (
                            <span className={`analysis-problem-severity ${p.severity}`}>
                              {p.severity}
                            </span>
                          )}
                          {p.description}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Corrected SQL */}
                {selectedTask.analysis?.corrected_sql && (
                  <div className="analysis-detail-section">
                    <h3>{t('analysisCorrectedSQL' as any)}</h3>
                    <div className="analysis-sql-block">
                      <button
                        className="analysis-sql-copy"
                        onClick={() => navigator.clipboard.writeText(selectedTask.analysis!.corrected_sql!)}
                      >
                        Copy
                      </button>
                      <pre>{selectedTask.analysis.corrected_sql}</pre>
                    </div>
                  </div>
                )}

                {/* System Actions */}
                {selectedTask.analysis?.system_actions && selectedTask.analysis.system_actions.length > 0 && (
                  <div className="analysis-detail-section">
                    <h3>System Optimization Suggestions</h3>
                    <div className="analysis-actions-list">
                      {selectedTask.analysis.system_actions.map((a, i) => (
                        <div key={i} className={`analysis-action-card priority-${a.priority || 'medium'}`}>
                          <div className="analysis-action-header">
                            <span className="analysis-action-category">{categoryLabels[a.category] || a.category}</span>
                            {a.priority && (
                              <span className={`analysis-action-priority ${a.priority}`}>{a.priority}</span>
                            )}
                          </div>
                          <div className="analysis-action-title">{a.title}</div>
                          <div className="analysis-action-detail">{a.detail}</div>
                          {a.reason && (
                            <div className="analysis-action-reason">Why: {a.reason}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Error state */}
                {selectedTask.status === 'error' && (
                  <div className="analysis-detail-section">
                    <div className="analysis-problem-item high">
                      分析任务执行失败，请稍后重试。
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
