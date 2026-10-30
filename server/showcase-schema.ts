export type Film = {
  id: string; title: string[]; category: string[]; theme: string; video: string; poster: string
  hasPrompt: boolean; summary?: string[]; model?: string; sourceUrl?: string; creator?: string
  caseUrl?: string; sourceId?: string; prompt?: string; translations?: { 'zh-Hans'?: string; en?: string }
}
export type FilmPlayback = { fallback?: string; adaptive?: { master: string; manifest: string; low: string } }
export type ShowcaseCatalog = { schema: 1; version: string; reviewedAt?: string; sourceRevision?: string; themes: { id: string; category: string[] }[]; films: Film[] }
export type FilmDetail = { schema: 1; version: string; id: string; prompt: string; translations: { 'zh-Hans'?: string; en?: string }; playback: FilmPlayback }

export const VERSION = /^[a-f0-9]{64}$/
export const ID = /^[A-Za-z0-9_-]{1,120}$/
export const PREFIX = '/library-content/showcase'
export function unavailable() { return Object.assign(new Error('精选内容暂时无法读取，请重试'), { status: 503 }) }
function asset(value: unknown) {
  if (typeof value !== 'string' || value.includes('\\') || /[\u0000-\u001f]/.test(value)) return false
  const url = new URL(value, 'https://content.invalid')
  return value.startsWith('/') && !value.startsWith('//') && url.origin === 'https://content.invalid'
    && /^\/(showcase|landing)\//.test(url.pathname) && !/%2f|%5c|%2e/i.test(url.pathname)
}
export function validateShowcase(value: any): ShowcaseCatalog {
  if (value?.schema !== 1 || !VERSION.test(value.version) || !Array.isArray(value.films) || value.films.length > 5000 || !Array.isArray(value.themes)) throw unavailable()
  const ids = new Set<string>()
  for (const film of value.films) {
    if (!ID.test(film?.id) || ids.has(film.id) || !Array.isArray(film.title) || !Array.isArray(film.category)
      || !film.title.every(x => typeof x === 'string') || !film.category.every(x => typeof x === 'string')
      || typeof film.theme !== 'string' || typeof film.hasPrompt !== 'boolean' || !asset(film.video) || !asset(film.poster)) throw unavailable()
    ids.add(film.id)
  }
  if (!value.themes.every(x => ID.test(x?.id) && Array.isArray(x.category) && x.category.every(v => typeof v === 'string'))) throw unavailable()
  return value
}
export function validateDetail(value: any, version: string, id: string): FilmDetail {
  if (value?.schema !== 1 || value.version !== version || value.id !== id || typeof value.prompt !== 'string'
    || !value.translations || typeof value.translations !== 'object' || Array.isArray(value.translations) || !value.playback) throw unavailable()
  if (Object.entries(value.translations).some(([key, text]) => !['zh-Hans', 'en'].includes(key) || typeof text !== 'string')) throw unavailable()
  if (value.playback.fallback && !asset(value.playback.fallback)) throw unavailable()
  const adaptive = value.playback.adaptive
  if (adaptive && (!asset(adaptive.master) || typeof adaptive.manifest !== 'string' || typeof adaptive.low !== 'string')) throw unavailable()
  return value
}
