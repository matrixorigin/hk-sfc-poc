import { useState, useCallback, useEffect } from 'react'
import type { Language, ConversationMeta } from './types'
import { LangContext, getT } from './i18n'
import { LangSwitch } from './components/LangSwitch'
import { ChatPanel } from './components/ChatPanel'
import { Sidebar } from './components/Sidebar'
import { KnowledgePanel } from './components/KnowledgePanel'
import { AnalysisPanel } from './components/AnalysisPanel'
import { UserTablePanel } from './components/UserTablePanel'
import { LoginPage } from './components/LoginPage'
import { UserManagement } from './components/UserManagement'
import { GuidePanel } from './components/GuidePanel'
import { getMe, logout, type AuthUser } from './api/auth'
import { setUnauthorizedHandler } from './api/client'
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

  const [user, setUser] = useState<AuthUser | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [authMessage, setAuthMessage] = useState('')
  const [conversations, setConversations] = useState<ConversationMeta[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [knowledgeOpen, setKnowledgeOpen] = useState(false)
  const [analysisOpen, setAnalysisOpen] = useState(false)
  const [tableManageOpen, setTableManageOpen] = useState(false)
  const [userManagementOpen, setUserManagementOpen] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const [tableRefreshKey, setTableRefreshKey] = useState(0)

  const clearUserState = useCallback((message = '') => {
    setUser(null)
    setAuthMessage(message)
    setConversations([])
    setActiveId(null)
    setKnowledgeOpen(false)
    setAnalysisOpen(false)
    setTableManageOpen(false)
    setUserManagementOpen(false)
    setGuideOpen(false)
  }, [setActiveId, setAnalysisOpen, setAuthMessage, setConversations, setGuideOpen, setKnowledgeOpen, setTableManageOpen, setUser, setUserManagementOpen])

  useEffect(() => {
    setUnauthorizedHandler((message) => clearUserState(message))
    return () => setUnauthorizedHandler(null)
  }, [clearUserState])

  useEffect(() => {
    getMe()
      .then((currentUser) => {
        if (currentUser) setUser(currentUser)
      })
      .catch((err) => setAuthMessage(err instanceof Error ? err.message : ''))
      .finally(() => setAuthChecked(true))
  }, [])

  const handleLogout = useCallback(async () => {
    await logout()
    clearUserState()
  }, [clearUserState])

  useEffect(() => {
    if (user) {
      listConversations()
        .then(setConversations)
        .catch((err) => console.error('[App] listConversations failed:', err))
    }
  }, [user])

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

  if (!authChecked) {
    return <div style={{ minHeight: '100vh', background: '#f5f6fa' }} />
  }

  if (!user) {
    return (
      <LangContext.Provider value={{ lang, setLang, t }}>
        <LoginPage
          initialError={authMessage}
          onLogin={(loggedInUser) => {
            setAuthMessage('')
            setUser(loggedInUser)
          }}
        />
      </LangContext.Provider>
    )
  }

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
          <div className="header-actions">
            {user.is_admin ? (
              <button className="lang-switch" onClick={() => setUserManagementOpen(true)}>
                {t('userManagement')}
              </button>
            ) : null}
            <button
              className="lang-switch"
              onClick={() => setTableManageOpen(true)}
            >
              {t('tableManagement')}
            </button>
            <button
              className="lang-switch"
              onClick={() => setAnalysisOpen(true)}
            >
              {t('analysisCenter')}
            </button>
            <button
              className="lang-switch"
              onClick={() => setKnowledgeOpen(true)}
            >
              {t('knowledge')}
            </button>
            <button
              className="lang-switch"
              type="button"
              onClick={() => setGuideOpen(true)}
              aria-label={t('openGuide')}
              title={t('openGuide')}
            >
              {t('guide')}
            </button>
            <span className="header-username">{user.username}</span>
            <button className="lang-switch" onClick={handleLogout}>
              {t('logout')}
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
              tableRefreshKey={tableRefreshKey}
            />
          </main>
        </div>
      </div>
      <KnowledgePanel open={knowledgeOpen} onClose={() => setKnowledgeOpen(false)} />
      <AnalysisPanel open={analysisOpen} onClose={() => setAnalysisOpen(false)} />
      <UserTablePanel open={tableManageOpen} onClose={() => setTableManageOpen(false)} onTablesChanged={() => setTableRefreshKey(k => k + 1)} />
      <GuidePanel open={guideOpen} onClose={() => setGuideOpen(false)} />
      {userManagementOpen && user.is_admin ? (
        <UserManagement onClose={() => setUserManagementOpen(false)} />
      ) : null}
    </LangContext.Provider>
  )
}

export default App
