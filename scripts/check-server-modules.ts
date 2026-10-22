// 发布前预检：解析 server/ 与存在时的 web/scripts 导入，确认镜像内模块和静态资源齐全。
//
// 为什么需要它：服务端原来零运行时依赖（全靠 Node 内置），后来 Agent 运行时换成了上游同款 SDK，
// 根 package.json 才开始有 dependencies。而 docker 镜像里的依赖安装步骤（Dockerfile）和
// 服务端代码是两处独立维护的——少装一条，镜像能构建成功、web 端口照常起、健康检查照样过，
// 但 API 进程会在 import 阶段直接崩掉（踩过一次：线上 502，原因是镜像缺 SDK）。
// 这里只做「解析」，不执行任何模块，所以不会有副作用、也不会起监听。
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const serverDir = join(root, 'server')

// Literal imports only: multiline `from`, side effects and dynamic imports.
// This does not evaluate source or try to infer computed module specifiers.
const importPatterns = [
  /(?:^|\n)\s*(?:import|export)\s+[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*(?=[,)])/g,
]
const missing = []
let checked = 0
let relativeChecked = 0

// Resource trees can contain example scripts; only application modules belong
// to the server dependency check. Follow product module directories recursively.
function* serverModules(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (!['builtin-skills', 'builtin-teams', 'locales', 'node_modules'].includes(entry.name)) yield* serverModules(file)
    } else if (entry.isFile() && /\.(?:mjs|ts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) yield file
  }
}

const moduleDirectories = [serverDir]
const webScripts = join(root, 'web', 'scripts')
if (existsSync(webScripts)) moduleDirectories.push(webScripts)
for (const file of moduleDirectories.flatMap(directory => [...serverModules(directory)])) {
  const require = createRequire(file)
  const source = readFileSync(file, 'utf8')
  const specifiers = new Set(importPatterns.flatMap(pattern => [...source.matchAll(pattern)].map(match => match[1])))
  for (const specifier of specifiers) {
    if (specifier.startsWith('.')) {
      relativeChecked += 1
      try {
        const target = fileURLToPath(new URL(specifier, pathToFileURL(file)))
        if (!statSync(target).isFile()) throw new Error('Module target is not a file')
      } catch {
        missing.push(`${relative(root, file)} → ${specifier}`)
      }
      continue
    }
    if (specifier.startsWith('node:') || specifier.startsWith('file:')) continue
    checked += 1
    try {
      require.resolve(specifier)
    } catch (error) {
      // 只有「找不到」才算缺。ESM-only 的包（exports 里只有 import，没有 CJS 入口）会让
      // require.resolve 抛 ERR_PACKAGE_PATH_NOT_EXPORTED——那是包在、只是没有 require 入口，
      // 不能用它判缺失（这条踩过一次，直接把好包报成了缺依赖）。
      const code = String(error?.code || '')
      if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') missing.push(`${relative(root, file)} → ${specifier}`)
    }
  }
}

if (missing.length) {
  console.error('[server] 镜像里缺少以下模块或资源，服务导入时将失败：')
  for (const item of missing) console.error('  ' + item)
  console.error('  检查 Dockerfile 的依赖安装及 COPY（相对导入的 JSON 等资源也要收录）。')
  process.exit(1)
}
console.log(`[server] 模块依赖自检通过（解析了 ${checked} 处裸导入、${relativeChecked} 处相对导入；未执行模块）`)
