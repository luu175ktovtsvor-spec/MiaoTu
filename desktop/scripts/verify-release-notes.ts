import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = fileURLToPath(new URL('..', import.meta.url))
const version = JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8')).version
const source = readFileSync(join(desktopDir, '..', 'server', 'release-notes.ts'), 'utf8')

if (!new RegExp(`['"]${version.replaceAll('.', '\\.')}['"]\\s*:`).test(source)) {
  throw new Error(`缺少桌面版 ${version} 的用户更新说明：请先在 server/release-notes.ts 按「新增功能 / 优化改进 / Bug 修复」写好。`)
}
if (/knownIssues\s*:|已知问题|known\s+issues?/i.test(source)) {
  throw new Error('发布说明只写新增功能、优化改进和 Bug 修复，不添加“已知问题”。')
}
// 每一版都必须是三栏结构，栏目可以为空数组。
for (const [, version, body] of source.matchAll(/^  '([\d.]+)': \{([\s\S]*?)^  \},$/gm)) {
  for (const key of ['features', 'improvements', 'fixes']) if (!new RegExp(`^    ${key}: \\[`, 'm').test(body)) throw new Error(`${version} 缺少 ${key} 栏：发布说明按「新增功能 / 优化改进 / Bug 修复」三栏写。`)
}
// 标题写成 zh/en 字段，条目写成 item('中文', 'English')，两种都要检查。
for (const [, copy] of [...source.matchAll(/(?:zh|en):\s*'((?:[^'\\]|\\.)*)'|item\('((?:[^'\\]|\\.)*)',\s*'((?:[^'\\]|\\.)*)'\)/g)].flatMap(match => [match[1], match[2], match[3]].filter(Boolean).map(text => [match[0], text] as const))) {
  if (/上游|供应商|网关|服务端|服务器|后端|管理端|通道|渠道|大陆|迁移|备案|云厂商|官方账号|穗禾|秘塔|云枢|白名单|Sub2API|MCP|Suihe|Metaso|Yunshu|whitelist|已知问题|known\s+issues?|\b(?:API|upstream|provider|gateway|backend|server|channels?|official\s+account|admin\s+console)\b|server\s+to\s+API/i.test(copy)) {
    throw new Error('发布说明只能写客户能理解的功能修复和使用改进。')
  }
}
console.log(`用户更新说明已就绪：${version}`)
