#!/usr/bin/env node
// 检查随源码维护的语言包：JSON 合法、条目数、覆盖率、
// key 必须都在 en.json 里、以及清洗后不能残留上游品牌。
//
// 用法：node scripts/check-canvas-locales.ts    （有问题时退出码非 0）
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const I18N_DIR = join(ROOT, 'desktop/renderer/src/studio/canvas/i18n')

const FILES = [
  'zhTw.json', 'ja.json', 'ru.json', 'vi.json', 'th.json', 'ko.json', 'hi.json', 'id.json',
  'ms.json', 'fil.json', 'bn.json', 'ur.json', 'ta.json', 'te.json', 'mr.json', 'pa.json',
  'ar.json', 'fa.json', 'tr.json',
]

// 插件宿主标识保持原样；待清理的历史品牌由兼容清单集中定义。
const ALLOWED_TOKENS = ['miaoimgNodes']
const RETIRED_BRANDS = ['Toonflow', 'HBAI']
const BRAND_RES = [...RETIRED_BRANDS.map(brand => new RegExp(brand, 'i')), /github\.com/i]
const allowed = new RegExp(ALLOWED_TOKENS.join('|'), 'gi')

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

const en = readJson(join(I18N_DIR, 'en.json'))
const enKeys = new Set(Object.keys(en))
const total = enKeys.size

const fail = []
console.log(`en.json：${total} 条\n`)
console.log('文件         条目数   覆盖率   越界key  品牌残留  妙圖  运行时标识')
let entriesTotal = 0
let identifierTotal = 0
for (const file of FILES) {
  let catalog
  try {
    catalog = readJson(join(I18N_DIR, file))
  } catch (error) {
    fail.push(`${file}: JSON 解析失败（${error.message}）`)
    console.log(`${file.padEnd(12)} 解析失败`)
    continue
  }
  const keys = Object.keys(catalog)
  entriesTotal += keys.length
  const stray = keys.filter((key) => !enKeys.has(key))
  if (stray.length) fail.push(`${file}: ${stray.length} 条 key 不在 en.json 里，例如 ${JSON.stringify(stray[0])}`)
  const brand = []
  let identifiers = 0
  let traditionalBrand = 0
  for (const [key, value] of Object.entries(catalog)) {
    const text = String(value)
    for (const field of [key, text]) {
      if (new RegExp(ALLOWED_TOKENS.join('|'), 'i').test(field)) identifiers += 1
      const stripped = field.replace(allowed, '')
      if (BRAND_RES.some((re) => re.test(stripped))) brand.push(`${JSON.stringify(key)}: ${JSON.stringify(field).slice(0, 80)}`)
    }
    // 上游品牌换成了 MiaoImg，译文里不该再出现中文品牌名（zhTw 用繁体「妙圖」）。
    if (/妙图/.test(text) && text !== key) {
      fail.push(`${file}: 译文里出现简体「妙图」：${JSON.stringify(key)} → ${JSON.stringify(text).slice(0, 80)}`)
    }
    if (/妙圖/.test(text)) traditionalBrand += 1
  }
  identifierTotal += identifiers
  if (brand.length) fail.push(`${file}: ${brand.length} 处上游品牌残留，例如 ${brand[0]}`)
  const coverage = ((keys.length / total) * 100).toFixed(1)
  console.log(
    `${file.padEnd(12)} ${String(keys.length).padStart(6)} ${(coverage + '%').padStart(8)} `
    + `${String(stray.length).padStart(8)} ${String(brand.length).padStart(9)} `
    + `${String(traditionalBrand).padStart(5)} ${String(identifiers).padStart(10)}`,
  )
}

const average = Math.round(entriesTotal / FILES.length)
console.log(`\n19 个语言包合计 ${entriesTotal} 条，平均每种语言 ${average} 条，覆盖率 ${((average / total) * 100).toFixed(1)}%`)
console.log(`其余 ${total - average} 条没有译文，查不到就回落中文原文（妙图自己的功能文案，上游没有）`)
console.log(`含运行时标识 ${ALLOWED_TOKENS.join('、')} 的条目 ${identifierTotal} 处，这是妙图自己的节点插件全局名，按原样保留`)
if (fail.length) {
  console.log(`\n不通过 ${fail.length} 项：`)
  for (const item of fail) console.log(`  - ${item}`)
  process.exitCode = 1
} else {
  console.log('\n全部通过：JSON 合法、key 都在 en.json 里、无上游品牌残留。')
}
