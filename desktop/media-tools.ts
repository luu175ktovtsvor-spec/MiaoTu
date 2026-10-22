import { mkdir, readFile, rm, rename, chmod, stat } from 'node:fs/promises'
import { createWriteStream, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Transform, Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { join } from 'node:path'
import manifest from './media-tools.json' with { type: 'json' }

export class MediaTools {
  declare key: any
  declare entries: any
  declare directory: any
  declare pending: any
  declare state: string
  declare received: any
  declare error: any
  declare controller: AbortController

  constructor({ directory, platform = process.platform, arch = process.arch }: Record<string, any>) {
    this.key = platform + '-' + arch
    this.entries = manifest.platforms[this.key]
    if (!this.entries) throw new Error('当前系统尚无媒体工具包')
    this.directory = join(directory, 'tools', this.key, manifest.version)
    this.pending = null; this.state = 'available'; this.received = 0; this.error = ''
    this.controller = new AbortController()
  }
  async ensure() {
    if (this.state === 'ready') return
    if (this.pending) return this.pending
    this.pending = this.install().finally(() => { this.pending = null })
    return this.pending
  }
  async install() {
    this.error = ''; this.received = 0; this.state = 'checking'
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    try {
      for (const entry of this.entries) {
        const path = join(this.directory, entry.name)
        if (existsSync(path) && (await stat(path)).size === entry.size && createHash('sha256').update(await readFile(path)).digest('hex') === entry.sha256) continue
        this.state = 'downloading'
        const response = await fetch(manifest.origin + entry.url, { redirect: 'error', signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(300000)]) })
        if (!response.ok || !response.body) throw new Error('媒体工具暂时无法下载，请稍后重试')
        const hash = createHash('sha256'); let size = 0
        const validate = new Transform({ transform: (chunk, _encoding, done) => {
          size += chunk.length
          if (size > entry.size) { done(new Error('媒体工具包大小异常')); return }
          hash.update(chunk); this.received += chunk.length; done(null, chunk)
        } })
        const temp = path + '.download'
        try {
          await pipeline(Readable.fromWeb(response.body), createGunzip(), validate, createWriteStream(temp, { mode: 0o700 }))
          if (size !== entry.size || hash.digest('hex') !== entry.sha256) throw new Error('媒体工具包校验失败，未安装')
          await chmod(temp, 0o700); await rename(temp, path)
        } finally { await rm(temp, { force: true }) }
      }
      this.state = 'ready'
    } catch (error) { this.state = 'error'; this.error = error.message; throw error }
  }
  view() { return { state: this.state, received: this.received, error: this.error } }
  stop() { this.controller.abort() }
}
