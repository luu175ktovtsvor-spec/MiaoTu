// 运行期只加载静态文件与代理；不加载 React/Vue/Tailwind 等构建插件。
// 代理表仍来自 vite.config.ts，与 nginx 生成器使用相同来源。
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import { archiveImagesPlugin, blockPrivateArchive } from './scripts/archiveMiddleware.ts'

const ports = {
  IMAGE_API_PORT: process.env.OIP_IMAGE_API_PORT || '8788',
  API_PORT: process.env.OIP_API_PORT || '8787',
  ADMIN_API_PORT: process.env.OIP_ADMIN_PORT || '4184',
}
const source = readFileSync(new URL('./vite.config.ts', import.meta.url), 'utf8')
const start = source.indexOf('  preview: {')
if (start < 0) throw new Error('preview 代理配置缺失')
const section = source.slice(start, source.indexOf('\n  },', start))
const pairs = [...section.matchAll(/'(?<path>\/[a-zA-Z0-9/_-]*)':\s*apiProxy\((?<port>[A-Z_]+)\)/g)]
if (!pairs.length) throw new Error('preview 代理配置为空')
const proxy = Object.fromEntries(pairs.map(({ groups }) => {
  if (!ports[groups.port]) throw new Error('未知代理端口：' + groups.port)
  return [groups.path, { target: 'http://127.0.0.1:' + ports[groups.port], changeOrigin: false }]
}))
proxy['/health'] = { target: 'http://127.0.0.1:' + (process.env.OIP_ENABLE_ARCHIVE === 'false' ? ports.IMAGE_API_PORT : ports.API_PORT), changeOrigin: false }
export default defineConfig({
  base: './',
  plugins: [archiveImagesPlugin(), { name: 'private-archive', configurePreviewServer(server) { blockPrivateArchive(server.middlewares) } }],
  preview: { host: '127.0.0.1', proxy },
})
