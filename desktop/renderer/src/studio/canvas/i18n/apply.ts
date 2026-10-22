// 画布语言的应用层：语言存在画布设置里（ui.language），'system' 表示跟随浏览器；
// 语言一变就把语言包拉起来，并同步 <html lang/dir>（ar / fa / ur 是从右往左）。
import { watch } from 'vue'
import { detectLocale, isRtlLocale, normalizeLocale, setLocale } from './index'
import { uiSettings, updateUiSettings } from '@/stores/settings'
import { subscribeCanvasLanguage } from '@/shellLanguage'

let registered = false

export function applyLanguageSetting(setting: string) {
  const locale = setting === 'system' ? detectLocale(navigator.languages) : normalizeLocale(setting) ?? 'zh-CN'
  setLocale(locale)
  document.documentElement.lang = locale
  document.documentElement.dir = isRtlLocale(locale) ? 'rtl' : 'ltr'
}

// 启动时调用一次：把设置里的语言应用上，并在之后跟着设置走。
export function registerLanguage() {
  if (registered) return
  registered = true
  watch(() => uiSettings.value.language, applyLanguageSetting, { immediate: true, flush: 'sync' })
  // 顶栏的中/EN 是直接写画布设置存储的（见 shellLanguage.ts），同页靠这条通知接住；
  // 值不同才回写设置，避免和上面那条 watcher 互相触发。
  subscribeCanvasLanguage((value) => {
    if (uiSettings.value.language !== value) updateUiSettings({ language: value })
  })
  // ACT: 「跟随系统」时浏览器语言变了要跟着换（上游也是监听这个事件）。
  window.addEventListener('languagechange', () => {
    if (uiSettings.value.language === 'system') applyLanguageSetting('system')
  })
}
