import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { validateDetail, validateShowcase, type FilmDetail, type ShowcaseCatalog } from '../server/showcase-schema.ts'

export function encodeContent(value: any): string {
  const sort = (x: any): any => Array.isArray(x) ? x.map(sort) : x && typeof x === 'object'
    ? Object.fromEntries(Object.keys(x).sort().map(key => [key, sort(x[key])])) : x
  return JSON.stringify(sort(value))
}
export const contentHash = (value: any) => createHash('sha256').update(encodeContent(value)).digest('hex')
export const readContent = async (path: string) => JSON.parse(await readFile(path, 'utf8'))
export async function atomicContent(path: string, value: any) {
  const temporary = path + '.' + randomUUID() + '.tmp'
  await mkdir(dirname(path), { recursive: true })
  try { await writeFile(temporary, encodeContent(value)); await rename(temporary, path) }
  finally { await unlink(temporary).catch(() => {}) }
}
export async function immutableContent(path: string, value: any) {
  const bytes = encodeContent(value)
  await mkdir(dirname(path), { recursive: true })
  try { await writeFile(path, bytes, { flag: 'wx' }) }
  catch (error) { if (error.code !== 'EEXIST' || await readFile(path, 'utf8') !== bytes) throw error }
}

export async function buildShowcaseContent(source: string, output: string) {
  const catalog = await readContent(join(source, 'catalog.json'))
  const playback = await readContent(join(source, 'playback.json'))
  const adaptive = await readContent(join(source, 'adaptive.json'))
  const shards = new Map<string, any>()
  const shard = async (name: string) => {
    if (!/^inspiration\/(prompts|translations)\/[a-f0-9]{2}\.json$/.test(name)) throw new Error('Invalid content shard')
    const path = name.replace(/^inspiration\//, '')
    if (!shards.has(path)) shards.set(path, await readContent(join(source, path)))
    return shards.get(path)
  }
  const films: any[] = [], details: Record<string, any> = {}
  for (const original of catalog.films) {
    const { promptFile, translationFile, ...film } = original
    if (details[film.id]) throw new Error('Duplicate film ID')
    const prompt = promptFile ? (await shard(promptFile))[film.id] || '' : ''
    const translated = translationFile ? (await shard(translationFile))[film.id] || {} : {}
    if (film.hasPrompt && !String(translated['zh-Hans'] || '').trim()) throw new Error('Missing Chinese translation: ' + film.id)
    if (film.hasPrompt && !prompt.trim()) throw new Error('Missing original prompt: ' + film.id)
    if (translated.sourceSha256 && translated.sourceSha256 !== createHash('sha256').update(prompt).digest('hex')) throw new Error('Stale translation: ' + film.id)
    details[film.id] = { id: film.id, prompt, translations: Object.fromEntries(Object.entries(translated).filter(([key]) => ['zh-Hans', 'en'].includes(key))),
      playback: { fallback: playback[film.video] || film.video, ...(adaptive[film.video] ? { adaptive: adaptive[film.video] } : {}) } }
    films.push(film)
  }
  const { films: ignoredFilms, sourceRepository: ignoredSource, ...metadata } = catalog
  const base = { ...metadata, schema: 1, formatVersion: 2, films }
  const version = contentHash({ catalog: base, details })
  const manifest = validateShowcase({ ...base, version })
  const release = join(output, 'releases', version)
  for (const [id, detail] of Object.entries(details)) await immutableContent(join(release, 'films', id + '.json'), validateDetail({ ...detail, schema: 1, version }, version, id))
  const search = { ...manifest, films: films.map(film => ({ ...film, prompt: details[film.id].prompt, translations: details[film.id].translations, playback: details[film.id].playback })) }
  await immutableContent(join(release, 'manifest.json'), manifest)
  await immutableContent(join(release, 'search.json'), search)
  const overlays = await readContent(join(source, '../archive-translations.json'))
  if (overlays.schema !== 1 || !overlays.items) throw new Error('Invalid archive translations')
  for (const [id, entry] of Object.entries(overlays.items) as [string, any][]) if (!/^\d{10,24}$/.test(id) || !/^[a-f0-9]{64}$/.test(entry.sourceSha256) || !entry['zh-Hans']?.trim() || !entry.en?.trim()) throw new Error('Invalid archive translation: ' + id)
  await atomicContent(join(output, '../archive/translations.json'), { ...overlays, version: contentHash(overlays.items) })
  await atomicContent(join(output, 'current.json'), manifest)
  return { version, films: films.length, manifestBytes: Buffer.byteLength(encodeContent(manifest)), searchBytes: Buffer.byteLength(encodeContent(search)) }
}

export async function validateShowcaseRelease(candidate: string) {
  const manifest = validateShowcase(await readContent(join(candidate, 'current.json')))
  const release = join(candidate, 'releases', manifest.version)
  if (encodeContent(await readContent(join(release, 'manifest.json'))) !== encodeContent(manifest)) throw new Error('Manifest mismatch')
  const details: Record<string, any> = {}
  for (const film of manifest.films) {
    const { schema, version, ...detail } = validateDetail(await readContent(join(release, 'films', film.id + '.json')), manifest.version, film.id)
    if (film.hasPrompt && !detail.prompt.trim()) throw new Error('Missing prompt: ' + film.id)
    details[film.id] = detail
  }
  const { version, ...base } = manifest
  if (contentHash({ catalog: base, details }) !== version) throw new Error('Content hash mismatch')
  const expected = { ...manifest, films: manifest.films.map(film => ({ ...film, prompt: details[film.id].prompt, translations: details[film.id].translations, playback: details[film.id].playback })) }
  if (encodeContent(await readContent(join(release, 'search.json'))) !== encodeContent(expected)) throw new Error('Search data mismatch')
  return { manifest, release }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { source: { type: 'string', default: resolve(import.meta.dirname, '../content/showcase') }, output: { type: 'string' } } })
  if (!values.output) throw new Error('--output is required')
  console.log(JSON.stringify(await buildShowcaseContent(values.source!, resolve(values.output))))
}
