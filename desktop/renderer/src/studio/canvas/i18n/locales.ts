// 21 种界面语言的清单与归一化规则。不含任何词典，画布（index.ts）和 React 外壳（shellLanguage.ts）共用，
// 外壳不必为了认语言代码把 323KB 的 en.json 拉进首屏包。
export type Locale =
  | 'zh-CN' | 'zh-TW' | 'en' | 'ja' | 'ru' | 'vi' | 'th' | 'ko' | 'hi'
  | 'id' | 'ms' | 'fil' | 'bn' | 'ur' | 'ta' | 'te' | 'mr' | 'pa' | 'ar' | 'fa' | 'tr'

// ACT: 只有中英双语时本地存的是 'zh'，读设置时必须继续认这个旧值，
// 否则老用户的语言设置会被判为无效而掉回默认。
export type LocaleSetting = Locale | 'zh'

// 名称用各自语言的原生写法，语言选择器直接显示。
export const supportedLocales: { code: Locale; name: string }[] = [
  { code: 'zh-CN', name: '简体中文' },
  { code: 'zh-TW', name: '繁體中文' },
  { code: 'en', name: 'English' },
  { code: 'ja', name: '日本語' },
  { code: 'ru', name: 'Русский' },
  { code: 'vi', name: 'Tiếng Việt' },
  { code: 'th', name: 'ไทย' },
  { code: 'ko', name: '한국어' },
  { code: 'hi', name: 'हिन्दी' },
  { code: 'id', name: 'Bahasa Indonesia' },
  { code: 'ms', name: 'Bahasa Melayu' },
  { code: 'fil', name: 'Filipino' },
  { code: 'bn', name: 'বাংলা' },
  { code: 'ur', name: 'اردو' },
  { code: 'ta', name: 'தமிழ்' },
  { code: 'te', name: 'తెలుగు' },
  { code: 'mr', name: 'मराठी' },
  { code: 'pa', name: 'ਪੰਜਾਬੀ' },
  { code: 'ar', name: 'العربية' },
  { code: 'fa', name: 'فارسی' },
  { code: 'tr', name: 'Türkçe' },
]

function maximizeScript(tag: string): string | undefined {
  try { return new Intl.Locale(tag).maximize().script } catch { return undefined }
}

export function normalizeLocale(value: unknown): Locale | undefined {
  if (typeof value !== 'string') return undefined
  const tag = value.trim().replaceAll('_', '-')
  if (!tag) return undefined
  const lower = tag.toLowerCase()
  const base = lower.split('-')[0]!
  if (base === 'zh') {
    // 简繁之分看文字体系；老环境没有 Intl.Locale 时按地区码兜底。
    const script = maximizeScript(tag) ?? (/hant|-(tw|hk|mo)($|-)/.test(lower) ? 'Hant' : 'Hans')
    return script === 'Hant' ? 'zh-TW' : 'zh-CN'
  }
  // 上游的别名：tl → fil、in → id。
  const code = base === 'tl' ? 'fil' : base === 'in' ? 'id' : base
  const supported = supportedLocales.find(item => item.code === code)
  if (!supported) return undefined
  // ACT: 每种语言只提供一种文字体系；pa-Arab（旁遮普语阿拉伯字母）等不能误用 Gurmukhi 译文。
  const script = maximizeScript(tag)
  const own = maximizeScript(supported.code)
  return script && own && script !== own ? undefined : supported.code
}

export function detectLocale(languages: readonly string[] = []): Locale {
  for (const language of languages) {
    const locale = normalizeLocale(language)
    if (locale) return locale
  }
  return languages.length ? 'en' : 'zh-CN'
}

// ACT: 这三种语言的界面要从右往左排；其它语言都是从左到右。
export function isRtlLocale(locale: LocaleSetting): boolean {
  return locale === 'ar' || locale === 'fa' || locale === 'ur'
}
