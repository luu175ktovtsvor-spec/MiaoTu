import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = fileURLToPath(new URL('..', import.meta.url))
const version = JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8')).version
const source = readFileSync(join(desktopDir, '..', 'server', 'release-notes.ts'), 'utf8')

if (!new RegExp(`['"]${version.replaceAll('.', '\\.')}['"]\\s*:`).test(source)) {
  throw new Error(`缺少桌面版 ${version} 的用户更新说明：请先在 server/release-notes.ts 增加修复和优化。`)
}
// Only inspect the current version's displayed copy; older entries remain as
// historical records, while new records must be written for customers.
const current = source.match(new RegExp(`['"]${version.replaceAll('.', '\\.')}['"]\\s*:\\s*\\{([\\s\\S]*?)\\n  \\},\\n  ['"]`))?.[1] || ''
if (/knownIssues:\s*\[\s*\{/.test(current)) {
  throw new Error('发布说明只写修复和优化，不添加“已知问题”。')
}
for (const [, copy] of current.matchAll(/(?:zh|en):\s*'([^']*)'/g)) {
  if (/上游|供应商|网关|服务端|后端|管理端|通道|大陆|迁移|备案|云厂商|官方账号|Sub2API|MCP|\b(?:API|upstream|provider|gateway|backend|server)\b/i.test(copy)) {
    throw new Error('发布说明只能写客户能理解的功能修复和使用改进。')
  }
}
console.log(`用户更新说明已就绪：${version}`)
