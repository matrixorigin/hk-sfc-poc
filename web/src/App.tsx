import { useState } from 'react'
import type { Language } from './types'
import { LangContext, getT } from './i18n'
import { LangSwitch } from './components/LangSwitch'
import { ChatPanel } from './components/ChatPanel'
import './App.css'

function App() {
  const [lang, setLang] = useState<Language>('en')
  const t = getT(lang)

  return (
    <LangContext.Provider value={{ lang, setLang, t }}>
      <div className="app">
        <header className="header">
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{t('title')}</h1>
          <LangSwitch />
        </header>
        <main className="main">
          <ChatPanel />
        </main>
      </div>
    </LangContext.Provider>
  )
}

export default App
