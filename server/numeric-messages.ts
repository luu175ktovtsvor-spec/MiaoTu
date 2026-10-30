// 仅还原应用词典里的简单数字参数，不匹配任意文本、路径或诊断。
// 服务端用于响应本地化，客户端用于识别已翻译的安全参数提示。
const cache = new Map<string, { pattern: RegExp; names: string[] } | null>()
export function numericMessageValues(template: string, text: string): Record<string, string | number> | undefined {
  let compiled = cache.get(template)
  if (!cache.has(template)) {
    const names: string[] = []
    let offset = 0, pattern = '^', supported = true
    for (const match of template.matchAll(/\{(\w+)\}/g)) {
      const literal = template.slice(offset, match.index)
      if (/[{}]/.test(literal)) { supported = false; break }
      pattern += literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // 720p / 2K / 16:9 / 720p、1080p；长度有界，绝不接受任意字符串。
      pattern += '([0-9]{1,9}(?:[.][0-9]{1,6})?(?:[pPkK]|:[0-9]{1,5})?(?:、[0-9]{1,9}(?:[.][0-9]{1,6})?(?:[pPkK]|:[0-9]{1,5})?){0,15})'
      names.push(match[1])
      offset = match.index + match[0].length
    }
    const tail = template.slice(offset)
    if (/[{}]/.test(tail)) supported = false // ICU select/plural 交给原本的格式化，不猜解析。
    pattern += tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'
    compiled = supported && names.length ? { pattern: new RegExp(pattern), names } : null
    if (cache.size >= 4000) cache.delete(cache.keys().next().value!)
    cache.set(template, compiled)
  }
  if (!compiled) return undefined
  const matched = compiled.pattern.exec(text)
  if (!matched) return undefined
  const values: Record<string, string | number> = {}
  for (let index = 0; index < compiled.names.length; index += 1) {
    const name = compiled.names[index], token = matched[index + 1]
    const value = /^[0-9]+(?:[.][0-9]+)?$/.test(token) ? Number(token) : token
    if (Object.hasOwn(values, name) && values[name] !== value) return undefined
    values[name] = value
  }
  return values
}
