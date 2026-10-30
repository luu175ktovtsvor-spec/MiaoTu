// 外壳取词入口。词条不在代码里：locales/shell/<locale>.json，key 是中文原文或 id，
// 回落规则见 shellCatalog.ts。scripts/check-locales.ts 会校验这里出现的每个 studioText('中文') 在所有语言包里都有。
import { shellMessage } from '../shellCatalog'
import { normalizeShellLang } from '../shellLanguage'
import type { ShellLang } from '../shellLanguage'

// 调用方有的拿到的是 string（props 里的 lang），老值 'zh' 当简体中文认；认不出的语言按英文，不给中文。
type Lang = string

const resolve = (lang: Lang): ShellLang => normalizeShellLang(lang) ?? 'en'

// vars 用于 {name} 占位符；需要单复数的词条在各语言词典里写 ICU（{value, plural, one {…} other {…}}）。
export function studioText(value: string, lang: Lang = 'zh-CN', vars?: Record<string, unknown>) {
  return shellMessage(resolve(lang), value, vars)
}

// 历史记录的总条数与页码、张数：数词变化交给词典里的 ICU。
export function studioRecords(value: number | string, lang: Lang = 'zh-CN') {
  return shellMessage(resolve(lang), 'studio.records', { value: Number(value) })
}

export function studioPage(page: number | string, total: number | string, lang: Lang = 'zh-CN') {
  return shellMessage(resolve(lang), 'studio.page', { page, total })
}

export function studioCount(value: number | string, lang: Lang = 'zh-CN') {
  return shellMessage(resolve(lang), 'studio.imageCount', { value: Number(value) })
}

// 积分数值的「数字」和「单位」分开给：余额那种大数字 + 小单位的排版要拆开摆。
export function studioPointParts(value: unknown, lang: Lang = 'zh-CN') {
  // 积分按一/两位小数结算，浮点累加会出现 4.800000000000001 这类尾差，展示前统一收敛。
  const number = Number(value)
  const shown = Number.isFinite(number) ? Math.round(number * 100) / 100 : value
  return {
    value: String(shown),
    unit: shellMessage(resolve(lang), 'studio.creditsUnit', { value: Number(shown) }),
  }
}

export function studioPoint(value: unknown, lang: Lang = 'zh-CN') {
  const { value: amount, unit } = studioPointParts(value, lang)
  return `${amount} ${unit}`
}
