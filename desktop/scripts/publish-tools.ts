import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const version = 'b6.1.1'
const output = resolve(root, '.tools/distribution', version)
await mkdir(output, { recursive: true })
const manifest = { version, origin: 'https://miaoimg.cn', platforms: {} }
for (const key of ['darwin-arm64', 'darwin-x64', 'win32-x64']) {
  const directory = resolve(root, '.tools', key.replace('darwin', 'mac').replace('win32', 'win'))
  const entries = []
  for (const name of await readdir(directory)) {
    if (!['ffmpeg','ffprobe','ffmpeg.exe','ffprobe.exe','LICENSE','README'].includes(name)) continue
    const bytes = await readFile(resolve(directory, name))
    const filename = key + '-' + name + '.gz'
    await writeFile(resolve(output, filename), gzipSync(bytes, { level: 9 }))
    entries.push({ name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), url: '/desktop-downloads/tools/' + version + '/' + filename })
  }
  if (entries.length !== 4) throw new Error('工具包不完整：' + key)
  manifest.platforms[key] = entries
}
await writeFile(resolve(root, 'media-tools.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log('媒体工具发行包已准备：' + output)
