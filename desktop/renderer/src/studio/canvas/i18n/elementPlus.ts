// Element Plus 自带文案（分页、日期、确认框按钮等）跟随画布语言。
// 直接复用 element-plus 已装的官方语言包，不自己维护一份；同样按语言动态加载，
// 不让这十几个包挤进首屏。
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import type { Locale } from './index'

export type ElementLocale = typeof zhCn

// fil / ur / mr：Element Plus 没有对应语言包，回落到英文。只影响它自己的
// 分页、日期这类文案，画布文案仍然走我们的语言包。
const loaders: Partial<Record<Locale, () => Promise<{ default: ElementLocale }>>> = {
  'zh-CN': () => import('element-plus/es/locale/lang/zh-cn'),
  'zh-TW': () => import('element-plus/es/locale/lang/zh-tw'),
  en: () => import('element-plus/es/locale/lang/en'),
  ja: () => import('element-plus/es/locale/lang/ja'),
  ru: () => import('element-plus/es/locale/lang/ru'),
  vi: () => import('element-plus/es/locale/lang/vi'),
  th: () => import('element-plus/es/locale/lang/th'),
  ko: () => import('element-plus/es/locale/lang/ko'),
  hi: () => import('element-plus/es/locale/lang/hi'),
  id: () => import('element-plus/es/locale/lang/id'),
  ms: () => import('element-plus/es/locale/lang/ms'),
  bn: () => import('element-plus/es/locale/lang/bn'),
  ta: () => import('element-plus/es/locale/lang/ta'),
  te: () => import('element-plus/es/locale/lang/te'),
  pa: () => import('element-plus/es/locale/lang/pa'),
  ar: () => import('element-plus/es/locale/lang/ar'),
  fa: () => import('element-plus/es/locale/lang/fa'),
  tr: () => import('element-plus/es/locale/lang/tr'),
}

// 画布默认中文：首屏先用中文包渲染，之后按语言异步替换。
export const defaultElementLocale: ElementLocale = zhCn

const cache = new Map<Locale, ElementLocale>()

export async function loadElementLocale(locale: Locale): Promise<ElementLocale> {
  const cached = cache.get(locale)
  if (cached) return cached
  const load = loaders[locale] ?? loaders.en
  if (!load) return defaultElementLocale
  try {
    const module = await load()
    cache.set(locale, module.default)
    return module.default
  } catch {
    // 包加载失败不该让界面挂掉：用默认包，画布文案不受影响。
    return defaultElementLocale
  }
}
