import { useState } from 'react'
import type { Message } from '../types'
import { useT } from '../i18n'
import { DataTable } from './DataTable'
import { Chart } from './Chart'

interface MessageBubbleProps {
  message: Message
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const { t } = useT()
  const [showSQL, setShowSQL] = useState(false)
  const isUser = message.role === 'user'

  return (
    <div className={`message-row ${isUser ? 'user' : ''}`}>
      <div className={`message-avatar ${isUser ? 'user' : 'ai'}`}>
        {isUser ? '👤' : '🤖'}
      </div>
      <div className="message-content">
        <div className={`message-bubble ${isUser ? 'user' : 'ai'}`}>
          {/* Text content */}
          {message.content && (
            <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.65 }}>
              {message.content}
              {message.isStreaming && (
                <span className="cursor" style={{ marginLeft: 2 }}>▊</span>
              )}
            </div>
          )}

          {/* Thinking animation */}
          {message.isStreaming && !message.content && (
            <div className="thinking-dots" style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#94a3b8' }}>
              <span>{t('thinking')}</span>
              <span>·</span>
              <span>·</span>
              <span>·</span>
            </div>
          )}

          {/* Error */}
          {message.error && (
            <div className="error-text">
              {t('error')}: {message.error}
            </div>
          )}

          {/* Data table + chart */}
          {!isUser && message.sqlResults.map((result, i) => (
            <div key={i}>
              <DataTable result={result} />
              <Chart result={result} />
            </div>
          ))}

          {/* SQL toggle */}
          {!isUser && message.sqlStatements.length > 0 && (
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
