import { useState, useRef, useEffect, useCallback } from 'react'
import { v4 as uuidv4 } from 'uuid'
import type { Message } from '../types'
import { useT } from '../i18n'
import { useExploreSSE } from '../hooks/useExploreSSE'
import { MessageBubble } from './MessageBubble'

export function ChatPanel() {
  const { t } = useT()
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [sessionId] = useState(() => uuidv4())
  const [isLoading, setIsLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // 当前正在流式输出的消息 id
  const streamingMsgIdRef = useRef<string | null>(null)

  const onUpdate = useCallback((updater: (msg: Message) => Message) => {
    const id = streamingMsgIdRef.current
    if (!id) return
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? updater(m) : m))
    )
  }, [])

  const onDone = useCallback(() => {
    setIsLoading(false)
    streamingMsgIdRef.current = null
  }, [])

  const onError = useCallback((error: string) => {
    const id = streamingMsgIdRef.current
    if (id) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === id ? { ...m, isStreaming: false, error } : m
        )
      )
    }
    setIsLoading(false)
    streamingMsgIdRef.current = null
  }, [])

  const { send, cancel } = useExploreSSE({ onUpdate, onDone, onError })

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = () => {
    const question = input.trim()
    if (!question || isLoading) return

    // 添加用户消息
    const userMsg: Message = {
      id: uuidv4(),
      role: 'user',
      content: question,
      sqlResults: [],
      sqlStatements: [],
      isStreaming: false,
    }

    // 添加 AI 占位消息
    const assistantMsgId = uuidv4()
    const assistantMsg: Message = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      sqlResults: [],
      sqlStatements: [],
      isStreaming: true,
    }

    setMessages((prev) => [...prev, userMsg, assistantMsg])
    streamingMsgIdRef.current = assistantMsgId
    setInput('')
    setIsLoading(true)

    send(question, sessionId)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleNewChat = () => {
    cancel()
    setMessages([])
    setIsLoading(false)
    streamingMsgIdRef.current = null
    inputRef.current?.focus()
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: '#fff',
      }}
    >
      {/* 消息列表 */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '16px 0',
        }}
      >
        {messages.length === 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: '#bbb',
              fontSize: 15,
            }}
          >
            {t('placeholder')}
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* 输入区域 */}
      <div
        style={{
          borderTop: '1px solid #eee',
          padding: '12px 16px',
          display: 'flex',
          gap: 8,
          alignItems: 'flex-end',
          background: '#fafafa',
        }}
      >
        <button
          onClick={handleNewChat}
          style={{
            padding: '8px 14px',
            border: '1px solid #d0d0d0',
            borderRadius: 8,
            background: '#fff',
            cursor: 'pointer',
            fontSize: 13,
            color: '#555',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {t('newChat')}
        </button>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('placeholder')}
          rows={1}
          style={{
            flex: 1,
            resize: 'none',
            padding: '8px 12px',
            border: '1px solid #d0d0d0',
            borderRadius: 8,
            fontSize: 14,
            lineHeight: 1.5,
            outline: 'none',
            background: '#fff',
            fontFamily: 'inherit',
          }}
        />
        <button
          onClick={handleSend}
          disabled={!input.trim() || isLoading}
          style={{
            padding: '8px 20px',
            border: 'none',
            borderRadius: 8,
            background: input.trim() && !isLoading ? '#1677ff' : '#b0c8f0',
            color: '#fff',
            cursor: input.trim() && !isLoading ? 'pointer' : 'not-allowed',
            fontSize: 14,
            fontWeight: 500,
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {t('send')}
        </button>
      </div>
    </div>
  )
}
