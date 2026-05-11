import { useState, useRef, useEffect, useCallback } from 'react'
import type { Message, ConversationMeta } from '../types'
import { fromStoredMessage } from '../types'
import { useT } from '../i18n'
import { useExploreSSE } from '../hooks/useExploreSSE'
import { MessageBubble } from './MessageBubble'
import { TableSelector } from './TableSelector'
import { listMessages } from '../api/conversations'

interface ChatPanelProps {
  conversation: ConversationMeta | null
  onEnsureConversation: () => Promise<ConversationMeta>
  onNewChat: () => void
  onConversationTouched: () => void
}

// 客户端临时 id 前缀，便于在收到 message.created 后替换
const CLIENT_TEMP_PREFIX = 'client-temp-'

export function ChatPanel({
  conversation,
  onEnsureConversation,
  onNewChat,
  onConversationTouched,
}: ChatPanelProps) {
  const { t } = useT()
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [selectedTables, setSelectedTables] = useState<string[]>([])
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const streamingMsgIdRef = useRef<string | null>(null)
  // 发送期间新建的会话，不要再去 fetch 历史（那会覆盖乐观插入的占位消息）
  const skipNextFetchRef = useRef<string | null>(null)

  // 切换会话时加载对应的消息历史；清空则回到欢迎页
  useEffect(() => {
    const id = conversation?.id
    if (!id) {
      cancel()
      setMessages([])
      setInput('')
      setIsLoading(false)
      streamingMsgIdRef.current = null
      return
    }
    if (skipNextFetchRef.current === id) {
      skipNextFetchRef.current = null
      return
    }
    let cancelled = false
    listMessages(id)
      .then((stored) => {
        if (cancelled) return
        setMessages(stored.map(fromStoredMessage))
        setIsLoading(false)
        streamingMsgIdRef.current = null
      })
      .catch((err) => {
        console.error('[ChatPanel] listMessages failed:', err)
        if (!cancelled) setMessages([])
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation?.id])

  const onUpdate = useCallback((updater: (msg: Message) => Message) => {
    const id = streamingMsgIdRef.current
    if (!id) return
    setMessages((prev) => prev.map((m) => (m.id === id ? updater(m) : m)))
  }, [])

  const handleUpdateMessage = useCallback(
    (id: string, updater: (msg: Message) => Message) => {
      setMessages((prev) => prev.map((m) => (m.id === id ? updater(m) : m)))
    },
    []
  )

  const onDone = useCallback(() => {
    setIsLoading(false)
    streamingMsgIdRef.current = null
    // 刷新会话列表以拿到新的 title / updated_at
    onConversationTouched()
  }, [onConversationTouched])

  const onError = useCallback((error: string) => {
    const id = streamingMsgIdRef.current
    if (id) {
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, isStreaming: false, error } : m))
      )
    }
    setIsLoading(false)
    streamingMsgIdRef.current = null
  }, [])

  // 服务端生成了 message id → 用它替换两条客户端临时 id
  const onMessageCreated = useCallback(
    (userMsgId: string, assistantMsgId: string) => {
      setMessages((prev) => {
        const next = [...prev]
        // 找到最后两条 CLIENT_TEMP_PREFIX 开头的消息，按顺序替换 id
        for (let i = next.length - 1; i >= 0 && (!next[i].id.startsWith(CLIENT_TEMP_PREFIX)); i--) {
          // skip non-temp
        }
        let replaced = 0
        for (let i = next.length - 1; i >= 0 && replaced < 2; i--) {
          if (next[i].id.startsWith(CLIENT_TEMP_PREFIX)) {
            const newId = next[i].role === 'assistant' ? assistantMsgId : userMsgId
            next[i] = { ...next[i], id: newId }
            replaced++
          }
        }
        return next
      })
      // assistant 的新 id 用于后续 onUpdate 定位
      streamingMsgIdRef.current = assistantMsgId
    },
    []
  )

  const { send, cancel } = useExploreSSE({ onUpdate, onDone, onError, onMessageCreated })

  // 只在「新消息加入」或「文本内容增长」时滚动，避免修改图表配置等非新增变化把页面拽到底
  const scrollSig = messages
    .map((m) => `${m.id}:${m.content?.length ?? 0}`)
    .join('|')
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollSig])

  const handleSend = async (text?: string) => {
    const question = (text || input).trim()
    if (!question || isLoading) return

    const conv = await onEnsureConversation()
    // 标记该 id 下一次 useEffect 不要 fetch（否则会覆盖下面的乐观插入）
    skipNextFetchRef.current = conv.id

    const tempUserId = `${CLIENT_TEMP_PREFIX}${Date.now()}-u`
    const tempAssistantId = `${CLIENT_TEMP_PREFIX}${Date.now()}-a`

    const userMsg: Message = {
      id: tempUserId,
      role: 'user',
      content: question,
      sqlResults: [],
      sqlStatements: [],
      isStreaming: false,
    }
    const assistantMsg: Message = {
      id: tempAssistantId,
      role: 'assistant',
      content: '',
      sqlResults: [],
      sqlStatements: [],
      isStreaming: true,
      phase: 'thinking',
      phaseHistory: ['thinking'],
      feedbackQuestion: question,
    }

    setMessages((prev) => [...prev, userMsg, assistantMsg])
    streamingMsgIdRef.current = tempAssistantId
    setInput('')
    setIsLoading(true)

    send(conv.id, question, selectedTables.length > 0 ? selectedTables : undefined)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const examples = [
    { icon: '📉', text: t('example1') },
    { icon: '🏭', text: t('example2') },
    { icon: '📊', text: t('example3') },
    { icon: '📰', text: t('example4') },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="messages-area">
        {messages.length === 0 ? (
          <div className="welcome">
            <div className="welcome-icon">📈</div>
            <h2>{t('welcomeTitle')}</h2>
            <p>{t('welcomeDesc')}</p>
            <div className="example-grid">
              {examples.map((ex, i) => (
                <div
                  key={i}
                  className="example-card"
                  onClick={() => { setInput(ex.text); inputRef.current?.focus() }}
                >
                  <span className="example-icon">{ex.icon}</span>
                  {ex.text}
                </div>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              conversationId={conversation?.id}
              onUpdateMessage={handleUpdateMessage}
            />
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="input-section">
        <TableSelector selected={selectedTables} onChange={setSelectedTables} />
        <div className="input-area">
          <button onClick={onNewChat} className="btn-new-chat">
            ✦ {t('newChat')}
          </button>
          <div className="input-wrapper">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('placeholder')}
              rows={1}
            />
          </div>
          <button
            onClick={() => handleSend()}
            disabled={!input.trim() || isLoading}
            className={`btn-send ${input.trim() && !isLoading ? 'active' : 'disabled'}`}
          >
            {t('send')} →
          </button>
        </div>
      </div>
    </div>
  )
}
