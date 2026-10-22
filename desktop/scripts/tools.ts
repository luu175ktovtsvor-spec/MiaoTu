import { mkdir, chmod, rm, rename } from 'node:fs/promises'
import { createWriteStream, existsSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
export async function prepareTools(platform, arch) {
  if (!['darwin', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch) || platform === 'win32' && arch !== 'x64') throw new Error('未支持的桌面构建平台')
  const directory = join(root, '.tools', (platform === 'darwin' ? 'mac' : 'win') + '-' + arch)
  await mkdir(directory, { recursive: true })
  const base = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/'
  for (const tool of ['ffmpeg', 'ffprobe', 'LICENSE', 'README']) {
    const binary = ['ffmpeg','ffprobe'].includes(tool)
    const name = binary ? `${tool}-${platform}-${arch}.gz` : `${platform}-${arch}.${tool}`
    const path = join(directory, tool + (binary && platform === 'win32' ? '.exe' : ''))
    if (existsSync(path)) continue
    try {
      const response = await fetch(base + name, { signal: AbortSignal.timeout(300000) })
      if (!response.ok || !response.body) throw new Error('媒体工具下载失败：' + response.status)
      await pipeline(Readable.fromWeb(response.body), ...(binary ? [createGunzip()] : []), createWriteStream(path + '.download'))
      await rename(path + '.download', path)
      if (binary) await chmod(path, 0o755)
    } catch (error) { await rm(path + '.download', { force: true }); throw error }
  }
  return directory
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await prepareTools(process.argv[2] || process.platform, process.argv[3] || process.arch)
