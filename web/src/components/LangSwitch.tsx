import { useT } from '../i18n'
import type { Language } from '../types'

export function LangSwitch() {
  const { lang, setLang } = useT()

  const toggle = () => {
    const next: Language = lang === 'en' ? 'zh' : 'en'
    setLang(next)
  }

  return (
    <button
      onClick={toggle}
      style={{
        padding: '4px 12px',
        border: '1px solid #d0d0d0',
        borderRadius: 6,
        background: '#fff',
        cursor: 'pointer',
        fontSize: 14,
        fontWeight: 500,
        color: '#333',
      }}
    >
      {lang === 'en' ? '中文' : 'EN'}
    </button>
  )
}
