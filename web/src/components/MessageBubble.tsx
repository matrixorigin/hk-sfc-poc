import { useCallback, useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import type { ChartSpec, Message } from '../types'
import { useT } from '../i18n'
import { Chart, canChartResult, resolveSpec } from './Chart'
import { ChartFieldSelector } from './ChartFieldSelector'
import { DataTable } from './DataTable'
import { FeedbackButton } from './FeedbackButton'
import { PhasePipeline } from './PhasePipeline'
import { selectPrimaryResult } from '../utils/selectPrimaryResult'
import { updateMessageChartSpec } from '../api/conversations'

interface MessageBubbleProps {
  message: Message
  conversationId?: string
  onUpdateMessage?: (id: string, updater: (msg: Message) => Message) => void
}

const PATCH_DEBOUNCE_MS = 400

export function MessageBubble({ message, conversationId, onUpdateMessage }: MessageBubbleProps) {
  const { t } = useT()
  const [showSQL, setShowSQL] = useState(false)
  const [persistError, setPersistError] = useState<string | null>(null)
  const isUser = message.role === 'user'
  const isDone = !message.isStreaming || message.phase === 'done'

  const primaryResult = !isUser ? selectPrimaryResult(message) : undefined

  // debounce 持久化：每次 spec 变化打 timer，到点后 PATCH
  const pendingSpecRef = useRef<ChartSpec | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushPersist = useCallback(async () => {
    const spec = pendingSpecRef.current
    if (!spec || !conversationId) return
    pendingSpecRef.current = null
    try {
      await updateMessageChartSpec(conversationId, message.id, spec)
      setPersistError(null)
    } catch (err) {
      console.error('[ChartSpec] persist failed', err)
      setPersistError(err instanceof Error ? err.message : String(err))
    }
  }, [conversationId, message.id])

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      // 卸载时若还有未保存的，最后一次尝试
      if (pendingSpecRef.current && conversationId) {
        void flushPersist()
      }
    }
  }, [conversationId, flushPersist])

  const handleSpecChange = useCallback(
    (patch: Partial<ChartSpec>) => {
      if (!onUpdateMessage) return
      onUpdateMessage(message.id, (m) => {
        const merged: ChartSpec = {
          chart_type: m.chartSpec?.chart_type ?? 'auto',
          ...m.chartSpec,
          ...patch,
          user_edited: true,
        }
        pendingSpecRef.current = merged
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => {
          void flushPersist()
        }, PATCH_DEBOUNCE_MS)
        return { ...m, chartSpec: merged }
      })
    },
    [message.id, onUpdateMessage, flushPersist]
  )

  return (
    <div className={`message-row ${isUser ? 'user' : ''}`}>
      <div className={`message-avatar ${isUser ? 'user' : 'ai'}`}>
        {isUser ? '👤' : '🤖'}
      </div>
      <div className="message-content">
        <div className={`message-bubble ${isUser ? 'user' : 'ai'}`}>
          {/* Phase progress trail */}
          {!isUser && message.isStreaming && !message.content && message.phaseHistory && message.phaseHistory.length > 0 && (
            <PhasePipeline history={message.phaseHistory} current={message.phase} />
          )}
          {!isUser && message.isStreaming && !message.content && (!message.phaseHistory || message.phaseHistory.length === 0) && (
            <div className="phase-indicator">
              <div className="phase-spinner" />
              <span>{t('thinking')}</span>
            </div>
          )}

          {/* Text content with Markdown rendering */}
          {message.content && (
            <div className="markdown-content">
              {isUser ? (
                <span>{message.content}</span>
              ) : (
                <Markdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{message.content}</Markdown>
              )}
              {message.isStreaming && message.phase === 'answering' && (
                <span className="cursor">▊</span>
              )}
            </div>
          )}

          {/* Error */}
          {message.error && (
            <div className="error-text">
              {t('error')}: {message.error}
            </div>
          )}

          {/* Chart field selector + Chart */}
          {!isUser && isDone && primaryResult && canChartResult(primaryResult) && (() => {
            const spec: ChartSpec = message.chartSpec ?? { chart_type: 'auto' }
            const resolved = resolveSpec(primaryResult, spec)
            return (
              <div className="chart-section">
                {onUpdateMessage && (
                  <ChartFieldSelector
                    result={primaryResult}
                    spec={spec}
                    effectiveChartType={resolved.chartType}
                    effectiveX={resolved.xField}
                    effectiveY={resolved.yFields}
                    effectiveSeries={resolved.seriesField}
                    onChange={handleSpecChange}
                  />
                )}
                {persistError && (
                  <div className="chart-persist-error">
                    {t('error')}: chart settings not saved
                  </div>
                )}
                <Chart result={primaryResult} spec={spec} />
              </div>
            )
          })()}

          {/* Data Table */}
          {!isUser && isDone && primaryResult && primaryResult.rows.length > 0 && (
            <DataTable result={primaryResult} />
          )}

          {/* SQL toggle — only after done */}
          {!isUser && isDone && message.sqlStatements.length > 0 && (
            <div className="sql-section">
              <button
                onClick={() => setShowSQL(!showSQL)}
                className={`sql-toggle ${showSQL ? 'open' : ''}`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
                </svg>
                {showSQL ? t('hideSQL') : t('showSQL')}
                <span className={`sql-toggle-arrow ${showSQL ? 'open' : ''}`}>›</span>
              </button>
              {showSQL && (
                <div className="sql-code-wrapper">
                  <div className="sql-code-header">
                    <span>SQL</span>
                    <button
                      className="sql-copy-btn"
                      onClick={() => {
                        navigator.clipboard.writeText(message.sqlStatements.join('\n\n'))
                      }}
                    >
                      Copy
                    </button>
                  </div>
                  <pre className="sql-code">
                    {message.sqlStatements.join('\n\n')}
                  </pre>
                </div>
              )}
            </div>
          )}

          {/* Feedback button — only after done with results */}
          {!isUser && isDone && primaryResult && (
            <FeedbackButton
              question={message.feedbackQuestion || ''}
              sql={message.sqlStatements[message.sqlStatements.length - 1] || ''}
              sqlResult={primaryResult}
              sessionId=""
            />
          )}
        </div>
      </div>
    </div>
  )
}
