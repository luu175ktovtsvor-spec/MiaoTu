// The React shell and Vue canvas share one palette, including before login.
export type AppearanceMode = 'system' | 'light' | 'dark' | 'custom'
export const APPEARANCE_STORAGE_KEY = 'miaoimg.canvas.settings'
export const defaultBackground = '#111114'
const hex = (value: unknown): value is string => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value)
const channels = (color: string) => [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16))
const luminance = (color: string) => channels(color).map(value => {
  const s = value / 255
  return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4
}).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
const mix = (color: string, target: number, amount: number) => '#' + channels(color).map(value => Math.round(value + (target - value) * amount).toString(16).padStart(2, '0')).join('')

export function normalizeAppearance(ui: Record<string, unknown> = {}) {
  return {
    theme: (['system', 'light', 'dark', 'custom'].includes(String(ui.theme)) ? ui.theme : 'system') as AppearanceMode,
    backgroundColor: hex(ui.backgroundColor) ? ui.backgroundColor.toLowerCase() : defaultBackground,
    primaryColor: hex(ui.primaryColor) && !(ui.paletteVersion !== 3 && ui.primaryColor.toLowerCase() === '#d7f7ff') && !(ui.visualVersion !== 2 && ui.primaryColor.toLowerCase() === '#c99b5a') ? ui.primaryColor.toLowerCase() : '#f2f2f2',
  }
}

export function appearancePalette(ui: ReturnType<typeof normalizeAppearance>, systemDark: boolean) {
  const background = ui.theme === 'custom' ? ui.backgroundColor : (ui.theme === 'dark' || (ui.theme === 'system' && systemDark)) ? defaultBackground : '#f4f4f6'
  const light = luminance(background) > .179
  const base = background === defaultBackground
  const surface = base ? '#1e1e24' : mix(background, 255, light ? .64 : .06)
  const accent = light && ui.primaryColor === '#f2f2f2' ? '#25252c' : ui.primaryColor
  const foreground = light ? '24 24 29' : '255 255 255'
  return {
    scheme: light ? 'light' : 'dark',
    tokens: {
      '--color-abyss': background, '--color-canvas': background,
      '--color-surface': surface,
      '--color-elevate': base ? '#25252c' : mix(background, light ? 0 : 255, light ? .035 : .10),
      '--color-overlay': base ? '#2b2b32' : mix(background, 255, light ? .9 : .13),
      '--color-ink': light ? '#18181d' : '#fafafa',
      '--color-body': light ? '#34343c' : '#dedede',
      '--color-muted': light ? '#5b5b66' : '#b2b2b2',
      '--color-faint': light ? '#696975' : '#929292',
      '--color-line': `rgb(${foreground} / .12)`, '--color-line-strong': `rgb(${foreground} / .22)`,
      '--color-hover': `rgb(${foreground} / .06)`, '--color-soft': `rgb(${foreground} / .035)`,
      '--color-grid': `rgb(${foreground} / ${light ? '.16' : '.10'})`,
      '--color-accent': accent, '--color-accent-ink': luminance(accent) > .179 ? '#151515' : '#ffffff',
      '--color-brass': accent, '--color-brass-strong': accent, '--color-brass-soft': `color-mix(in srgb, ${accent} 12%, transparent)`,
    },
  }
}

let enabled = false
let current = normalizeAppearance()
let media: MediaQueryList | undefined
function apply() {
  if (!enabled) return
  const { scheme, tokens } = appearancePalette(current, media?.matches ?? true)
  const root = document.documentElement
  root.dataset.clientAppearance = current.theme
  root.dataset.clientScheme = scheme
  root.style.colorScheme = scheme
  for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value)
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', tokens['--color-canvas'])
}
export function setClientAppearance(ui: Record<string, unknown>) { current = normalizeAppearance(ui); apply() }
function readStoredAppearance() {
  try { setClientAppearance(JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) || '{}').ui || {}) }
  catch { setClientAppearance({}) }
}
export function initializeClientAppearance(active: boolean) {
  enabled = active
  if (!enabled) return
  media = window.matchMedia('(prefers-color-scheme: dark)')
  readStoredAppearance()
  media.addEventListener('change', apply)
  const storage = (event: StorageEvent) => { if (event.key === APPEARANCE_STORAGE_KEY || event.key === null) readStoredAppearance() }
  window.addEventListener('storage', storage)
  import.meta.hot?.dispose(() => { media?.removeEventListener('change', apply); window.removeEventListener('storage', storage) })
}
