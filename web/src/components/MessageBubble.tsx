import { useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import type { Message } from '../types'
import { useT } from '../i18n'
import { Chart } from './Chart'

interface MessageBubbleProps {
  message: Message
}

const phaseLabels: Record<string, { en: string; zh: string }> = {
  thinking:  { en: 'Understanding your question', zh: '正在理解问题' },
  planning:  { en: 'Generating query plan',       zh: '正在生成查询方案' },
  querying:  { en: 'Querying database',           zh: '正在查询数据库' },
  answering: { en: 'Generating answer',           zh: '正在生成回答' },
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const { t, lang } = useT()
  const [showSQL, setShowSQL] = useState(false)
  const isUser = message.role === 'user'
  const isDone = !message.isStreaming || message.phase === 'done'

  const phaseLabel = message.phase && phaseLabels[message.phase]
    ? phaseLabels[message.phase][lang]
    : null

  return (
    <div className={`message-row ${isUser ? 'user' : ''}`}>
      <div className={`message-avatar ${isUser ? 'user' : 'ai'}`}>
        {isUser ? '👤' : '🤖'}
      </div>
      <div className="message-content">
        <div className={`message-bubble ${isUser ? 'user' : 'ai'}`}>
          {/* Phase progress indicator */}
          {!isUser && message.isStreaming && !message.content && (
            <div className="phase-indicator">
              <div className="phase-spinner" />
              <span>{phaseLabel || t('thinking')}</span>
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

          {/* Chart — driven by chartSpec when available */}
          {!isUser && isDone && message.sqlResults.length > 0 && (() => {
            const { chartSpec } = message
            if (chartSpec?.chart_type === 'none') return null

            let chartResult = chartSpec?.round_index !== undefined
              ? message.sqlResults.find((r) => r.round_index === chartSpec.round_index)
              : undefined
            if (!chartResult) {
              chartResult = message.sqlResults.reduce((best, r) =>
                r.columns.length > best.columns.length ? r : best
              )
            }
            return <Chart result={chartResult} spec={chartSpec} />
          })()}

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
        </div>
      </div>
    </div>
  )
}
