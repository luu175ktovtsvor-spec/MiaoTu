import { cp, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { execFileSync } from 'node:child_process'
import { atomicContent, validateShowcaseRelease, readContent, contentHash, immutableContent } from '../../scripts/build-showcase-content.ts'

const { values } = parseArgs({ options: { candidate: { type: 'string' }, root: { type: 'string', default: '/opt/miaoimg/library-content/showcase' },
  'media-origin': { type: 'string' }, activate: { type: 'boolean' }, locked: { type: 'boolean' } } })
if (!values.candidate || !values['media-origin']) throw new Error('--candidate and --media-origin are required')
if (values.activate && !values.locked) {
  // Reuse the same OS locks as the existing production publishers.
  execFileSync('flock', ['-x', '/opt/miaoimg/.production-release.lock', 'flock', '-x', '/run/lock/miaoimg-deploy.lock',
    process.execPath, ...process.execArgv, import.meta.filename, ...process.argv.slice(2), '--locked'], { stdio: 'inherit' })
} else {
  const { manifest, release } = await validateShowcaseRelease(resolve(values.candidate))
  const overlay = await readContent(join(resolve(values.candidate), '../archive/translations.json'))
  if (overlay?.schema !== 1 || !overlay.items || contentHash(overlay.items) !== overlay.version) throw new Error('Archive translation hash mismatch')
  const resources = new Map<string, string>()
  for (const film of manifest.films) { resources.set(film.video, 'video/'); resources.set(film.poster, 'image/') }
  const entries = [...resources], errors: string[] = []
  let cursor = 0
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (cursor < entries.length) {
      const [path, mime] = entries[cursor++]
      try {
        const response = await fetch(new URL(path, values['media-origin']), { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(15_000) })
        if (response.status !== 200 || !response.headers.get('content-type')?.startsWith(mime)) errors.push(path)
        await response.body?.cancel()
      } catch { errors.push(path) }
    }
  }))
  if (errors.length) throw new Error(`Media validation failed (${errors.length}): ${errors.slice(0, 10).join(', ')}`)
  console.log(JSON.stringify({ validatedVersion: manifest.version, films: manifest.films.length, mediaChecked: entries.length }))
  if (values.activate) {
    const root = resolve(values.root!), target = join(root, 'releases', manifest.version)
    const files = async (directory: string) => {
      const result: Record<string, string> = {}
      for (const file of await readdir(directory, { recursive: true, withFileTypes: true })) if (file.isFile()) {
        const path = join(file.parentPath, file.name)
        result[path.slice(directory.length)] = createHash('sha256').update(await readFile(path)).digest('hex')
      }
      return JSON.stringify(Object.entries(result).sort())
    }
    await mkdir(join(root, 'releases'), { recursive: true })
    let exists = true
    try { await readdir(target) } catch (error) { if (error.code === 'ENOENT') exists = false; else throw error }
    if (exists) {
      if (await files(target) !== await files(release)) throw new Error('Immutable release differs')
    } else {
      const stage = join(root, 'releases', '.staging-' + randomUUID())
      try { await cp(release, stage, { recursive: true, errorOnExist: true }); await rename(stage, target) }
      finally { await rm(stage, { recursive: true, force: true }) }
    }
    const archiveRoot = resolve(root, '../archive')
    await immutableContent(join(archiveRoot, 'releases', overlay.version + '.json'), overlay)
    await atomicContent(join(archiveRoot, 'translations.json'), overlay)
    await atomicContent(join(root, 'current.json'), manifest)
    console.log('Content activated; desktop installers and update feeds unchanged.')
  }
}
