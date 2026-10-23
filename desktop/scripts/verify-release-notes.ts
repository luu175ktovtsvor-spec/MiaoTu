import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = fileURLToPath(new URL('..', import.meta.url))
const version = JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8')).version
const source = readFileSync(join(desktopDir, '..', 'server', 'release-notes.ts'), 'utf8')

if (!new RegExp(`['"]${version.replaceAll('.', '\\.')}['"]\\s*:`).test(source)) {
  throw new Error(`缺少桌面版 ${version} 的用户更新说明：请先在 server/release-notes.ts 增加修复、优化和已知问题。`)
}
// Only inspect displayed copy; internal comments can document this rule.
for (const [, copy] of source.matchAll(/(?:zh|en):\s*'([^']*)'/g)) {
  if (/上游|供应商|网关|服务端|后端|通道|\b(?:API|upstream|provider|gateway|backend|server)\b/i.test(copy)) {
    throw new Error('更新说明要直接写修好了哪一个界面、哪一项操作，不要写上游或看不出具体改动的话。')
  }
}
console.log(`用户更新说明已就绪：${version}`)
