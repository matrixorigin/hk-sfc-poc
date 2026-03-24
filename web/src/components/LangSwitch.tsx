import { useT } from '../i18n'
import type { Language } from '../types'

export function LangSwitch() {
  const { lang, setLang } = useT()

  const toggle = () => {
    const next: Language = lang === 'en' ? 'zh' : 'en'
    setLang(next)
  }

  return (
    <button onClick={toggle} className="lang-switch">
      {lang === 'en' ? '中文' : 'EN'}
    </button>
  )
}
