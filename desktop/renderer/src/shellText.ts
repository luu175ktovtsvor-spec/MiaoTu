// 非 React 模块（lib/**、stores/**）的取词入口。这些模块不能用 hook，
// 由 LangProvider 在外壳语言变化时把当前语言注入这里；词典只有一份，
// 就是 studio/studioText 里那张中文原文 → 英文的表，所以
// shellT('文件操作失败') 和 React 里的 studioText('文件操作失败', lang) 结果一致。
//
// 注意：这里给的是「外壳」语言。画布内部的语言由画布自己的词典决定
// （web/src/studio/canvas/i18n），画布内的文案不要用 shellT。
import { studioText } from './studio/studioText'
import type { ShellLang } from './shellLanguage'

let current: ShellLang = 'zh'

export function setShellLang(lang: ShellLang) { current = lang === 'en' ? 'en' : 'zh' }

export function getShellLang(): ShellLang { return current }

// 查不到的原文原样返回：服务端返回的错误文本、HTTP 状态码这些要保留（见产品规则：技术细节不翻译）。
export function shellT(value: unknown, vars?: Record<string, unknown>) {
  return studioText(String(value ?? ''), current, vars)
}
