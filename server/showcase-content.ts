import { mkdir, readFile, rename, writeFile, unlink, readdir, rm, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

import { VERSION, ID, PREFIX, unavailable, validateDetail, validateShowcase, type ShowcaseCatalog, type FilmDetail } from './showcase-schema.ts'

// Only data is fetched. Code, HTML and executable modules never come from this feed.
// A validated disk cache remains usable when the public service is unreachable.
export class ShowcaseContent {
  private current: ShowcaseCatalog | null = null
  private checked = 0
  private pending: Promise<ShowcaseCatalog> | null = null
  private reads = new Map<string, Promise<any>>()
  private options: { directory: string; fetchFile: (path: string, signal: AbortSignal) => Promise<Response> }
  constructor(options: ShowcaseContent['options']) { this.options = options }
  async cachedCatalog() {
    if (!this.current) { try { this.current = validateShowcase(await this.disk('current.json')) } catch {} }
    return this.current
  }
  private async prune(version: string) {
    const entries = await readdir(this.options.directory, { withFileTypes: true })
    const old = await Promise.all(entries.filter(x => x.isDirectory() && VERSION.test(x.name) && x.name !== version).map(async x => ({ name: x.name, time: (await stat(join(this.options.directory, x.name))).mtimeMs })))
    for (const entry of old.sort((a, b) => b.time - a.time).slice(2)) await rm(join(this.options.directory, entry.name), { recursive: true, force: true })
  }
  private async remote(path: string, maxBytes: number) {
    const signal = AbortSignal.timeout(12_000)
    const response = await this.options.fetchFile(path, signal)
    if (!response.ok || !/application\/json/i.test(response.headers.get('content-type') || '')) { await response.body?.cancel(); throw unavailable() }
    const reader = response.body?.getReader()
    if (!reader) throw unavailable()
    let size = 0
    const chunks: Uint8Array[] = []
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maxBytes) throw unavailable()
        chunks.push(value)
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } finally { await reader.cancel().catch(() => {}) }
  }
  private async disk(path: string) { try { return JSON.parse(await readFile(join(this.options.directory, path), 'utf8')) } catch { return null } }
  private async save(path: string, value: unknown) {
    const target = join(this.options.directory, path), temporary = target + '.' + randomUUID() + '.tmp'
    try {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
      await rename(temporary, target)
    } finally { await unlink(temporary).catch(() => {}) }
  }
  async catalog(fresh = false): Promise<ShowcaseCatalog> {
    if (this.pending) return this.pending
    this.pending = (async () => {
      if (!this.current) { try { this.current = validateShowcase(await this.disk('current.json')) } catch {} }
      if (!fresh && this.current && Date.now() - this.checked < 60_000) return this.current
      try {
        const next = validateShowcase(await this.remote(PREFIX + '/current.json', 4 * 1024 * 1024))
        await this.save('current.json', next)
        this.current = next
        await this.prune(next.version).catch(() => {})
      } catch { if (!this.current) throw unavailable() }
      this.checked = Date.now()
      return this.current!
    })()
    try { return await this.pending } finally { this.pending = null }
  }
  async detail(version: string, id: string): Promise<FilmDetail> {
    if (!VERSION.test(version) || !ID.test(id)) throw Object.assign(new Error('作品不存在'), { status: 404 })
    const key = `${version}/films/${id}.json`
    if (!this.reads.has(key)) this.reads.set(key, (async () => {
      const old = await this.disk(key)
      if (old) { try { return validateDetail(old, version, id) } catch {} }
      const value = validateDetail(await this.remote(`${PREFIX}/releases/${key}`, 2 * 1024 * 1024), version, id)
      await this.save(key, value)
      return value
    })())
    const pending = this.reads.get(key)!
    try { return await pending } finally { if (this.reads.get(key) === pending) this.reads.delete(key) }
  }
  private overlayChecked = 0
  private overlays: Record<string, any> | null = null
  async archiveTranslations() {
    if (this.overlays && Date.now() - this.overlayChecked < 60_000) return this.overlays
    const validate = (value: any) => {
      if (value?.schema !== 1 || !VERSION.test(value.version) || !value.items || typeof value.items !== 'object' || Array.isArray(value.items)) throw unavailable()
      for (const [id, entry] of Object.entries(value.items) as [string, any][]) if (!/^\d{10,24}$/.test(id) || !VERSION.test(entry?.sourceSha256) || typeof entry['zh-Hans'] !== 'string' || typeof entry.en !== 'string') throw unavailable()
      return value
    }
    if (!this.overlays) { try { this.overlays = validate(await this.disk('archive-translations.json')).items } catch {} }
    try {
      const value = validate(await this.remote('/library-content/archive/translations.json', 2 * 1024 * 1024))
      await this.save('archive-translations.json', value); this.overlays = value.items
    } catch { /* Keep the source text and any previous validated translations. */ }
    this.overlayChecked = Date.now()
    return this.overlays || {}
  }
  async searchCatalog() {
    const catalog = await this.catalog()
    const key = `${catalog.version}/search.json`
    // The full prompt corpus is needed only by Agent/MCP search, never by the grid.
    let value = await this.disk(key)
    const validate = (data: any) => {
      validateShowcase(data)
      if (data.version !== catalog.version || data.films.length !== catalog.films.length) throw unavailable()
      for (const film of data.films) if (typeof film.prompt !== 'string' || !film.translations || typeof film.translations !== 'object') throw unavailable()
      return data
    }
    try { if (value) return validate(value) } catch {}
    value = validate(await this.remote(`${PREFIX}/releases/${key}`, 16 * 1024 * 1024))
    await this.save(key, value)
    return value
  }
}
