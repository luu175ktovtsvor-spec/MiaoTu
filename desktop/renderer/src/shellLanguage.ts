// 画布语言 ↔ 外壳语言。外壳和画布一样支持 21 种界面语言（清单与归一化规则在
// studio/canvas/i18n/locales.ts，两边共用同一份），外壳语言直接就是画布语言，不再映射成中/英。
//
// 画布语言存在画布设置里（localStorage，键与 stores/settings.ts 一致）。这里只读写这一份存储，
// 不导入 stores/settings（那是 Vue 模块，会把 Vue 和节点依赖拖进落地页/灵感库的首屏包）。
// 语言变化有两路通知：同页由 stores/settings 的 watcher 调 notifyCanvasLanguage，
// 跨标签页由 storage 事件兜底（LangProvider 里监听）。
import { detectLocale, isRtlLocale, normalizeLocale, supportedLocales } from './studio/canvas/i18n/locales'
import type { Locale } from './studio/canvas/i18n/locales'

export const CANVAS_SETTINGS_KEY = 'miaoimg.canvas.settings'

export type ShellLang = Locale
export { supportedLocales, isRtlLocale }

// 老用户存下来的 'zh'（中英双语时代）归一成 'zh-CN'；'en' 与 21 种语言代码原样认；认不出返回 undefined。
export function normalizeShellLang(value: unknown): ShellLang | undefined {
  return normalizeLocale(value)
}

export function isChineseLang(lang: unknown) {
  return lang === 'zh-CN' || lang === 'zh-TW'
}

// 给 Intl / toLocaleString 用的 BCP 47 标签：英文保持 en-US，其余语言直接用语言代码。
export function intlLocale(lang: unknown) {
  const locale = normalizeLocale(lang)
  return !locale || locale === 'en' ? 'en-US' : locale
}

// 数据本身只有中/英两份的内容（案例库的分类与标题、提示词译文、标签）按这个二选一。
// 这是内容选择，不是界面文案：界面文字一律走词典。
export type ContentLang = 'zh' | 'en'
export function contentLang(lang: unknown): ContentLang {
  return isChineseLang(lang) ? 'zh' : 'en'
}

// 'system' 表示画布跟随浏览器语言，外壳跟着一起判。浏览器语言一个都不支持时按规则从严：给英文，不给中文。
function systemShellLang(): ShellLang {
  const languages = globalThis.navigator?.languages?.length
    ? globalThis.navigator.languages
    : globalThis.navigator?.language ? [globalThis.navigator.language] : []
  return detectLocale(languages)
}

// 返回空串表示「画布还没挑过语言」，由调用方决定用什么默认值。
export function shellLangForCanvas(value: unknown): ShellLang | '' {
  const tag = String(value ?? '').trim().replaceAll('_', '-').toLowerCase()
  if (!tag) return ''
  if (tag === 'system') return systemShellLang()
  return normalizeLocale(tag) ?? 'en'
}

export function readCanvasLanguage(): string {
  try {
    const raw = globalThis.localStorage?.getItem(CANVAS_SETTINGS_KEY)
    if (!raw) return ''
    const ui = JSON.parse(raw)?.ui
    return typeof ui?.language === 'string' ? ui.language : ''
  } catch {
    // 存储损坏或隐私模式下拿不到：当作没挑过。
    return ''
  }
}

// 外壳顶栏的语言选择是用户明确的选择，写回画布语言，让两套界面说的是同一种语言。
// 只改 ui.language，其余画布设置原样保留。
export function writeCanvasLanguage(lang: ShellLang) {
  const language = normalizeLocale(lang) ?? 'en'
  try {
    let stored: Record<string, unknown> = {}
    const raw = globalThis.localStorage?.getItem(CANVAS_SETTINGS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed
    }
    const ui = stored.ui && typeof stored.ui === 'object' && !Array.isArray(stored.ui) ? stored.ui : {}
    globalThis.localStorage?.setItem(CANVAS_SETTINGS_KEY, JSON.stringify({ ...stored, ui: { ...ui, language } }))
  } catch {
    // 存不进去不影响当前页面的语言，下一次进画布时按画布自己的设置走。
  }
  notifyCanvasLanguage(language)
}

// <html lang> / <html dir> 同一时刻只能有一个写手：外壳按外壳语言写，画布按画布语言写，
// 两边都写就会按各自的时机互相覆盖（实测：画布切到日语后 lang 被外壳改回 en）。
// 规则：画布挂载着的时候归画布（它按 21 种语言写，还有 RTL）；画布不在（登录页、历史、账号）归外壳。
let canvasOwnsDocumentLanguage = false
const ownerListeners = new Set<(owned: boolean) => void>()

export function canvasOwnsDocumentLanguageNow() { return canvasOwnsDocumentLanguage }

export function subscribeDocumentLanguageOwner(listener: (owned: boolean) => void) {
  ownerListeners.add(listener)
  return () => { ownerListeners.delete(listener) }
}

function setDocumentLanguageOwner(owned: boolean) {
  if (canvasOwnsDocumentLanguage === owned) return
  canvasOwnsDocumentLanguage = owned
  for (const listener of [...ownerListeners]) listener(owned)
}

// 画布挂载时认领、卸载时交回（见 studio/MiaoCanvasMount.tsx）。
export function claimDocumentLanguage() { setDocumentLanguageOwner(true) }
export function releaseDocumentLanguage() { setDocumentLanguageOwner(false) }

const listeners = new Set<(value: string) => void>()

export function subscribeCanvasLanguage(listener: (value: string) => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function notifyCanvasLanguage(value: string) {
  for (const listener of [...listeners]) listener(value)
}
