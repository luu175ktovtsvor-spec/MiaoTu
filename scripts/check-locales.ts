#!/usr/bin/env node
// 严格检查全部界面语言包（画布 + React 外壳），不通过时退出码非 0。
//
// 用法：
//   node scripts/check-locales.ts                          # 全部 21 种语言都必须完整
//   node scripts/check-locales.ts --ready=zh-CN,zh-TW,en   # 只要求这些语言完整，其余语言只报缺口
//   node scripts/check-locales.ts --list=ja                # 额外把某语言缺的 key 全部列出来
//   node scripts/check-locales.ts --server                 # 兼容旧调用；默认也检查服务端文案和原生菜单
//   node scripts/check-locales.ts --ui-only                # 只验画布与外壳；不据此宣称服务端文案完整
//
// 检查项：
//   画布  扫描 desktop/renderer/src（外壳目录除外的 .vue/.ts）里所有 translate('…') / translate("…") /
//         msg`…` / t`…` 的中文字面量，必须在每种语言的 canvas/i18n/<locale>.json 里有词条；
//         .vue 模板里的静态中文文本、静态属性（title="中文"）视为「明显未走翻译」，直接不通过。
//         模板表达式里不在 translate 里的中文字符串字面量只作为提示（可能是数据值，不是界面文案）。
//         同一行写 i18n-ignore 可豁免该行（给 Agent 看的说明、日志、数据值用，需要在代码里说明原因）。
//   外壳  扫描 desktop/renderer/src（canvas 目录除外）的 t('key')、L('key')、studioText('key')、shellT('key')、
//         dictText(lang, 'key')，key 必须在 locales/shell/en.json 里；每种语言必须覆盖 en.json 的全部 key
//         （zh-CN 只需 id 形式的 key，中文原文本身就是简体译文）。
//   译文  每条译文必须保留原文的占位符（{0}、{name}、ICU plural/select 的参数名）；
//         原文含 妙图 → 译文必须是 MiaoImg（zh-TW 为 妙圖）；含 Seedance/Seedream/GPT Image/Grok/MiniMax/豆包/Dola
//         → 译文原样保留；非中文语言（ja 的汉字除外）译文里不得残留汉字（白名单：豆包）；
//         zh-TW 译文不得出现简体「妙图」。
//   外壳硬编码  界面组件里没走翻译的中文字面量（提示，不影响退出码；列出前 40 条）。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkTranslation, CJK, CJK_G } from './lib-locale-translation.ts'
import { supportedLocales } from '../desktop/renderer/src/studio/canvas/i18n/locales.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'desktop/renderer/src')
const CANVAS_DIR = join(SRC, 'studio/canvas')
const CANVAS_I18N = join(CANVAS_DIR, 'i18n')
const SHELL_DIR = join(SRC, 'locales/shell')
const SERVER_DIR = join(ROOT, 'server/locales')

const LOCALES = supportedLocales.map(item => item.code)
const canvasFile = (locale: string) => locale === 'zh-TW' ? 'zhTw.json' : `${locale}.json`

const args = new Map(process.argv.slice(2).map(arg => {
  const [name, value = ''] = arg.replace(/^--/, '').split('=')
  return [name, value] as const
}))
const READY = args.has('ready') ? new Set(args.get('ready')!.split(',').filter(Boolean)) : new Set(LOCALES)
const LIST = new Set((args.get('list') ?? '').split(',').filter(Boolean))
for (const locale of new Set([...READY, ...LIST])) {
  if (!LOCALES.some(code => code === locale)) { console.error(`不支持的语言代码：${locale}`); process.exit(2) }
}

const fail: string[] = []
const warn: string[] = []
const readJson = (path: string): Record<string, string> => JSON.parse(readFileSync(path, 'utf8'))

// ---------------------------------------------------------------------------------------------
// 源码扫描
// ---------------------------------------------------------------------------------------------
function walk(dir: string, filter: (path: string) => boolean, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, filter, out)
    else if (filter(path)) out.push(path)
  }
  return out
}

function cook(raw: string) {
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r?\n|.)/gs, (_all, esc: string) => {
    if (esc[0] === 'u') return String.fromCodePoint(parseInt(esc.replace(/^u\{?|\}$/g, ''), 16))
    if (esc[0] === 'x') return String.fromCharCode(parseInt(esc.slice(1), 16))
    if (esc === 'n') return '\n'
    if (esc === 't') return '\t'
    if (esc === 'r') return '\r'
    if (esc === '\n' || esc === '\r\n') return ''
    return esc
  })
}

// 把注释替换成同长度空白（保留行号与偏移）。字符串和模板字符串里的 // 不算注释。
function blankComments(src: string) {
  const out = src.split('')
  const braces: number[] = [] // 模板字符串 ${ } 嵌套：记录进入时的花括号深度
  let depth = 0
  let i = 0
  const n = src.length
  const blank = (from: number, to: number) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ' }
  function skipTemplate(start: number) {
    let k = start + 1
    while (k < n) {
      const c = src[k]
      if (c === '\\') { k += 2; continue }
      if (c === '`') return k + 1
      if (c === '$' && src[k + 1] === '{') { braces.push(depth); depth += 1; return -k - 2 } // 回到代码态
      k += 1
    }
    return n
  }
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') { const end = src.indexOf('\n', i); const to = end < 0 ? n : end; blank(i, to); i = to; continue }
    if (c === '/' && d === '*') { const end = src.indexOf('*/', i + 2); const to = end < 0 ? n : end + 2; blank(i, to); i = to; continue }
    if (c === '"' || c === "'") {
      let k = i + 1
      while (k < n && src[k] !== c && src[k] !== '\n') k += src[k] === '\\' ? 2 : 1
      i = k + 1
      continue
    }
    if (c === '`') {
      const r = skipTemplate(i)
      if (r < 0) { i = -r } else i = r
      continue
    }
    if (c === '{') depth += 1
    if (c === '}') {
      depth -= 1
      if (braces.length && braces[braces.length - 1] === depth) {
        braces.pop()
        // 回到模板字符串继续
        let k = i + 1
        while (k < n) {
          const ch = src[k]
          if (ch === '\\') { k += 2; continue }
          if (ch === '`') { k += 1; break }
          if (ch === '$' && src[k + 1] === '{') { braces.push(depth); depth += 1; k += 2; break }
          k += 1
        }
        i = k
        continue
      }
    }
    i += 1
  }
  return out.join('')
}

const escapeMessageText = (value: string) => value.replaceAll("'", "''").replaceAll('{', "'{'").replaceAll('}', "'}'")

interface Found { key: string; offset: number }

// 从 start 开始读一个调用的第一个参数（到顶层逗号或右括号为止），收集其中全部字符串字面量。
function firstArgument(src: string, start: number, argIndex = 0) {
  const literals: Found[] = []
  let depth = 0
  let index = 0
  let dynamic = false
  let i = start
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === '"' || c === "'") {
      let k = i + 1
      while (k < n && src[k] !== c && src[k] !== '\n') k += src[k] === '\\' ? 2 : 1
      if (index === argIndex && depth === 0 && !/(?:===?|!==?)\s*$/.test(src.slice(Math.max(0, i - 6), i))) literals.push({ key: cook(src.slice(i + 1, k)), offset: i })
      i = k + 1
      continue
    }
    if (c === '`') {
      let k = i + 1
      let hasExpr = false
      while (k < n && src[k] !== '`') {
        if (src[k] === '\\') { k += 2; continue }
        if (src[k] === '$' && src[k + 1] === '{') {
          hasExpr = true
          let level = 1
          k += 2
          while (k < n && level) { if (src[k] === '{') level += 1; else if (src[k] === '}') level -= 1; k += 1 }
          continue
        }
        k += 1
      }
      if (index === argIndex && depth === 0) {
        if (hasExpr) dynamic = true
        else literals.push({ key: cook(src.slice(i + 1, k)), offset: i })
      }
      i = k + 1
      continue
    }
    if (c === '(' || c === '[' || c === '{') depth += 1
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break
      depth -= 1
    } else if (c === ',' && depth === 0) {
      index += 1
      if (index > argIndex) break
    }
    i += 1
  }
  return { literals, dynamic }
}

// 标签模板 t`…${x}…` / msg`…`：静态部分按 ICU 转义，表达式按序号变成 {0}{1}。
function taggedTemplates(src: string) {
  const found: Found[] = []
  const re = /(?<![\w$.])(?:t|msg)`/g
  let match: RegExpExecArray | null
  while ((match = re.exec(src))) {
    let k = match.index + match[0].length
    const parts: string[] = []
    let current = ''
    let count = 0
    while (k < src.length && src[k] !== '`') {
      if (src[k] === '\\') { current += src.slice(k, k + 2); k += 2; continue }
      if (src[k] === '$' && src[k + 1] === '{') {
        parts.push(cook(current)); current = ''
        let level = 1
        k += 2
        while (k < src.length && level) { if (src[k] === '{') level += 1; else if (src[k] === '}') level -= 1; k += 1 }
        count += 1
        continue
      }
      current += src[k]; k += 1
    }
    parts.push(cook(current))
    const key = count
      ? parts.map((part, index) => escapeMessageText(part) + (index < count ? `{${index}}` : '')).join('')
      : parts[0]
    found.push({ key, offset: match.index })
  }
  return found
}

function lineOf(src: string, offset: number) { return src.slice(0, offset).split('\n').length }

interface Usage { key: string; file: string; line: number }

function scanCalls(src: string, file: string, names: RegExp, argIndex: (name: string) => number): { usages: Usage[]; dynamic: number } {
  const usages: Usage[] = []
  let dynamic = 0
  const re = new RegExp(`(?<![\\w$.])(${names.source})\\(`, 'g')
  let match: RegExpExecArray | null
  const lines = src.split('\n')
  while ((match = re.exec(src))) {
    const { literals, dynamic: isDynamic } = firstArgument(src, match.index + match[0].length, argIndex(match[1]))
    if (isDynamic) dynamic += 1
    for (const literal of literals) {
      const line = lineOf(src, literal.offset)
      if (/i18n-ignore/.test(lines[line - 1] ?? '')) continue
      usages.push({ key: literal.key, file, line })
    }
  }
  return { usages, dynamic }
}

// ---------------------------------------------------------------------------------------------
// 画布：translate()/msg/t 的 key，加上 .vue 模板里的静态中文
// ---------------------------------------------------------------------------------------------
function vueSections(source: string) {
  const template = /<template[^>]*>/.exec(source)
  const templateStart = template ? template.index + template[0].length : -1
  const templateEnd = source.lastIndexOf('</template>')
  const script: [number, number][] = []
  const re = /<script[^>]*>([\s\S]*?)<\/script>/g
  let match: RegExpExecArray | null
  while ((match = re.exec(source))) script.push([match.index + match[0].indexOf('>') + 1, match.index + match[0].length - 9])
  return { templateStart, templateEnd, script }
}

const TAG = /<\/?[A-Za-z][\w:.-]*(?:\s+(?:"[^"]*"|'[^']*'|[^'">])*?)?\/?>/g

function blankRange(text: string, from: number, to: number) {
  return text.slice(0, from) + text.slice(from, to).replace(/[^\n]/g, ' ') + text.slice(to)
}

function scanVueTemplate(source: string, file: string, translateRanges: [number, number][]) {
  const { templateStart, templateEnd } = vueSections(source)
  const violations: Usage[] = []
  const hints: Usage[] = []
  const extra: Usage[] = []
  if (templateStart < 0 || templateEnd < templateStart) return { violations, hints, extra }
  const lines = source.split('\n')
  let body = source.slice(0, templateStart).replace(/[^\n]/g, ' ') + source.slice(templateStart, templateEnd) + source.slice(templateEnd).replace(/[^\n]/g, ' ')
  // HTML 注释
  body = body.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '))
  const push = (list: Usage[], offset: number, text: string) => {
    const line = lineOf(source, offset)
    if (/i18n-ignore/.test(lines[line - 1] ?? '')) return
    list.push({ key: text.trim().slice(0, 60), file, line })
  }
  // 1) 标签内：静态属性与表达式
  for (const tag of body.matchAll(TAG)) {
    const attrRe = /([^\s=/<>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
    const inner = tag[0]
    const startOfAttrs = inner.search(/\s/)
    if (startOfAttrs < 0) continue
    attrRe.lastIndex = startOfAttrs
    let attr: RegExpExecArray | null
    while ((attr = attrRe.exec(inner))) {
      const name = attr[1]
      const value = attr[2] ?? attr[3] ?? attr[4] ?? ''
      if (!CJK.test(value.replaceAll('豆包', ''))) continue
      const valueOffset = tag.index + attr.index + attr[0].length - value.length - (attr[2] !== undefined || attr[3] !== undefined ? 1 : 0)
      const dynamicAttr = /^(:|@|v-|#)/.test(name)
      // promptInput 组件内部会 translate(props.placeholder)，这里传的是词条 key：当作词条使用，由 en.json 覆盖检查
      if (!dynamicAttr && name === 'placeholder' && /^<promptInput\b/i.test(inner)) { extra.push({ key: value, file, line: lineOf(source, valueOffset) }); continue }
      if (!dynamicAttr) { push(violations, valueOffset, `${name}="${value}"`); continue }
      for (const literal of firstExpressionLiterals(value)) {
        if (CJK.test(literal.key) && !inRanges(valueOffset + literal.offset, translateRanges)) push(hints, valueOffset + literal.offset, literal.key)
      }
    }
  }
  // 2) 标签之间的文本
  let text = body.replace(TAG, m => m.replace(/[^\n]/g, ' '))
  // 插值 {{ … }}：里面的中文字符串字面量不在 translate() 里才提示
  for (const interpolation of text.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    const offset = interpolation.index + 2
    for (const literal of firstExpressionLiterals(interpolation[1])) {
      if (CJK.test(literal.key) && !inRanges(offset + literal.offset, translateRanges)) push(hints, offset + literal.offset, literal.key)
    }
  }
  text = text.replace(/\{\{[\s\S]*?\}\}/g, m => m.replace(/[^\n]/g, ' '))
  for (const m of text.matchAll(/[^\n]*[\u3400-\u9fff\uf900-\ufaff][^\n]*/g)) {
    // 只剩品牌名（豆包）的文本不用翻译
    if (CJK.test(m[0].replaceAll('豆包', ''))) push(violations, m.index, m[0])
  }
  return { violations, hints, extra }
}

function firstExpressionLiterals(expression: string) {
  const out: Found[] = []
  let i = 0
  while (i < expression.length) {
    const c = expression[i]
    if (c === '"' || c === "'" || c === '`') {
      let k = i + 1
      while (k < expression.length && expression[k] !== c) {
        if (c === '`' && expression[k] === '$' && expression[k + 1] === '{') {
          let level = 1
          k += 2
          while (k < expression.length && level) { if (expression[k] === '{') level += 1; else if (expression[k] === '}') level -= 1; k += 1 }
          continue
        }
        k += expression[k] === '\\' ? 2 : 1
      }
      // t`…` / msg`…` 标签模板本身就是词条，不算裸中文；${…} 里的内容不是这个字面量自己的文字
      const tagged = c === '`' && /(?:^|[^\w$.])(?:t|msg)$/.test(expression.slice(Math.max(0, i - 4), i))
      if (!tagged) {
        let literal = expression.slice(i + 1, k)
        if (c === '`') literal = stripInterpolations(literal)
        out.push({ key: literal, offset: i })
      }
      i = k + 1
    } else i += 1
  }
  return out
}

function stripInterpolations(text: string) {
  let out = ''
  let i = 0
  while (i < text.length) {
    if (text[i] === '$' && text[i + 1] === '{') {
      let level = 1
      i += 2
      while (i < text.length && level) { if (text[i] === '{') level += 1; else if (text[i] === '}') level -= 1; i += 1 }
      out += ' '
    } else { out += text[i]; i += 1 }
  }
  return out
}

function inRanges(offset: number, ranges: [number, number][]) { return ranges.some(([from, to]) => offset >= from && offset <= to) }

function scanCanvas() {
  const files = walk(SRC, path => /\.(vue|ts|tsx)$/.test(path)
    && !path.startsWith(SHELL_DIR) && !path.startsWith(CANVAS_I18N))
  const usages: Usage[] = []
  const templateViolations: Usage[] = []
  const hints: Usage[] = []
  let dynamic = 0
  for (const path of files) {
    const rel = relative(ROOT, path)
    const source = readFileSync(path, 'utf8')
    const isVue = path.endsWith('.vue')
    // 只有走了 canvas 词典的文件才会调 translate/msg/t；外壳目录里的 t() 是外壳词典，由 scanShell 管。
    const isShellFile = !path.startsWith(CANVAS_DIR) && /\.tsx?$/.test(path) && !/@miaoimg\/i18n|from ['"]@\/studio\/canvas\/i18n|canvas\/i18n/.test(source)
    if (isShellFile) continue
    let scripts: string
    const ranges: [number, number][] = []
    if (isVue) {
      const { script } = vueSections(source)
      scripts = source.replace(/[^\n]/g, ' ')
      let combined = scripts
      for (const [from, to] of script) combined = combined.slice(0, from) + blankComments(source.slice(from, to)) + combined.slice(to)
      // 模板部分也要扫 translate(…)：直接用原文（模板里没有 JS 注释）
      const { templateStart, templateEnd } = vueSections(source)
      if (templateStart >= 0 && templateEnd > templateStart) combined = combined.slice(0, templateStart) + source.slice(templateStart, templateEnd).replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' ')) + combined.slice(templateEnd)
      scripts = combined
    } else scripts = blankComments(source)
    const lines = source.split('\n')
    const translateOnly = scanCalls(scripts, rel, /translate/, () => 0)
    dynamic += translateOnly.dynamic
    for (const usage of translateOnly.usages) usages.push(usage)
    for (const tagged of taggedTemplates(scripts)) {
      const line = lineOf(scripts, tagged.offset)
      if (/i18n-ignore/.test(lines[line - 1] ?? '')) continue
      usages.push({ key: tagged.key, file: rel, line })
    }
    if (isVue) {
      // translate() 参数范围：这些范围内的字面量不再当作模板里的裸中文
      const re = /(?<![\w$.])translate\(/g
      let m: RegExpExecArray | null
      while ((m = re.exec(scripts))) {
        let level = 1
        let k = m.index + m[0].length
        while (k < scripts.length && level) { if (scripts[k] === '(') level += 1; else if (scripts[k] === ')') level -= 1; k += 1 }
        ranges.push([m.index, k])
      }
      const { violations, hints: vueHints, extra } = scanVueTemplate(source, rel, ranges)
      usages.push(...extra)
      templateViolations.push(...violations)
      hints.push(...vueHints)
    }
  }
  return { usages: usages.filter(item => CJK.test(item.key)), dynamic, templateViolations, hints, fileCount: files.length }
}

// ---------------------------------------------------------------------------------------------
// 外壳
// ---------------------------------------------------------------------------------------------
const SHELL_NAMES = /t|L|studioText|shellT|dictText|shellMessage/

function scanShell() {
  const files = walk(SRC, path => /\.(ts|tsx)$/.test(path)
    && !path.startsWith(CANVAS_DIR) && !path.startsWith(SHELL_DIR))
  const usages: Usage[] = []
  const hardcoded: Usage[] = []
  let dynamic = 0
  for (const path of files) {
    const rel = relative(ROOT, path)
    const source = readFileSync(path, 'utf8')
    const code = blankComments(source)
    const lines = source.split('\n')
    const scan = scanCalls(code, rel, SHELL_NAMES, name => (name === 'dictText' || name === 'shellMessage' ? 1 : 0))
    dynamic += scan.dynamic
    const masked = [...code]
    for (const usage of scan.usages) usages.push(usage)
    // 硬编码中文：先把所有翻译调用的参数抹掉，剩下的中文字符串/JSX 文本就是没走翻译的
    const re = new RegExp(`(?<![\\w$.])(${SHELL_NAMES.source})\\(`, 'g')
    let match: RegExpExecArray | null
    while ((match = re.exec(code))) {
      let level = 1
      let k = match.index + match[0].length
      while (k < code.length && level) { if (code[k] === '(') level += 1; else if (code[k] === ')') level -= 1; k += 1 }
      for (let p = match.index; p < k; p++) if (masked[p] !== '\n') masked[p] = ' '
    }
    const text = masked.join('')
    text.split('\n').forEach((line, index) => {
      if (!CJK.test(line) || /i18n-ignore/.test(lines[index])) return
      hardcoded.push({ key: line.trim().slice(0, 90), file: rel, line: index + 1 })
    })
  }
  return { usages, dynamic, hardcoded, fileCount: files.length }
}

// ---------------------------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------------------------
const report: Record<string, { canvasMissing: number; shellMissing: number; canvasTotal: number; shellTotal: number; issues: number }> = {}
const missingLists: Record<string, { canvas: string[]; shell: string[] }> = {}

const canvasEn = readJson(join(CANVAS_I18N, 'en.json'))
const scannedCanvas = scanCanvas()
const canvasUsed = new Set(scannedCanvas.usages.map(item => item.key))
const canvasRequired = [...new Set([...Object.keys(canvasEn).filter(key => CJK.test(key)), ...canvasUsed])]

// en 必须覆盖代码里出现的全部 key
const canvasNotInEn = scannedCanvas.usages.filter(item => !(item.key in canvasEn))
const shellEn = readJson(join(SHELL_DIR, 'en.json'))
const shellZh = readJson(join(SHELL_DIR, 'zh-CN.json'))
const scannedShell = scanShell()

const shellRequired = Object.keys(shellEn)
const isIdKey = (key: string) => /^[a-z][\w]*(?:\.[\w-]+)+$/i.test(key)
const shellIdKeys = shellRequired.filter(isIdKey)
const shellNotInEn = scannedShell.usages.filter(item => !(item.key in shellEn) && !(CJK.test(item.key) === false && item.key in shellZh))

console.log(`画布：扫描 ${scannedCanvas.fileCount} 个文件，${canvasUsed.size} 个中文 key（${scannedCanvas.dynamic} 处动态参数无法静态检查），en.json ${Object.keys(canvasEn).length} 条`)
console.log(`外壳：扫描 ${scannedShell.fileCount} 个文件，${new Set(scannedShell.usages.map(u => u.key)).size} 个 key（${scannedShell.dynamic} 处动态参数），en.json ${shellRequired.length} 条（id 形式 ${shellIdKeys.length}）\n`)

if (canvasNotInEn.length) {
  fail.push(`画布代码里 ${new Set(canvasNotInEn.map(u => u.key)).size} 个 key 不在 en.json：\n${canvasNotInEn.slice(0, 15).map(u => `    ${u.file}:${u.line} ${JSON.stringify(u.key).slice(0, 70)}`).join('\n')}`)
}
if (scannedCanvas.templateViolations.length) {
  fail.push(`.vue 模板里 ${scannedCanvas.templateViolations.length} 处静态中文没走翻译：\n${scannedCanvas.templateViolations.slice(0, 20).map(u => `    ${u.file}:${u.line} ${u.key}`).join('\n')}`)
}
if (scannedCanvas.hints.length) {
  warn.push(`.vue 模板表达式里有 ${scannedCanvas.hints.length} 处不在 translate() 里的中文字符串字面量（可能是数据值，需人工确认；加 i18n-ignore 可豁免）：\n${scannedCanvas.hints.slice(0, 12).map(u => `    ${u.file}:${u.line} ${u.key}`).join('\n')}`)
}
if (shellNotInEn.length) {
  fail.push(`外壳代码里 ${new Set(shellNotInEn.map(u => u.key)).size} 个 key 不在 locales/shell/en.json：\n${shellNotInEn.slice(0, 20).map(u => `    ${u.file}:${u.line} ${JSON.stringify(u.key).slice(0, 70)}`).join('\n')}`)
}
if (scannedShell.hardcoded.length) {
  warn.push(`外壳里 ${scannedShell.hardcoded.length} 行中文字面量没走翻译（可能是数据值/注释外的说明，需人工确认；前 40 条）：\n${scannedShell.hardcoded.slice(0, Number(args.get("hardcoded") ?? 40)).map(u => `    ${u.file}:${u.line} ${u.key}`).join('\n')}`)
}
// zh-CN 外壳：id 形式的 key 必须全有值
const zhMissingIds = shellIdKeys.filter(key => !(key in shellZh))
if (zhMissingIds.length) fail.push(`locales/shell/zh-CN.json 缺 ${zhMissingIds.length} 个 id key，例如 ${zhMissingIds[0]}`)
const zhStray = Object.keys(shellZh).filter(key => !(key in shellEn))
if (zhStray.length) fail.push(`locales/shell/zh-CN.json 有 ${zhStray.length} 个 key 不在 en.json，例如 ${zhStray[0]}`)

console.log('语言      画布缺口   画布完整度  外壳缺口   外壳完整度  译文问题')
for (const locale of LOCALES) {
  let canvas: Record<string, string> = {}
  let shell: Record<string, string> = {}
  if (locale !== 'zh-CN') {
    const path = join(CANVAS_I18N, canvasFile(locale))
    try { canvas = locale === 'en' ? canvasEn : readJson(path) } catch (error) { fail.push(`${relative(ROOT, path)}: JSON 解析失败（${(error as Error).message}）`) }
  }
  try { shell = readJson(join(SHELL_DIR, `${locale}.json`)) } catch (error) { fail.push(`locales/shell/${locale}.json 无法读取（${(error as Error).message}）`) }

  const canvasMissing = locale === 'zh-CN' ? [] : canvasRequired.filter(key => !(key in canvas))
  const shellNeeded = locale === 'zh-CN' ? shellIdKeys : shellRequired
  const shellMissing = shellNeeded.filter(key => !(key in shell))
  const issues: string[] = []
  const strayCanvas = Object.keys(canvas).filter(key => !(key in canvasEn))
  if (strayCanvas.length) issues.push(`canvas/${locale}: ${strayCanvas.length} 条 key 不在 en.json，例如 ${JSON.stringify(strayCanvas[0]).slice(0, 50)}`)
  const strayShell = Object.keys(shell).filter(key => !(key in shellEn))
  if (strayShell.length) issues.push(`shell/${locale}: ${strayShell.length} 条 key 不在 en.json，例如 ${JSON.stringify(strayShell[0]).slice(0, 50)}`)
  if (locale !== 'zh-CN') {
    for (const [key, value] of Object.entries(canvas)) if (typeof value !== 'string') issues.push(`canvas/${locale}: ${JSON.stringify(key).slice(0, 40)} 的译文不是字符串`)
      else if (CJK.test(key)) issues.push(...checkTranslation(locale, key, value, key, 'canvas'))
    for (const [key, value] of Object.entries(shell)) if (typeof value !== 'string') issues.push(`shell/${locale}: ${JSON.stringify(key).slice(0, 40)} 的译文不是字符串`)
      else issues.push(...checkTranslation(locale, key, value, CJK.test(key) ? key : (shellZh[key] ?? shellEn[key] ?? key), 'shell', !CJK.test(key)))
  } else {
    for (const [key, value] of Object.entries(shell)) issues.push(...checkTranslation('zh-CN', key, value, shellEn[key] ?? key, 'shell').filter(line => !/残留|占位符/.test(line) || /占位符/.test(line)))
  }
  const ready = READY.has(locale)
  const canvasTotal = canvasRequired.length
  const shellTotal = shellNeeded.length
  report[locale] = { canvasMissing: canvasMissing.length, shellMissing: shellMissing.length, canvasTotal, shellTotal, issues: issues.length }
  missingLists[locale] = { canvas: canvasMissing, shell: shellMissing }
  const pct = (missing: number, total: number) => (total ? ((1 - missing / total) * 100).toFixed(1) : '100.0') + '%'
  console.log(`${locale.padEnd(8)} ${String(canvasMissing.length).padStart(8)} ${pct(canvasMissing.length, canvasTotal).padStart(11)} ${String(shellMissing.length).padStart(9)} ${pct(shellMissing.length, shellTotal).padStart(11)} ${String(issues.length).padStart(9)}${ready ? '' : '   (未要求完整)'}`)
  if (ready && (canvasMissing.length || shellMissing.length)) fail.push(`${locale} 要求完整，但画布缺 ${canvasMissing.length} 条、外壳缺 ${shellMissing.length} 条`)
  if (issues.length) fail.push(`${locale} 译文有 ${issues.length} 处问题：\n${issues.slice(0, 8).map(line => `    ${line}`).join('\n')}${issues.length > 8 ? `\n    …另有 ${issues.length - 8} 处` : ''}`)
  if (LIST.has(locale)) {
    console.log(`\n[${locale}] 画布缺：\n${canvasMissing.map(k => '  ' + JSON.stringify(k)).join('\n')}\n[${locale}] 外壳缺：\n${shellMissing.map(k => '  ' + JSON.stringify(k)).join('\n')}\n`)
  }
}

// 主进程原生菜单复用服务端词典；它和服务端用户提示也必须通过相同的格式校验。
if (!args.has('ui-only')) {
  console.log('\n服务端 server/locales 缺口（相对 zh 源码里出现过的词条，以 en.json 为基准）：')
  const serverEn = readJson(join(SERVER_DIR, 'en.json'))
  const base = Object.keys(serverEn)
  const mainSource = readFileSync(join(ROOT, 'desktop/main.ts'), 'utf8')
  const nativeKeys = [...new Set([...mainSource.matchAll(/nativeText\('((?:\\.|[^'\\])*)'/g)].map(match => cook(match[1])))]
  const nativeMissing = nativeKeys.filter(key => !(key in serverEn))
  if (nativeMissing.length) fail.push(`原生菜单有 ${nativeMissing.length} 条文案不在 server/locales/en.json：${nativeMissing.map(key => JSON.stringify(key)).join('、')}`)
  for (const locale of LOCALES) {
    if (locale === 'zh-CN') continue
    const file = join(SERVER_DIR, canvasFile(locale))
    if (!existsSync(file)) { fail.push(`${locale} 缺少服务端词典文件`); console.log(`  ${locale.padEnd(6)} 无词典文件`); continue }
    let catalog: Record<string, string>
    try { catalog = readJson(file) } catch (error) { fail.push(`server/${locale}: JSON 解析失败（${(error as Error).message}）`); continue }
    const missing = base.filter(key => !(key in catalog))
    const issues = Object.entries(catalog).flatMap(([key, value]) => typeof value !== 'string'
      ? [`server/${locale}: ${JSON.stringify(key)} 的译文不是字符串`]
      : CJK.test(key) ? checkTranslation(locale, key, value, key, 'server') : [])
    console.log(`  ${locale.padEnd(6)} ${String(Object.keys(catalog).length).padStart(5)} / ${base.length}，缺 ${missing.length}，译文问题 ${issues.length}`)
    if (READY.has(locale) && missing.length) fail.push(`${locale} 服务端文案缺 ${missing.length} 条`)
    if (issues.length) fail.push(`${locale} 服务端译文有 ${issues.length} 处问题：\n${issues.slice(0, 8).map(line => `    ${line}`).join('\n')}`)
  }
}

for (const item of warn) console.log(`\n提示：${item}`)
if (fail.length) {
  console.log(`\n不通过 ${fail.length} 项：`)
  for (const item of fail) console.log(`  - ${item}`)
  process.exitCode = 1
} else {
  console.log('\n全部通过。')
}
