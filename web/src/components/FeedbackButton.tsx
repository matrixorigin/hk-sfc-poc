import { useState } from 'react'
import { useT } from '../i18n'
import { apiFetch } from '../api/client'

interface FeedbackButtonProps {
  question: string
  sql: string
  sqlResult: any
  sessionId: string
}

export function FeedbackButton({ question, sql, sqlResult, sessionId }: FeedbackButtonProps) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  const handleSubmit = async () => {
    if (submitting) return
    setSubmitting(true)
    try {
      await apiFetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          sql,
          sql_result: sqlResult,
          session_id: sessionId,
          user_note: note.trim(),
        }),
      })
      setSubmitted(true)
      setOpen(false)
    } catch (err) {
      console.error('[FeedbackButton] submit error:', err)
    } finally {
      setSubmitting(false)
    }
  }

  if (submitted) {
    return (
      <div className="feedback-submitted">
        {t('feedbackSubmitted' as any)}
      </div>
    )
  }

  return (
    <div className="feedback-btn-container">
      {!open ? (
        <button className="feedback-btn" onClick={() => setOpen(true)}>
          {t('feedbackBtn' as any)}
        </button>
      ) : (
        <div className="feedback-form">
          <textarea
            className="feedback-textarea"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('feedbackPlaceholder' as any)}
            rows={3}
          />
          <div className="feedback-actions">
            <button
              className="feedback-cancel"
              onClick={() => { setOpen(false); setNote('') }}
            >
              {t('knowledgeCancel' as any)}
            </button>
            <button
              className="feedback-submit"
              onClick={handleSubmit}
              disabled={submitting}
            >
              {submitting ? '...' : t('feedbackSubmitBtn' as any)}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
