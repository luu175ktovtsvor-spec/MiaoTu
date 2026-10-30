// Self-contained so the same function also runs in the generated HTML bootstrap.
export function initialLandingLanguage() {
  try {
    const requested = new URLSearchParams(globalThis.location?.search || '').get('lang')
    if (requested === 'zh' || requested === 'en') return requested
    const raw = globalThis.localStorage?.getItem('miaoimg.canvas.settings')
    const value = raw ? JSON.parse(raw)?.ui?.language : ''
    const tag = typeof value === 'string' ? value.trim().replaceAll('_', '-').toLowerCase() : ''
    if (!tag) return 'zh'
    if (tag === 'system') {
      const languages = globalThis.navigator?.languages?.length ? globalThis.navigator.languages : [globalThis.navigator?.language]
      const first = languages.find(language => String(language || '').trim())
      return String(first || '').trim().replaceAll('_', '-').toLowerCase().split('-')[0] === 'zh' ? 'zh' : 'en'
    }
    return tag.split('-')[0] === 'zh' ? 'zh' : 'en'
  } catch { return 'zh' }
}
