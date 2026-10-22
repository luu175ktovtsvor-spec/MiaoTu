import { opendir, open, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir, availableParallelism } from 'node:os'
import { resolve, join, relative, basename, matchesGlob } from 'node:path'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'

const SEARCH_MS = 10000, MAX_FILE_BYTES = 2 * 1024 * 1024
const nextStep = '按用户指定的文件夹或扩展名缩小范围后继续；复杂表达式可改为 literal 搜索。未查到不代表文件不存在。'
const skippedCounts = () => ({ directories: 0, unreadable: 0, large: 0, binary: 0, symlinks: 0 })
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
const workerLimit = Math.min(4, Math.max(1, availableParallelism() - 1))
const waiting: Array<() => void> = []
let activeWorkers = 0

function matchPreview(line: string, match: RegExpExecArray) {
  if (line.length <= 1000) return line
  // Keep a fitting match in full, with nearby context, instead of returning
  // the unrelated start of a long JSON/log line. Large matches remain bounded.
  const before = Math.max(0, Math.min(160, 1000 - match[0].length))
  let start = Math.max(0, Math.min(match.index - before, line.length - 1000))
  let end = Math.min(line.length, start + 1000)
  const splitsPair = (at: number) => at > 0 && at < line.length && /[\uD800-\uDBFF]/.test(line[at - 1]) && /[\uDC00-\uDFFF]/.test(line[at])
  if (splitsPair(start)) start--
  if (splitsPair(end)) end++
  return `${start ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`
}

function acquireWorker(signal): Promise<() => void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => { const index = waiting.indexOf(start); if (index >= 0) waiting.splice(index, 1); reject(signal.reason || new Error('搜索已停止')) }
    const start = () => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) { abort(); return }
      activeWorkers++
      let released = false
      resolve(() => { if (released) return; released = true; activeWorkers--; waiting.shift()?.() })
    }
    signal.addEventListener('abort', abort, { once: true })
    if (activeWorkers < workerLimit) start()
    else waiting.push(start)
  })
}

export function localPath(cwd, value = '.') {
  if (value === '~') return homedir()
  if (/^~[\\/]/.test(value)) return resolve(homedir(), value.slice(2))
  return resolve(cwd, value)
}

export function localSearchTools(cwd) {
  return ['find', 'grep'].map(name => ({
    name,
    description: name === 'find'
      ? '按 glob 查找本机文件和文件夹，返回绝对路径。支持 ~，先指定用户目录再扩大范围；complete=false 表示只查了部分范围，不能报告全机不存在。'
      : '搜索本机文本内容，pattern 为正则或 literal 文本。支持 ~、glob、ignoreCase、UTF-8 及带 BOM 的 UTF-16 文本。长行返回首次命中附近的片段，省略部分用 … 标记；完整内容按返回的路径和行号读取。PDF、视频和图片不能用本工具读取内容。complete=false 时须说明未查完。',
    parameters: { type: 'object', properties: { pattern: { type: 'string', minLength: 1 }, path: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500 }, maxEntries: { type: 'integer', minimum: 1, maximum: 200000 }, ignoreCase: { type: 'boolean' }, ...(name === 'grep' ? { literal: { type: 'boolean' }, glob: { type: 'string' } } : {}) }, required: ['pattern'], additionalProperties: false },
    execute: (_id, args, signal) => runSearch(name, cwd, args, signal),
  }))
}

async function runSearch(name, cwd, args, signal) {
  signal.throwIfAborted()
  const release = await acquireWorker(signal)
  try {
    signal.throwIfAborted()
    return await new Promise((resolve, reject) => {
      let settled = false
      let progress = { root: localPath(cwd, args.path), results: [], scanned: 0, skipped: skippedCounts() }
      // The same module works as TypeScript in Node and compiled JavaScript in
      // Electron. Regex/glob execution must not block the app's cancellation loop.
      const worker = new Worker(new URL(import.meta.url), { workerData: { kind: 'miaoimg.local-search', name, cwd, args }, execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type')) })
      const finish = (error, value?) => {
        if (settled) return
        settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort)
        void worker.terminate().then(() => error ? reject(error) : resolve(result(value)), reject)
      }
      const abort = () => finish(signal.reason || new Error('搜索已停止'))
      const timer = setTimeout(() => finish(null, { ...progress, complete: false, stopReason: 'scanLimit', limitReached: false, nextStep }), SEARCH_MS)
      worker.on('message', message => {
        if (message.type === 'progress') progress = message.value
        else if (message.type === 'result') finish(null, message.value)
        else if (message.type === 'error') finish(new Error(message.message))
      })
      worker.once('error', finish)
      worker.once('exit', () => { if (!settled) finish(new Error('搜索进程意外结束，请缩小范围后重试。')) })
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  } finally { release() }
}

async function searchFiles(name, cwd, args, update) {
  const root = localPath(cwd, args.path), limit = Math.min(500, Math.max(1, Math.floor(args.limit || 100)))
  const maxEntries = Math.min(200000, Math.max(1, Math.floor(args.maxEntries || 20000)))
  const results = [], skipped = skippedCounts()
  let scanned = 0, stopReason = null, lastUpdate = 0
  const started = performance.now()
  const snapshot = () => ({ root, results, scanned, skipped })
  const progress = () => { if (performance.now() - lastUpdate > 200) { lastUpdate = performance.now(); update(snapshot()) } }
  const match = (value, pattern) => matchesGlob(args.ignoreCase ? value.toLowerCase() : value, args.ignoreCase ? pattern.toLowerCase() : pattern)
  let regex
  try { regex = name === 'grep' ? new RegExp(args.literal ? args.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : args.pattern, args.ignoreCase ? 'i' : '') : null }
  catch { throw new Error('搜索表达式无效；按普通文字搜索时请设置 literal: true。') }
  let rootInfo
  try { rootInfo = await stat(root) } catch { throw new Error('无法访问搜索位置，请核对路径和系统访问权限。') }
  if (!rootInfo.isDirectory() && !rootInfo.isFile()) throw new Error('搜索位置必须是普通文件或文件夹。')
  const queue = [{ path: root, directory: rootInfo.isDirectory(), depth: 0 }]
  update(snapshot())
  for (let cursor = 0; cursor < queue.length; cursor++) {
    if (scanned >= maxEntries || performance.now() - started > SEARCH_MS) { stopReason = 'scanLimit'; break }
    progress()
    const item = queue[cursor]
    scanned++
    const rel = relative(root, item.path).replaceAll('\\', '/') || basename(item.path)
    if (name === 'find' && (match(rel, args.pattern) || match(basename(item.path), args.pattern))) results.push(item.path)
    if (results.length >= limit) { stopReason = 'resultLimit'; break }
    if (item.directory) {
      if (item.depth >= 64) { skipped.directories++; continue }
      try {
        for await (const entry of await opendir(item.path)) {
          progress()
          if (entry.isSymbolicLink()) { skipped.symlinks++; continue }
          if (['.git', 'node_modules', '.Trash'].includes(entry.name)) { skipped.directories++; continue }
          if (entry.isDirectory() || entry.isFile()) {
            if (queue.length >= maxEntries) { stopReason = 'scanLimit'; break }
            queue.push({ path: join(item.path, entry.name), directory: entry.isDirectory(), depth: item.depth + 1 })
          }
        }
      } catch { skipped.unreadable++ }
    } else if (regex) {
      if (args.glob && !match(rel, args.glob) && !match(basename(item.path), args.glob)) continue
      let bytes, handle
      try {
        handle = await open(item.path, constants.O_RDONLY | (constants.O_NONBLOCK || 0))
        const info = await handle.stat()
        if (!info.isFile()) { skipped.unreadable++; continue }
        if (info.size > MAX_FILE_BYTES) { skipped.large++; continue }
        let buffer = Buffer.alloc(Math.min(MAX_FILE_BYTES + 1, Math.max(1024, info.size + 1)))
        let length = 0
        while (length <= MAX_FILE_BYTES) {
          if (length === buffer.length) { const expanded = Buffer.alloc(Math.min(MAX_FILE_BYTES + 1, buffer.length * 2)); buffer.copy(expanded); buffer = expanded }
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
          if (!bytesRead) break
          length += bytesRead
        }
        if (length > MAX_FILE_BYTES) { skipped.large++; continue }
        bytes = buffer.subarray(0, length)
      } catch { skipped.unreadable++; continue }
      finally { await handle?.close() }
      // UTF-16 text has NUL bytes even when it is not binary. Honor an explicit
      // BOM and let Node decode it; TextDecoder also strips a UTF-8 BOM so it
      // cannot hide the first line from anchored expressions.
      const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : undefined
      if (!encoding && bytes.subarray(0, 8192).includes(0)) { skipped.binary++; continue }
      const text = new TextDecoder(encoding || 'utf-8').decode(bytes)
      if (encoding && text.slice(0, 4096).includes('\0')) { skipped.binary++; continue }
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length && results.length < limit; i++) {
        const match = regex.exec(lines[i])
        if (match) results.push(`${item.path}:${i + 1}: ${matchPreview(lines[i], match)}`)
      }
      if (results.length >= limit) { stopReason = 'resultLimit'; break }
    }
  }
  const complete = !stopReason && !Object.values(skipped).some(Boolean)
  return { ...snapshot(), complete, stopReason, limitReached: stopReason === 'resultLimit', ...(!complete ? { nextStep } : {}) }
}

if (!isMainThread && workerData?.kind === 'miaoimg.local-search') {
  void searchFiles(workerData.name, workerData.cwd, workerData.args, value => parentPort.postMessage({ type: 'progress', value })).then(
    value => parentPort.postMessage({ type: 'result', value }),
    error => parentPort.postMessage({ type: 'error', message: error.message || '搜索未完成' }),
  )
}
