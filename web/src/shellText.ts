// 官网、管理后台和灵感库共用的非 React 文案入口。
// 翻译表属于公共外壳，不依赖已归档的网页画布。
import { translateShellText } from './shellCatalog'
import type { ShellLang } from './shellLanguage'

let current: ShellLang = 'zh'

export function setShellLang(lang: ShellLang) { current = lang === 'en' ? 'en' : 'zh' }

export function getShellLang(): ShellLang { return current }

// 查不到的原文原样返回：服务端返回的错误文本、HTTP 状态码这些要保留（见产品规则：技术细节不翻译）。
export function shellT(value: unknown, vars?: Record<string, unknown>) {
  return translateShellText(String(value ?? ''), current, vars)
}
