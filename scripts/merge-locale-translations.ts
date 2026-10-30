#!/usr/bin/env node
// 把翻译结果安全合并进某种语言的词典（画布 + 外壳 + 服务端）。
//
// 用法：
//   node scripts/merge-locale-translations.ts <locale> <结果文件.json> [结果文件2.json …] [--dry-run]
//
// 结果文件：{ "canvas": { "<中文key>": "<译文>" }, "shell": { "<key>": "<译文>" }, "server": { "<中文key>": "<译文>" } }
// （三段都可省略；shell 的值也接受 { "<locale>": "译文" } 之外的纯字符串，不接受对象。）
//
// 规则：
//   只增不覆盖：词典里已有的 key 一律跳过（人工译文优先），并计入「已存在」。
//   key 必须是现有基准词条（画布/服务端以 en.json 为基准、外壳以 locales/shell/en.json 为基准），否则拒绝。
//   每条译文必须通过 lib-locale-translation 的校验：保留原文占位符（{0}、{name}、ICU 参数）、
//   妙图 → MiaoImg（zh-TW 为 妙圖）、Seedance/Seedream/GPT Image/Grok/MiniMax/豆包/Dola 原样保留、非中文语言无汉字残留。
//   不通过的条目不写入，全部列在输出里；只有通过的条目写入。
//   写回格式与原文件一致：2 空格缩进、保留原有顺序、新增条目追加在末尾、文件以换行结尾。
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { supportedLocales } from '../desktop/renderer/src/studio/canvas/i18n/locales.ts'
import { checkTranslation, CJK } from './lib-locale-translation.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CANVAS = join(ROOT, 'desktop/renderer/src/studio/canvas/i18n')
const SHELL = join(ROOT, 'desktop/renderer/src/locales/shell')
const SERVER = join(ROOT, 'server/locales')
const file = (locale: string) => locale === 'zh-TW' ? 'zhTw.json' : `${locale}.json`
const readJson = (path: string): Record<string, string> => JSON.parse(readFileSync(path, 'utf8'))
const isIdKey = (key: string) => /^[a-z][\w]*(?:\.[\w-]+)+$/i.test(key)

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const [locale, ...inputs] = argv.filter(arg => !arg.startsWith('--'))
if (!locale || !inputs.length) { console.error('用法：node scripts/merge-locale-translations.ts <locale> <结果文件.json>… [--dry-run]'); process.exit(2) }
if (!supportedLocales.some(item => item.code === locale) || locale === 'zh-CN') { console.error(`不支持的目标语言：${locale}（zh-CN 的词典不接受合并）`); process.exit(2) }

const sections = [
  { name: 'canvas', path: join(CANVAS, file(locale)), reference: readJson(join(CANVAS, 'en.json')), needsCjkKey: true },
  { name: 'shell', path: join(SHELL, `${locale}.json`), reference: readJson(join(SHELL, 'en.json')), needsCjkKey: false },
  { name: 'server', path: join(SERVER, file(locale)), reference: readJson(join(SERVER, 'en.json')), needsCjkKey: true },
] as const
const shellZh = readJson(join(SHELL, 'zh-CN.json'))

const incoming: Record<string, Record<string, unknown>> = { canvas: {}, shell: {}, server: {} }
for (const input of inputs) {
  const data = JSON.parse(readFileSync(input, 'utf8'))
  for (const name of Object.keys(incoming)) Object.assign(incoming[name], data?.[name] ?? {})
}

let failures = 0
for (const section of sections) {
  const entries = Object.entries(incoming[section.name])
  if (!entries.length) continue
  const target = readJson(section.path)
  const original = JSON.stringify(target, null, 2) + '\n'
  if (original !== readFileSync(section.path, 'utf8')) console.warn(`提示：${section.path} 的排版与标准格式不同，写回时会被规范化（缩进 2 空格）`)
  let added = 0
  let existing = 0
  const rejected: string[] = []
  for (const [key, value] of entries) {
    if (!(key in section.reference)) { rejected.push(`${JSON.stringify(key).slice(0, 50)} → 不是现有词条的 key`); continue }
    if (typeof value !== 'string' || !value.trim()) { rejected.push(`${JSON.stringify(key).slice(0, 50)} → 译文为空或不是字符串`); continue }
    if (key in target) { existing += 1; continue }
    const source = section.name === 'shell' && isIdKey(key) ? (shellZh[key] ?? section.reference[key]) : key
    const problems = checkTranslation(locale, key, value, source, section.name, section.name === 'shell' && isIdKey(key))
    if (problems.length) { rejected.push(...problems.map(line => line.replace(/^[^:]+: /, ''))); continue }
    target[key] = value
    added += 1
  }
  failures += rejected.length
  console.log(`${section.name.padEnd(6)} ${locale}: 新增 ${added}，已存在跳过 ${existing}，拒绝 ${rejected.length}`)
  for (const line of rejected.slice(0, 30)) console.log(`    拒绝 ${line}`)
  if (rejected.length > 30) console.log(`    …另有 ${rejected.length - 30} 条`)
  if (added && !dryRun) {
    // 先写临时文件再改名，进程中途退出不会留下半个词典
    const temp = `${section.path}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(target, null, 2) + '\n')
    renameSync(temp, section.path)
  }
}
if (dryRun) console.log('（--dry-run：没有写入任何文件）')
if (failures) process.exitCode = 1
