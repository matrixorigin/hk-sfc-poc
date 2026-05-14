import { useState, useCallback, useEffect } from 'react'
import type { Language, ConversationMeta } from './types'
import { LangContext, getT } from './i18n'
import { LangSwitch } from './components/LangSwitch'
import { ChatPanel } from './components/ChatPanel'
import { Sidebar } from './components/Sidebar'
import { KnowledgePanel } from './components/KnowledgePanel'
import { AnalysisPanel } from './components/AnalysisPanel'
import { UserTablePanel } from './components/UserTablePanel'
import {
  listConversations,
  createConversation,
  deleteConversation,
} from './api/conversations'
import './App.css'

const LANG_STORAGE_KEY = 'hk-poc.lang'

function initialLang(): Language {
  try {
    const saved = localStorage.getItem(LANG_STORAGE_KEY)
    if (saved === 'zh' || saved === 'en') return saved
  } catch {
    // localStorage 不可用时回退
  }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh')
    ? 'zh'
    : 'en'
}

function App() {
  const [lang, setLang] = useState<Language>(initialLang)
  const t = getT(lang)

  useEffect(() => {
    try { localStorage.setItem(LANG_STORAGE_KEY, lang) } catch { /* ignore */ }
  }, [lang])

  const [conversations, setConversations] = useState<ConversationMeta[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [knowledgeOpen, setKnowledgeOpen] = useState(false)
  const [analysisOpen, setAnalysisOpen] = useState(false)
  const [tableManageOpen, setTableManageOpen] = useState(false)

  // 启动时从后端加载会话列表
  useEffect(() => {
    listConversations()
      .then(setConversations)
      .catch((err) => console.error('[App] listConversations failed:', err))
  }, [])

  const activeConv = conversations.find((c) => c.id === activeId) || null

  const refreshList = useCallback(async () => {
    try {
      const list = await listConversations()
      setConversations(list)
    } catch (err) {
      console.error('[App] refresh conversations failed:', err)
    }
  }, [])

  const handleNewChat = useCallback(() => {
    setActiveId(null) // 回到欢迎页，会话在发消息时才创建
  }, [])

  const handleSelect = useCallback((id: string) => {
    setActiveId(id)
  }, [])

  const handleDelete = useCallback(async (id: string) => {
    try {
      await deleteConversation(id)
      setConversations((prev) => prev.filter((c) => c.id !== id))
      if (activeId === id) {
        setActiveId(null)
      }
    } catch (err) {
      console.error('[App] deleteConversation failed:', err)
    }
  }, [activeId])

  // 欢迎页第一次发消息时调用：在后端创建一个空会话并切到它。
  const handleEnsureConversation = useCallback(async (): Promise<ConversationMeta> => {
    if (activeConv) return activeConv
    const id = await createConversation()
    const meta: ConversationMeta = {
      id,
      title: '',
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    setConversations((prev) => [meta, ...prev])
    setActiveId(id)
    return meta
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
              onClick={() => setTableManageOpen(true)}
            >
              {t('tableManagement' as any)}
            </button>
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
              onEnsureConversation={handleEnsureConversation}
              onNewChat={handleNewChat}
              onConversationTouched={refreshList}
            />
          </main>
        </div>
      </div>
      <KnowledgePanel open={knowledgeOpen} onClose={() => setKnowledgeOpen(false)} />
      <AnalysisPanel open={analysisOpen} onClose={() => setAnalysisOpen(false)} />
      <UserTablePanel open={tableManageOpen} onClose={() => setTableManageOpen(false)} />
    </LangContext.Provider>
  )
}

export default App
