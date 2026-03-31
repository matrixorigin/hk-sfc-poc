import { createContext, useContext } from 'react'
import type { Language } from '../types'
import en from './en.json'
import zh from './zh.json'

type Translations = typeof en

const translations: Record<Language, Translations> = { en, zh }

export function getT(lang: Language) {
  return (key: keyof Translations): string => translations[lang][key] ?? key
}

interface LangContextValue {
  lang: Language
  setLang: (lang: Language) => void
  t: (key: keyof Translations) => string
}

export const LangContext = createContext<LangContextValue>({
  lang: 'en',
  setLang: () => {},
  t: getT('en'),
})

export function useT() {
  return useContext(LangContext)
}

export function tpl(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? ''))
}
