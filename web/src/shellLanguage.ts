// 官网与管理后台的中/EN 选择持久化在 localStorage。沿用网页画布时代的设置键
// （只读写其中的 ui.language），老用户已经选过的语言继续生效。
// 存储里可能是 21 种画布语言之一：中文系（zh-CN / zh-TW / 其它 zh-*）走中文，其它一律英文。

export const SHELL_SETTINGS_KEY = 'miaoimg.canvas.settings'

export type ShellLang = 'zh' | 'en'

export function normalizeShellLang(value: unknown): ShellLang | undefined {
  return value === 'zh' || value === 'en' ? value : undefined
}

function baseTag(value: unknown) {
  return String(value ?? '').trim().replaceAll('_', '-').toLowerCase()
}

// 'system' 表示跟随浏览器语言：浏览器是中文系才给中文。
function systemShellLang(): ShellLang {
  const languages = globalThis.navigator?.languages?.length
    ? globalThis.navigator.languages
    : globalThis.navigator?.language ? [globalThis.navigator.language] : []
  for (const language of languages) {
    const tag = baseTag(language)
    if (tag) return tag.split('-')[0] === 'zh' ? 'zh' : 'en'
  }
  // 判不出来时按规则从严：给英文，不给中文。
  return 'en'
}

// 返回空串表示「还没选过语言」，由调用方决定用什么默认值。
export function shellLangForStored(value: unknown): ShellLang | '' {
  const tag = baseTag(value)
  if (!tag) return ''
  if (tag === 'system') return systemShellLang()
  return tag.split('-')[0] === 'zh' ? 'zh' : 'en'
}

export function readStoredLanguage(): string {
  try {
    const raw = globalThis.localStorage?.getItem(SHELL_SETTINGS_KEY)
    if (!raw) return ''
    const ui = JSON.parse(raw)?.ui
    return typeof ui?.language === 'string' ? ui.language : ''
  } catch {
    // 存储损坏或隐私模式下拿不到：当作没选过。
    return ''
  }
}

// 只改 ui.language，其余已保存的设置原样保留。
export function writeStoredLanguage(lang: ShellLang) {
  const language = lang === 'en' ? 'en' : 'zh-CN'
  try {
    let stored: Record<string, unknown> = {}
    const raw = globalThis.localStorage?.getItem(SHELL_SETTINGS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed
    }
    const ui = stored.ui && typeof stored.ui === 'object' && !Array.isArray(stored.ui) ? stored.ui : {}
    globalThis.localStorage?.setItem(SHELL_SETTINGS_KEY, JSON.stringify({ ...stored, ui: { ...ui, language } }))
  } catch {
    // 存不进去不影响当前页面的语言。
  }
}
