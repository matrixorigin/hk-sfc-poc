import { useState } from 'react'
import type { Message } from '../types'
import { useT } from '../i18n'
import { DataTable } from './DataTable'
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

  // Phase-based progress label
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
          {/* Phase progress indicator (before answer starts) */}
          {!isUser && message.isStreaming && !message.content && (
            <div className="phase-indicator">
              <div className="phase-spinner" />
              <span>{phaseLabel || t('thinking')}</span>
            </div>
          )}

          {/* Text content */}
          {message.content && (
            <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.65 }}>
              {message.content}
              {message.isStreaming && message.phase === 'answering' && (
                <span className="cursor" style={{ marginLeft: 2 }}>▊</span>
              )}
            </div>
          )}

          {/* Error */}
          {message.error && (
            <div className="error-text">
              {t('error')}: {message.error}
            </div>
          )}

          {/* Data table + chart — only show when we have results */}
          {!isUser && message.sqlResults.map((result, i) => (
            <div key={i}>
              <DataTable result={result} />
              <Chart result={result} />
            </div>
          ))}

          {/* SQL toggle — only show after streaming is done */}
          {!isUser && isDone && message.sqlStatements.length > 0 && (
            <div>
              <button
                onClick={() => setShowSQL(!showSQL)}
                className="sql-toggle"
              >
                {showSQL ? '▾' : '▸'} {showSQL ? t('hideSQL') : t('showSQL')}
              </button>
              {showSQL && (
                <pre className="sql-code">
                  {message.sqlStatements.join('\n\n')}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
