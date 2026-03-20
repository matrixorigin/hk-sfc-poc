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
    <div
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        marginBottom: 16,
        padding: '0 16px',
      }}
    >
      <div
        style={{
          maxWidth: '80%',
          background: isUser ? '#1677ff' : '#f0f0f0',
          color: isUser ? '#fff' : '#1a1a1a',
          borderRadius: isUser ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
          padding: '10px 16px',
          wordBreak: 'break-word',
        }}
      >
        {/* 文本内容 */}
        {message.content && (
          <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
            {message.content}
            {message.isStreaming && (
              <span className="cursor" style={{ marginLeft: 2 }}>
                |
              </span>
            )}
          </div>
        )}

        {/* 流式思考中占位 */}
        {message.isStreaming && !message.content && (
          <div style={{ color: isUser ? '#fff' : '#888', fontStyle: 'italic' }}>
            {t('thinking')}
            <span className="cursor" style={{ marginLeft: 2 }}>
              |
            </span>
          </div>
        )}

        {/* 错误信息 */}
        {message.error && (
          <div style={{ color: '#ff4d4f', marginTop: 8, fontSize: 13 }}>
            {t('error')}: {message.error}
          </div>
        )}

        {/* 数据表格 + 图表 */}
        {!isUser && message.sqlResults.map((result, i) => (
          <div key={i} style={{ marginTop: 12 }}>
            <DataTable result={result} />
            <Chart result={result} />
          </div>
        ))}

        {/* SQL 折叠 */}
        {!isUser && message.sqlStatements.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <button
              onClick={() => setShowSQL(!showSQL)}
              style={{
                background: 'none',
                border: '1px solid #ccc',
                borderRadius: 4,
                padding: '2px 8px',
                cursor: 'pointer',
                fontSize: 12,
                color: '#555',
              }}
            >
              {showSQL ? t('hideSQL') : t('showSQL')}
            </button>
            {showSQL && (
              <pre
                style={{
                  marginTop: 8,
                  padding: '8px 12px',
                  background: '#1e1e1e',
                  color: '#d4d4d4',
                  borderRadius: 6,
                  fontSize: 12,
                  overflowX: 'auto',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {message.sqlStatements.join('\n\n')}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
