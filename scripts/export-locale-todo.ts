#!/usr/bin/env node
// 导出待翻译清单：每种语言一份 JSON，供翻译代理逐条填写。
//
// 用法：node scripts/export-locale-todo.ts <输出目录> [--locales=ja,ru,…]
//   默认导出 zh-CN、zh-TW 以外的全部语言（en 若有缺口也会导出）。
//
// 输出格式（<输出目录>/<locale>.json）：
//   {
//     "canvas": { "<中文原文 key>": "<英文参考译文>" },
//     "shell":  { "<key>": { "zh": "<简体中文>", "en": "<英文参考>" } },
//     "server": { "<中文原文 key>": "<英文参考译文>" }
//   }
// 翻译结果文件的格式只需把值换成目标语言译文：
//   { "canvas": { key: 译文 }, "shell": { key: 译文 }, "server": { key: 译文 } }
// 再用 scripts/merge-locale-translations.ts 合并回词典。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { supportedLocales } from '../desktop/renderer/src/studio/canvas/i18n/locales.ts'
import { CJK } from './lib-locale-translation.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CANVAS = join(ROOT, 'desktop/renderer/src/studio/canvas/i18n')
const SHELL = join(ROOT, 'desktop/renderer/src/locales/shell')
const SERVER = join(ROOT, 'server/locales')
const file = (locale: string) => locale === 'zh-TW' ? 'zhTw.json' : `${locale}.json`
const readJson = (path: string): Record<string, string> => JSON.parse(readFileSync(path, 'utf8'))
const isIdKey = (key: string) => /^[a-z][\w]*(?:\.[\w-]+)+$/i.test(key)

const [outDir, ...rest] = process.argv.slice(2).filter(arg => !arg.startsWith('--'))
const flags = new Map(process.argv.slice(2).filter(arg => arg.startsWith('--')).map(arg => { const [k, v = ''] = arg.slice(2).split('='); return [k, v] as const }))
if (!outDir) { console.error('用法：node scripts/export-locale-todo.ts <输出目录> [--locales=ja,ru]'); process.exit(2) }
void rest

const canvasEn = readJson(join(CANVAS, 'en.json'))
const shellEn = readJson(join(SHELL, 'en.json'))
const shellZh = readJson(join(SHELL, 'zh-CN.json'))
const serverEn = readJson(join(SERVER, 'en.json'))
const wanted = flags.get('locales') ? flags.get('locales')!.split(',') : supportedLocales.map(item => item.code).filter(code => code !== 'zh-CN' && code !== 'zh-TW')

mkdirSync(outDir, { recursive: true })
for (const locale of wanted) {
  const canvas = locale === 'en' ? canvasEn : readJson(join(CANVAS, file(locale)))
  const shell = readJson(join(SHELL, `${locale}.json`))
  const server = locale === 'en' ? serverEn : readJson(join(SERVER, file(locale)))
  const todo = { canvas: {} as Record<string, string>, shell: {} as Record<string, { zh: string; en: string }>, server: {} as Record<string, string> }
  for (const [key, en] of Object.entries(canvasEn)) if (CJK.test(key) && !(key in canvas)) todo.canvas[key] = en
  for (const [key, en] of Object.entries(shellEn)) if (!(key in shell)) todo.shell[key] = { zh: isIdKey(key) ? (shellZh[key] ?? key) : key, en }
  for (const [key, en] of Object.entries(serverEn)) if (CJK.test(key) && !(key in server)) todo.server[key] = en
  writeFileSync(join(outDir, `${locale}.json`), JSON.stringify(todo, null, 2) + '\n')
  console.log(`${locale.padEnd(4)} 画布 ${String(Object.keys(todo.canvas).length).padStart(5)}  外壳 ${String(Object.keys(todo.shell).length).padStart(4)}  服务端 ${String(Object.keys(todo.server).length).padStart(5)}`)
}
