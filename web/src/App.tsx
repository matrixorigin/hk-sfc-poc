import { useState, useCallback, useEffect } from 'react'
import { v4 as uuidv4 } from 'uuid'
import type { Language, Conversation, Message } from './types'
import { LangContext, getT } from './i18n'
import { LangSwitch } from './components/LangSwitch'
import { ChatPanel } from './components/ChatPanel'
import { Sidebar } from './components/Sidebar'
import { KnowledgePanel } from './components/KnowledgePanel'
import { AnalysisPanel } from './components/AnalysisPanel'
import './App.css'

const STORAGE_KEY = 'hk-poc-conversations'

function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveConversations(convs: Conversation[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(convs))
}

function createConversation(): Conversation {
  return {
    id: uuidv4(),
    sessionId: uuidv4(),
    title: '',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function App() {
  const [lang, setLang] = useState<Language>('en')
  const t = getT(lang)

  const [conversations, setConversations] = useState<Conversation[]>(loadConversations)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [knowledgeOpen, setKnowledgeOpen] = useState(false)
  const [analysisOpen, setAnalysisOpen] = useState(false)

  // Persist conversations on change
  useEffect(() => {
    saveConversations(conversations)
  }, [conversations])

  const activeConv = conversations.find((c) => c.id === activeId) || null

  const handleNewChat = useCallback(() => {
    console.log('[handleNewChat] activeId before clear:', activeId)
    setActiveId(null) // 回到欢迎页，会话在发消息时才创建
  }, [activeId])

  const handleSelect = useCallback((id: string) => {
    setActiveId(id)
  }, [])

  const handleDelete = useCallback((id: string) => {
    setConversations((prev) => prev.filter((c) => c.id !== id))
    if (activeId === id) {
      setActiveId(null)
    }
  }, [activeId])

  const handleMessagesChange = useCallback((messages: Message[]) => {
    if (!activeId) return
    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== activeId) return c
        // Auto-title from first user message
        let title = c.title
        if (!title) {
          const firstUser = messages.find((m) => m.role === 'user')
          if (firstUser) {
            title = firstUser.content.slice(0, 50) + (firstUser.content.length > 50 ? '...' : '')
          }
        }
        return { ...c, messages, title, updatedAt: Date.now() }
      })
    )
  }, [activeId])

  // Auto-create first conversation if needed when sending from welcome
  const handleEnsureConversation = useCallback((): Conversation => {
    if (activeConv) return activeConv
    const conv = createConversation()
    setConversations((prev) => [conv, ...prev])
    setActiveId(conv.id)
    return conv
  }, [activeConv])

  return (
    <LangContext.Provider value={{ lang, setLang, t }}>
      <div className="app">
        <header className="header">
          <div className="header-left">
            <button
              className="sidebar-menu-btn"
              onClick={() => setSidebarCollapsed((v) => !v)}
            >
              ☰
            </button>
            <div className="header-logo">HK</div>
            <div>
              <h1>{t('title')}</h1>
              <div className="header-subtitle">{t('subtitle')}</div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              className="lang-switch"
              onClick={() => setAnalysisOpen(true)}
            >
              {t('analysisCenter' as any)}
            </button>
            <button
              className="lang-switch"
              onClick={() => setKnowledgeOpen(true)}
            >
              {t('knowledge')}
            </button>
            <LangSwitch />
          </div>
        </header>
        <div className="app-body">
          <Sidebar
            conversations={conversations}
            activeId={activeId}
            onSelect={handleSelect}
            onNew={handleNewChat}
            onDelete={handleDelete}
            collapsed={sidebarCollapsed}
            onToggle={() => setSidebarCollapsed((v) => !v)}
          />
          <main className="main">
            <ChatPanel
              conversation={activeConv}
              onMessagesChange={handleMessagesChange}
              onEnsureConversation={handleEnsureConversation}
              onNewChat={handleNewChat}
            />
          </main>
        </div>
      </div>
      <KnowledgePanel open={knowledgeOpen} onClose={() => setKnowledgeOpen(false)} />
      <AnalysisPanel open={analysisOpen} onClose={() => setAnalysisOpen(false)} />
    </LangContext.Provider>
  )
}

export default App
