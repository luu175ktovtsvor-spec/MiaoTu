import { closeSync, constants, fstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'

const MAX_BYTES = 200 * 1024
const failure = (message, status) => Object.assign(new Error(message), { status })

function readText(file) {
  // Opening a FIFO can block before fstat gets a chance to reject it.
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw failure('技能引用不是文件', 422)
    const bytes = Buffer.alloc(Math.min(MAX_BYTES, stat.size))
    const count = readSync(fd, bytes, 0, bytes.length, 0)
    if (bytes.subarray(0, count).includes(0)) throw failure('技能引用须为文本文件', 422)
    const prefix = bytes.subarray(0, count)
    const content = stat.size > count ? Buffer.from(new StringDecoder('utf8').write(prefix)) : prefix
    return { bytes: content, size: stat.size, revision: `${stat.mtimeMs}:${stat.size}`, truncated: stat.size > content.length }
  } finally { closeSync(fd) }
}

// Only the desktop Agent receives this provider; hosted services and remote MCP
// clients must not discover the desktop user's personal skills.
export function createLocalSkills({ status, signal: accessSignal, home = homedir() }: Record<string, any>) {
  async function readPage(file, lease, { offset, limit, signal }) {
    const combined = AbortSignal.any([lease, signal].filter(Boolean))
    const assertAccess = () => {
      combined.throwIfAborted()
      if (!status().enabled) throw failure('本机操作尚未开启或授权已撤销', 403)
    }
    assertAccess()
    const handle = await open(file.path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0))
    let stream
    try {
      assertAccess()
      const stat = await handle.stat()
      if (!stat.isFile()) throw failure('技能引用不是文件', 422)
      if (`${stat.mtimeMs}:${stat.size}` !== file.revision) throw failure('技能文件已更新，请从所需位置重新读取', 409)
      stream = handle.createReadStream({ encoding: 'utf8', autoClose: false, signal: combined })
      let position = 0, content = ''
      // Node decodes UTF-8 across chunk boundaries. Keep only one page and one
      // look-ahead character; skipped content never accumulates in memory.
      for await (const chunk of stream) {
        assertAccess()
        if (chunk.includes('\0')) throw failure('技能引用须为文本文件', 422)
        if (position + chunk.length > offset) content += chunk.slice(Math.max(0, offset - position), Math.max(0, offset - position) + limit + 1 - content.length)
        position += chunk.length
        if (content.length > limit) break
      }
      assertAccess()
      const after = await handle.stat()
      assertAccess()
      if (`${after.mtimeMs}:${after.size}` !== file.revision) throw failure('技能文件已更新，请从所需位置重新读取', 409)
      const more = content.length > limit
      return { offset, content: content.slice(0, limit), nextOffset: more ? offset + limit : null, total: more ? null : position }
    } finally { stream?.destroy(); await handle.close() }
  }
  function discover(targetId?: string) {
    const access = status()
    if (!access.enabled) return []
    const roots = [{ scope: 'home', path: join(home, '.agents', 'skills') }]
    if (access.directory && resolve(access.directory) !== resolve(home)) roots.unshift({ scope: 'project', path: join(access.directory, '.agents', 'skills') })
    const skills = [], seen = new Set()
    for (const root of roots) {
      let entries
      try { entries = readdirSync(root.path, { withFileTypes: true }) } catch { continue }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
        try {
          // Installed skill directories may be symlinks; resolve once and keep
          // every referenced file inside that actual skill directory.
          const directory = realpathSync(join(root.path, entry.name))
          if (seen.has(directory)) continue
          const path = realpathSync(join(directory, 'SKILL.md'))
          if (!inside(directory, path)) continue
          const id = `local-${root.scope}-${createHash('sha256').update(entry.name).digest('hex').slice(0, 20)}`
          // Preserve project-first realpath deduplication without reading every
          // unrelated skill body when one known skill is requested.
          if (targetId && id !== targetId) { seen.add(directory); continue }
          const file = readText(path)
          skills.push({ id, name: entry.name, directory, path, scope: root.scope, ...file })
          seen.add(directory)
          if (targetId) return skills
        } catch { /* A missing, unreadable or invalid skill cannot hide the rest. */ }
      }
    }
    return skills
  }
  function inside(directory, file) {
    const path = relative(directory, file)
    return path && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path)
  }
  return {
    list: () => discover(),
    read(id, parts) {
      if (!status().enabled) throw failure('本机操作尚未开启或授权已撤销', 403)
      const skill = discover(id).find(item => item.id === id)
      if (!skill) throw failure('本地技能不存在或已不可访问', 404)
      let path
      try { path = realpathSync(join(skill.directory, ...parts)) } catch { throw failure('技能引用不存在', 404) }
      if (!inside(skill.directory, path)) throw failure('技能引用必须位于该技能目录内', 403)
      const file = path === skill.path ? skill : readText(path)
      const lease = accessSignal?.()
      return { bytes: file.bytes, size: file.size, revision: file.revision, truncated: file.truncated, path, directory: skill.directory, mime: 'text/markdown',
        ...(file.truncated ? { readPage: options => readPage({ path, revision: file.revision }, lease, options) } : {}) }
    },
  }
}
