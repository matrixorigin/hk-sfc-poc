import { useState, useRef, useEffect, useCallback } from 'react'
import { v4 as uuidv4 } from 'uuid'
import type { Message, Conversation } from '../types'
import { useT } from '../i18n'
import { useExploreSSE } from '../hooks/useExploreSSE'
import { MessageBubble } from './MessageBubble'

interface ChatPanelProps {
  conversation: Conversation | null
  onMessagesChange: (messages: Message[]) => void
  onEnsureConversation: () => Conversation
  onNewChat: () => void
}

export function ChatPanel({
  conversation,
  onMessagesChange,
  onEnsureConversation,
  onNewChat,
}: ChatPanelProps) {
  const { t } = useT()
  const [messages, setMessages] = useState<Message[]>(conversation?.messages || [])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const streamingMsgIdRef = useRef<string | null>(null)
  const sessionIdRef = useRef(conversation?.sessionId || uuidv4())
  const prevConvIdRef = useRef<string | null | undefined>(conversation?.id)

  // Sync messages when switching to a DIFFERENT existing conversation.
  // Skip when transitioning from welcome (null) to a new conversation (keeps current messages).
  useEffect(() => {
    const prevId = prevConvIdRef.current
    const newId = conversation?.id
    console.log('[useEffect conv change]', { prevId, newId, messagesLen: messages.length })
    prevConvIdRef.current = newId

    // Only reset if switching between two different existing conversations
    if (prevId && newId && prevId !== newId) {
      setMessages(conversation?.messages || [])
      sessionIdRef.current = conversation?.sessionId || uuidv4()
      setIsLoading(false)
      streamingMsgIdRef.current = null
    }
    // When going from null (welcome) to a new conv, just update sessionId
    if (!prevId && newId) {
      sessionIdRef.current = conversation?.sessionId || uuidv4()
    }
    // When going to null (new chat clicked from sidebar), reset
    if (prevId && !newId) {
      setMessages([])
      setInput('')
      setIsLoading(false)
      streamingMsgIdRef.current = null
    }
  }, [conversation?.id])

  // Notify parent of message changes
  useEffect(() => {
    if (conversation) {
      onMessagesChange(messages)
    }
  }, [messages])

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

  const { send } = useExploreSSE({ onUpdate, onDone, onError })

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = (text?: string) => {
    const question = (text || input).trim()
    console.log('[handleSend]', { question, isLoading, input, text })
    if (!question || isLoading) return

    // Ensure a conversation exists
    const conv = onEnsureConversation()
    console.log('[handleSend] conv created', { id: conv.id, sessionId: conv.sessionId })
    sessionIdRef.current = conv.sessionId

    const userMsg: Message = {
      id: uuidv4(),
      role: 'user',
      content: question,
      sqlResults: [],
      sqlStatements: [],
      isStreaming: false,
    }

    const assistantMsgId = uuidv4()
    const assistantMsg: Message = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      sqlResults: [],
      sqlStatements: [],
      isStreaming: true,
      phase: 'thinking',
    }

    setMessages((prev) => [...prev, userMsg, assistantMsg])
    streamingMsgIdRef.current = assistantMsgId
    setInput('')
    setIsLoading(true)

    send(question, sessionIdRef.current)
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
    { icon: '💰', text: t('example4') },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Messages or welcome */}
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
            <MessageBubble key={msg.id} message={msg} />
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div style={{ borderTop: '1px solid #e4e7ec', background: '#fff' }}>
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
