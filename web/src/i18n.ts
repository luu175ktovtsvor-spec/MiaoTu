import { createContext, useContext } from 'react'

export const LANG_OPTIONS = [
  { code: 'en', short: 'EN', label: 'English' },
  { code: 'zh', short: '中', label: '中文' },
]

export const dict = {
  en: {
    'app.title': 'MiaoImg',
    'lang.label': 'Language',
  },
  zh: {
    'app.title': '妙图',
    'lang.label': '语言',
  },
}

// 不走 hook 的地方（document.title、初始化脚本之类）按语言取词，规则与 LangProvider 的 t 一致。
export function dictText(lang, key) {
  const table = dict[lang] || dict.en
  return table[key] ?? dict.en[key] ?? key
}

export const LangContext = createContext(null)

export function useLang() {
  const context = useContext(LangContext)
  if (!context) throw new Error('useLang must be used within LangProvider')
  return context
}
