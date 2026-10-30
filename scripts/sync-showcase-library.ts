import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'

// Import reviewed sources only. This command never fetches media or calls models.
const { values } = parseArgs({ options: { website: { type: 'string' }, cases: { type: 'string' }, revision: { type: 'string' },
  'source-map': { type: 'string' }, translations: { type: 'string' }, 'reviewed-at': { type: 'string', default: new Date().toISOString().slice(0, 10) } } })
if (!values.website || !values.cases || !values.revision) throw new Error('--website, --cases and --revision are required')
const root = resolve(import.meta.dirname, '..'), destination = join(root, 'content/showcase')
const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'))
const source = await readFile(join(values.website, 'web/src/landing/films.ts'), 'utf8')
function exportedArray(name: string) {
  const match = new RegExp('export const ' + name + '[^=]*=\\s*').exec(source)
  if (!match) throw new Error('Missing export: ' + name)
  const start = match.index + match[0].length
  // The reviewed data export is JSON, not executable TypeScript.
  let string = false, escaped = false, depth = 0
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (escaped) { escaped = false; continue }
    if (string && ch === '\\') { escaped = true; continue }
    if (ch === '"') string = !string
    if (!string) {
      if (ch === '[') depth++
      if (ch === ']' && --depth === 0) return JSON.parse(source.slice(start, i + 1))
    }
  }
  throw new Error('Invalid reviewed data export')
}
const films = exportedArray('films'), themes = exportedArray('filmThemes')
const cases = (await json(values.cases)).cases
const bySlug = new Map(cases.map(c => [c.slug, c]))
const byUrl = new Map(cases.filter(c => c.goodcaseUrl).map(c => [c.goodcaseUrl, c]))
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const byMedia = new Map(cases.filter(c => c.mediaUrl).map(c => [hash(c.mediaUrl).slice(0, 12), c]))
const sourceMap = values['source-map'] ? await json(values['source-map']) : {}
const translated = values.translations ? await json(values.translations) : {}
const previous = new Map((await json(join(destination, 'catalog.json'))).films.map(f => [f.id, f]))
const oldTranslations: Record<string, any> = {}
for (const file of await readdir(join(destination, 'translations'))) if (file.endsWith('.json')) Object.assign(oldTranslations, await json(join(destination, 'translations', file)))
const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}_]/gu, '')
const byTitle = new Map<string, any[]>()
for (const item of cases) for (const text of [item.title, item.titleEn]) if (text) {
  const key = normalize(text); byTitle.set(key, [...(byTitle.get(key) || []), item])
}
const prompts: Record<string, any> = {}, translations: Record<string, any> = {}, seen = new Set<string>()
const index = films.map(original => {
  const film = { ...original }
  if (seen.has(film.id) || !film.video.startsWith('/showcase/')) throw new Error('Invalid film')
  seen.add(film.id)
  let item: any = bySlug.get(sourceMap[film.id]) || byUrl.get((previous.get(film.id) as any)?.caseUrl)
    || (film.id.startsWith('extra-') ? byMedia.get(film.id.slice(6)) : null)
  if (!item) {
    const matches = new Map(film.title.flatMap(title => byTitle.get(normalize(title)) || []).map(c => [c.slug, c]))
    if (matches.size === 1) item = matches.values().next().value
  }
  film.poster ||= `/landing/film-${film.id}.webp?v=20261014`
  delete film.promptFile; delete film.translationFile
  if (!item) return { ...film, hasPrompt: false }
  Object.assign(film, { summary: [item.summary || '', item.summaryEn || ''], model: (item.models || []).join(' / '),
    sourceUrl: item.sourceUrl, caseUrl: item.goodcaseUrl, creator: item.creator, sourceId: item.slug, hasPrompt: Boolean(item.promptFull?.trim()) })
  if (film.hasPrompt) {
    const bucket = hash(film.id).slice(0, 2), fingerprint = hash(item.promptFull)
    film.promptFile = `inspiration/prompts/${bucket}.json`
    ;(prompts[bucket] ||= {})[film.id] = item.promptFull
    const translation = translated[fingerprint] || (oldTranslations[film.id]?.sourceSha256 === fingerprint ? oldTranslations[film.id] : {})
    const available = Object.fromEntries(Object.entries(translation).filter(([key, text]) => ['zh-Hans', 'en'].includes(key) && typeof text === 'string' && text.trim()))
    if (Object.keys(available).length) {
      film.translationFile = `inspiration/translations/${bucket}.json`
      ;(translations[bucket] ||= {})[film.id] = { sourceSha256: fingerprint, ...available }
    }
  }
  return film
})
for (const [name, data] of Object.entries({ prompts, translations })) {
  const directory = join(destination, name)
  await mkdir(directory, { recursive: true })
  for (const file of await readdir(directory)) if (/^[a-f0-9]{2}\.json$/.test(file)) await rm(join(directory, file))
  for (const [bucket, shard] of Object.entries(data)) await writeFile(join(directory, bucket + '.json'), JSON.stringify(shard))
}
const playback = await json(join(values.website, 'web/src/landing/playback.json'))
const adaptive = await json(join(values.website, 'web/src/landing/adaptive.json'))
for (const [name, data] of Object.entries({ catalog: { reviewedAt: values['reviewed-at'], sourceRevision: values.revision, themes, films: index },
  playback: Object.fromEntries(films.filter(f => playback[f.video]).map(f => [f.video, playback[f.video]])),
  adaptive: Object.fromEntries(films.filter(f => adaptive[f.video]).map(f => [f.video, adaptive[f.video]])) })) {
  await writeFile(join(destination, name + '.json'), JSON.stringify(data) + '\n')
}
console.log(JSON.stringify({ films: index.length, withOriginalPrompt: index.filter(f => f.hasPrompt).length, withTranslation: index.filter(f => f.translationFile).length }))
