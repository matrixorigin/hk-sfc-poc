import { useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import type { Message } from '../types'
import { useT } from '../i18n'
import { Chart } from './Chart'
import { DataTable } from './DataTable'
import { FeedbackButton } from './FeedbackButton'
import { PhasePipeline } from './PhasePipeline'
import { selectPrimaryResult } from '../utils/selectPrimaryResult'

interface MessageBubbleProps {
  message: Message
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const { t } = useT()
  const [showSQL, setShowSQL] = useState(false)
  const isUser = message.role === 'user'
  const isDone = !message.isStreaming || message.phase === 'done'

  const primaryResult = !isUser ? selectPrimaryResult(message) : undefined

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

          {/* Chart */}
          {!isUser && isDone && primaryResult && (() => {
            const { chartSpec } = message
            if (chartSpec?.chart_type === 'none') return null
            return <Chart result={primaryResult} spec={chartSpec} />
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
