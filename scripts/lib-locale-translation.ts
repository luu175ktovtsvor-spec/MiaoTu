// 语言包译文校验：占位符 / 品牌 / 汉字残留。check-locales.ts 与 merge-locale-translations.ts 共用。
import { parse, TYPE } from '@formatjs/icu-messageformat-parser'

export const CJK = /[\u3400-\u9fff\uf900-\ufaff]/
export const CJK_G = /[\u3400-\u9fff\uf900-\ufaff]/g

export function argNames(message: string): Set<string> | null {
  const names = new Set<string>()
  try {
    const walkNodes = (nodes: any[]) => {
      for (const node of nodes) {
        if (node.type === TYPE.argument || node.type === TYPE.number || node.type === TYPE.date || node.type === TYPE.time) names.add(node.value)
        else if (node.type === TYPE.select || node.type === TYPE.plural) {
          names.add(node.value)
          for (const option of Object.values(node.options) as any[]) walkNodes(option.value)
        }
      }
    }
    walkNodes(parse(message, { ignoreTag: true }))
    return names
  } catch {
    return null
  }
}

export function placeholdersOf(message: string): Set<string> {
  return argNames(message) ?? new Set([...message.matchAll(/\{\s*(\w+)/g)].map(m => m[1]))
}

const KEEP_TERMS = ['Seedance', 'Seedream', 'GPT Image', 'Grok', 'MiniMax', '豆包', 'Dola']
const RESIDUE_WHITELIST = ['豆包']

export function checkTranslation(locale: string, key: string, value: string, source: string, scope: string, allowExtra = false) {
  const problems: string[] = []
  const src = placeholdersOf(source)
  const dst = placeholdersOf(value)
  if (src.size && argNames(source) && !argNames(value)) problems.push('译文的 ICU 消息格式无效')
  const missing = [...src].filter(name => !dst.has(name))
  const extra = [...dst].filter(name => !src.has(name))
  if (missing.length && !(locale === 'zh-CN' && scope === 'shell')) problems.push(`丢失占位符 ${missing.map(n => `{${n}}`).join('')}`)
  if (extra.length && !allowExtra) problems.push(`多出占位符 ${extra.map(n => `{${n}}`).join('')}`)
  if (!value.trim() && source.trim()) problems.push('译文为空')
  const isZh = locale === 'zh-CN' || locale === 'zh-TW'
  if (!isZh) {
    if (source.includes('妙图') || key.includes('妙图')) {
      if (!value.includes('MiaoImg')) problems.push('原文含「妙图」，译文应写 MiaoImg')
    }
    if (/妙图|妙圖/.test(value)) problems.push('译文含中文品牌名，应写 MiaoImg')
    if (locale !== 'ja') {
      let residue = value
      for (const term of RESIDUE_WHITELIST) residue = residue.replaceAll(term, '')
      const han = residue.match(CJK_G)
      if (han) problems.push(`残留汉字「${han.slice(0, 6).join('')}」`)
    }
  }
  if (locale === 'zh-TW' && /妙图/.test(value)) problems.push('繁体译文含简体「妙图」')
  if (locale === 'zh-TW' && (source.includes('妙图')) && !value.includes('妙圖')) problems.push('原文含「妙图」，繁体应写「妙圖」')
  for (const term of KEEP_TERMS) {
    // 豆包在 en 里已统一写 Doubao（英文品牌名），其它语言也接受 Doubao
    const accepted = term === '豆包' ? ['豆包', 'Doubao'] : [term]
    if (source.includes(term) && !accepted.some(item => value.includes(item))) problems.push(`品牌/模型名 ${term} 未原样保留`)
  }
  return problems.map(problem => `${scope}/${locale}: ${JSON.stringify(key).slice(0, 50)} → ${problem}`)
}
