// 技能包解压：只支持普通 ZIP（存储 / Deflate）与 tar / tar.gz，全部手写解析，
// 不引第三方依赖。设计原则与上游一致：先把目录和声明大小校验干净，再限量解压，
// 单个条目必须通过 CRC 校验，压缩包本身不落磁盘。
import { crc32, gunzipSync, inflateRawSync } from 'node:zlib'
import { failure } from './management-store.ts'

export const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024
const MAX_ENTRIES = 2000
const ZIP_END_MIN = 22
const ZIP_END_SCAN = 65557
const TAR_BLOCK = 512

function invalid(message, status = 422) {
  return failure(message, status)
}

// 技能包内的相对路径：拒绝空段、. / ..、反斜杠和绝对路径。
function safeEntryPath(value) {
  const path = String(value || '').replace(/^(\.\/)+/, '').replace(/\/+$/, '')
  if (!path) return ''
  if (path.length > 1024) throw invalid('技能包包含过长的文件路径')
  if (path.split('/').some(part => !part || part === '.' || part === '..' || /[\\\0]/.test(part))) {
    throw invalid('技能包包含不安全的文件路径')
  }
  return path
}

// 统一登记目录与文件，挡住重名、同名不同大小写、以及路径前缀冲突。
function createPathRegistry() {
  const seen = new Map()
  return (original, directory) => {
    const path = safeEntryPath(original)
    const parts = path ? path.split('/') : []
    if (seen.size > MAX_ENTRIES * 4) throw invalid(`技能包最多包含 ${MAX_ENTRIES} 个文件和目录`)
    for (let index = 1; index <= parts.length; index += 1) {
      const nested = parts.slice(0, index).join('/')
      const isDirectory = index < parts.length || directory
      const key = nested.toLowerCase()
      const existing = seen.get(key)
      // Directories can be implicit parents before their explicit entry arrives.
      // A regular file must be declared exactly once, without last-entry wins.
      if (existing && (existing.path !== nested || existing.directory !== isDirectory || !isDirectory)) throw invalid('技能包包含冲突的文件或目录路径')
      seen.set(key, { path: nested, directory: isDirectory })
    }
    return path
  }
}

function decodeUtf8(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw invalid('技能包里的文件名不是有效的 UTF-8 编码') }
}

// ZIP：从尾部定位中央目录，逐条比对本地文件头，最后按 CRC 校验解压结果。
export function readZipEntries(bytes) {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (data.length < ZIP_END_MIN) throw invalid('ZIP 技能包内容过短')
  let end = -1
  for (let cursor = data.length - ZIP_END_MIN; cursor >= Math.max(0, data.length - ZIP_END_SCAN); cursor -= 1) {
    if (data.readUInt32LE(cursor) === 0x06054b50 && cursor + ZIP_END_MIN + data.readUInt16LE(cursor + 20) === data.length) { end = cursor; break }
  }
  if (end < 0) throw invalid('ZIP 技能包结尾无效，请用普通 ZIP 重新打包')
  const count = data.readUInt16LE(end + 10)
  const start = data.readUInt32LE(end + 16)
  if (data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6) || data.readUInt16LE(end + 8) !== count
    || count === 0xffff || start + data.readUInt32LE(end + 12) !== end) {
    throw invalid('请使用未分卷的普通 ZIP 技能包，不支持 ZIP64')
  }
  if (!count) throw invalid('ZIP 技能包是空的')
  if (count > MAX_ENTRIES) throw invalid(`技能包最多包含 ${MAX_ENTRIES} 个文件和目录`)
  const entryPath = createPathRegistry()
  const entries = []
  let total = 0
  let offset = start
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > end || data.readUInt32LE(offset) !== 0x02014b50) throw invalid('ZIP 技能包目录无效')
    const flags = data.readUInt16LE(offset + 8)
    const method = data.readUInt16LE(offset + 10)
    const checksum = data.readUInt32LE(offset + 16)
    const compressed = data.readUInt32LE(offset + 20)
    const size = data.readUInt32LE(offset + 24)
    const nameLength = data.readUInt16LE(offset + 28)
    const extraLength = data.readUInt16LE(offset + 30)
    const commentLength = data.readUInt16LE(offset + 32)
    const next = offset + 46 + nameLength + extraLength + commentLength
    const header = data.readUInt32LE(offset + 42)
    if (next > end || header + 30 > start) throw invalid('ZIP 技能包文件头无效')
    if (flags & ~0x080e || ![0, 8].includes(method)) throw invalid('ZIP 技能包不能加密，仅支持存储或 Deflate 压缩')
    const attributes = data.readUInt32LE(offset + 38)
    const kind = (attributes >>> 16) & 0xf000
    if (![0, 0x4000, 0x8000].includes(kind)) throw invalid('ZIP 技能包不能包含链接、设备或其他特殊文件')
    const original = decodeUtf8(data.subarray(offset + 46, offset + 46 + nameLength))
    const directory = original.endsWith('/') || Boolean(attributes & 0x10) || kind === 0x4000
    const path = entryPath(original, directory)
    total += size
    if (size === 0xffffffff || compressed === 0xffffffff || total > MAX_ARCHIVE_BYTES) throw invalid('技能包解压后不能超过 20 MB', 413)
    if ((directory && size !== 0) || (method === 0 && compressed !== size)) throw invalid('ZIP 技能包文件大小无效')
    if (data.readUInt32LE(header) !== 0x04034b50 || data.readUInt16LE(header + 6) !== flags
      || data.readUInt16LE(header + 8) !== method || data.readUInt16LE(header + 26) !== nameLength) throw invalid('ZIP 技能包条目不一致')
    const content = header + 30 + nameLength + data.readUInt16LE(header + 28)
    if (content + compressed > start
      || !data.subarray(header + 30, header + 30 + nameLength).equals(data.subarray(offset + 46, offset + 46 + nameLength))) {
      throw invalid('ZIP 技能包条目不一致')
    }
    if (!(flags & 8) && (data.readUInt32LE(header + 14) !== checksum || data.readUInt32LE(header + 18) !== compressed
      || data.readUInt32LE(header + 22) !== size)) throw invalid('ZIP 技能包条目大小或校验值不一致')
    entries.push({ path, directory, size, checksum, method, start: content, end: content + compressed, header })
    offset = next
  }
  if (offset !== end) throw invalid('ZIP 技能包目录长度不一致')
  entries.sort((first, second) => first.header - second.header)
  const files = new Map()
  let previousEnd = 0
  for (const entry of entries) {
    if (entry.header < previousEnd) throw invalid('ZIP 技能包包含重叠条目')
    previousEnd = entry.end
    let content
    try {
      const compressed = data.subarray(entry.start, entry.end)
      content = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.size) })
    } catch { throw invalid('ZIP 技能包损坏或实际解压大小超过声明值') }
    if (content.byteLength !== entry.size || crc32(content) !== entry.checksum) throw invalid('ZIP 技能包文件大小或校验值错误')
    // 打包工具会塞进来的系统垃圾直接忽略，不算条目，也不落盘。
    if (!entry.directory && !entry.path.startsWith('__MACOSX/') && entry.path.split('/').at(-1) !== '.DS_Store') files.set(entry.path, content)
  }
  return files
}

// tar / tar.gz：校验 USTAR 头与校验和，只接受普通文件与目录。
export function readTarEntries(bytes) {
  let tar = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (tar[0] === 0x1f && tar[1] === 0x8b) {
    try { tar = gunzipSync(tar, { maxOutputLength: MAX_ARCHIVE_BYTES }) }
    catch { throw invalid('技能压缩包解压后不能超过 20 MB，或 gzip 数据已损坏', 413) }
  }
  if (tar.length > MAX_ARCHIVE_BYTES) throw invalid('技能包解压后不能超过 20 MB', 413)
  if (!tar.length || tar.length % TAR_BLOCK !== 0) throw invalid('技能压缩包格式无效，请使用 tar 或 tar.gz')
  const entryPath = createPathRegistry()
  const files = new Map()
  const declared = []
  const field = (header, start, length) => {
    const slice = header.subarray(start, start + length)
    const zero = slice.indexOf(0)
    return decodeUtf8(slice.subarray(0, zero < 0 ? slice.length : zero))
  }
  for (let offset = 0; offset < tar.length;) {
    const header = tar.subarray(offset, offset + TAR_BLOCK)
    if (header.every(byte => byte === 0)) {
      if (tar.subarray(offset).some(byte => byte !== 0)) throw invalid('技能包结尾包含额外数据')
      break
    }
    const checksumField = field(header, 148, 8).trim()
    const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0)
    const sizeField = field(header, 124, 12).trim()
    if (!/^[0-7]+$/.test(checksumField) || Number.parseInt(checksumField, 8) !== sum) throw invalid('技能包校验和不匹配，压缩包可能已损坏')
    if (!/^[0-7]+$/.test(sizeField)) throw invalid('技能包文件头无效')
    const size = Number.parseInt(sizeField, 8)
    const directory = header[156] === 53
    if (![0, 48, 53].includes(header[156])) throw invalid('技能包不能包含链接、设备或 PAX/GNU 扩展条目，请使用普通 tar 格式')
    if ((directory && size !== 0) || offset + TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK > tar.length) throw invalid('技能包文件大小无效')
    const prefix = field(header, 257, 6) === 'ustar' ? field(header, 345, 155) : ''
    const path = entryPath([prefix, field(header, 0, 100)].filter(Boolean).join('/'), directory)
    if (declared.length >= MAX_ENTRIES) throw invalid(`技能包最多包含 ${MAX_ENTRIES} 个文件和目录`)
    declared.push({ path, directory, size })
    if (!directory) files.set(path, Buffer.from(tar.subarray(offset + TAR_BLOCK, offset + TAR_BLOCK + size)))
    offset += TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
  }
  const expected = declared.filter(entry => !entry.directory).length
  if (files.size !== expected) throw invalid('技能包条目不完整')
  return files
}

// 按扩展名选解析器；.md 当作只有一个 SKILL.md 的包。
export function readSkillPackage(fileName, bytes) {
  const name = String(fileName || '').toLowerCase()
  if (name.endsWith('.md')) return new Map([['SKILL.md', Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)]])
  if (name.endsWith('.zip')) return readZipEntries(bytes)
  if (name.endsWith('.tar.gz') || name.endsWith('.tgz') || name.endsWith('.tar')) return readTarEntries(bytes)
  throw invalid('请选择 .md、.zip、.tar、.tar.gz 或 .tgz 技能文件')
}
