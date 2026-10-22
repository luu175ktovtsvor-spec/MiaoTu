#!/usr/bin/env node
// 媒体对账：索引（数据库）和字节（MEDIA_ROOT 磁盘）两边核对。
//
//   node server/media-reconcile.ts                    # 只报告（默认）
//   node server/media-reconcile.ts --report           # 同上
//   node server/media-reconcile.ts --verify-hashes    # 额外把每个 blob 的内容重算一遍 sha 核对文件名（要全量读盘）
//   node server/media-reconcile.ts --fix              # 回收无引用的字节（索引对应的字节一个不动）
//   node server/media-reconcile.ts --vacuum           # 迁移后把数据库文件真正缩回去（会重写整库，找空闲时段跑）
//
// 字节现在是内容寻址的（<账号>/_blobs/<sha256>），索引里的 path 只活在库里。
// 所以对账的两个方向变成了「引用 ↔ 字节」：
//
//   ① 引用在、字节没了  —— **严重**。这是数据丢失：用户看得见那张图，点开是 404/410。
//                          只报告、绝不自动处理（字节删了就是删了，没有别的副本能补回来）。
//   ② 字节在、引用没了  —— 泄漏。通常是崩溃残留；--fix 回收（守宽限期，见下）。
//   ③ 大小不一致        —— 行里的 size 和 blob 实际字节数对不上（索引被改坏或字节被截断）。
//   ④ 内容与文件名不符  —— 仅 --verify-hashes：blob 的实际 sha256 ≠ 它的文件名，字节被改过或写坏了。
//   ⑤ 旧布局残留        —— 路径树上还有实体文件、或 _artifacts/ 里还有东西：内容寻址迁移没跑完。
//   ⑥ 未迁移的行        —— storage='db'，字节还在数据库的 bytes 列里，重启服务会继续搬。
//
// 宽限期：最近 BLOB_GC_GRACE_MS（300 秒）内变化的文件暂不回收；有效接收锁也跳过。
// 删除前在数据库写锁下重查引用与文件身份，流式临时文件还须取得同一份接收锁。
// 扫描结果不能证明删除时仍然没有引用，也不能把尚未发布索引的上传当成垃圾。
//
// 退出码：有未处理的不一致时 1，一切正常或 --fix 已清干净时 0（方便挂到定时任务上看告警）。
import { lstatSync, readdirSync, realpathSync, rmdirSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ARTIFACT_DIRECTORY, BLOB_DIRECTORY, isReservedMediaDirectory, listArtifactFiles, mediaRoot, isMediaImport, MEDIA_WRITE_LOCK_OPTIONS } from './media-files.ts'
import { BLOB_GC_GRACE_MS, MEDIA_LAYOUT_BLOB, BlobStore, isBlobHash, mediaLayout } from './blob-store.ts'
import { DEFAULT_PROJECT_ID, tableColumns } from './projects.ts'
import lockfile from 'proper-lockfile'

const SAMPLE_LIMIT = 30
const args = new Set(process.argv.slice(2))
const fix = args.has('--fix')
const verifyHashes = args.has('--verify-hashes')
const maintenance = process.env.OIP_MANAGEMENT_DB || join(process.env.OIP_DATA_DIR || 'data', 'management.sqlite')
const root = mediaRoot()
const snapshot = info => ({ size: info.size, dev: info.dev, ino: info.ino, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs })
const recent = info => Date.now() - Math.max(info.mtimeMs, info.ctimeMs) < BLOB_GC_GRACE_MS
const stillWriting = file => recent(file) || (isMediaImport(file.full) && lockfile.checkSync(file.full, MEDIA_WRITE_LOCK_OPTIONS))
const importLocks = new Map<string, any>()

// Reporting stays read-only. --fix takes short SQLite write locks while it
// rechecks references and removes bytes; it never changes business rows.
function openDatabase(path) {
  if (!statSync(path).isFile()) throw new Error('媒体数据库路径不是文件')
  return new DatabaseSync(path, { readOnly: !fix })
}

// 逐个账号目录遍历：files 是磁盘上的文件，directories 是磁盘上的目录
// （目录行 mime=inode/directory 在路径树布局下就是真实目录，不算“文件缺失”）。
//
// 遍历**顶层**时跳过保留目录（_blobs / _artifacts / .agent-sessions）：这些是我们的存储内部
// 目录，不是工作区文件。漏掉这一条会让对账把 blob 桶里的字节当成「磁盘有、索引无」的孤儿文件，
// 而 --fix 会照着这份清单把它们删掉——回滚到路径树布局之后 blob 桶还在盘上，正好撞上这条。
// （.agent-sessions 就被这样当成账号目录走过一轮。）
function walk(directory, base = directory, found: Record<string, any> = { files: [], directories: new Set() }, depth = 0) {
  let entries
  try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return found }
  for (const entry of entries) {
    const full = join(directory, entry.name)
    let info
    try { info = lstatSync(full) } catch { continue }
    // 软链一律不跟随、不统计、不删除：写入不会产生软链，出现了就该人工看。
    if (info.isSymbolicLink()) continue
    if (depth === 0 && info.isDirectory() && (isReservedMediaDirectory(entry.name) || entry.name.startsWith('.'))) continue
    const path = relative(base, full).split(sep).join('/')
    if (info.isDirectory()) {
      if (entry.name.endsWith('.lock') && isMediaImport(entry.name.slice(0, -5))) { importLocks.set(full.slice(0, -5), snapshot(info)); continue }
      found.directories.add(path); walk(full, base, found, depth + 1); continue
    }
    if (info.isFile()) found.files.push({ path, full, ...snapshot(info) })
  }
  return found
}

function pruneEmptyDirectories(directory, stopAt) {
  let current = directory
  while (current !== stopAt && current.startsWith(stopAt + sep)) {
    try { rmdirSync(current) } catch { return }
    current = dirname(current)
  }
}

function sample(list, format) {
  for (const item of list.slice(0, SAMPLE_LIMIT)) console.log(`    ${format(item)}`)
  if (list.length > SAMPLE_LIMIT) console.log(`    …… 其余 ${list.length - SAMPLE_LIMIT} 条省略`)
}

const db = openDatabase(maintenance)
if (fix) db.exec('PRAGMA busy_timeout=5000')
function finish(code) { db.close(); process.exit(code) }
// mediaLayout / tableColumns 这些公共函数要的是 store 形状（get/all），这里给只读连接包一层薄壳。
const storeView = {
  get: (sql, ...values) => db.prepare(sql).get(...values),
  all: (sql, ...values) => db.prepare(sql).all(...values),
  run: () => { throw new Error('对账是只读的') },
}
const exists = name => Boolean(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?").get(name))
if (!exists('workspace_files')) {
  console.log(`数据库里还没有 workspace_files 表（${maintenance}），没有可比对的索引。`)
  finish(0)
}
const layout = mediaLayout(storeView)

// 老库（还没跑过新版服务）没有 storage / size / blob 列，这里用旧口径顶上，
// 这样对账脚本可以先于迁移运行，把每一行都报成「未迁移」而不是直接崩掉。
const columns = new Set(tableColumns(storeView, 'workspace_files'))
const projectScoped = columns.has('project_id')
const hasBlob = columns.has('blob')
const project = projectScoped ? 'project_id' : `'${DEFAULT_PROJECT_ID}' AS project_id`
const size = columns.has('size') ? 'size' : 'length(bytes) AS size'
const storage = columns.has('storage') ? 'storage' : "'db' AS storage"
const blob = hasBlob ? 'blob' : 'NULL AS blob'
const rows = db.prepare(`SELECT user_id,${project},path,mime,${size},${storage},${blob} FROM workspace_files ORDER BY user_id,path`).all()
const indexKey = (userId, project) => `${userId}\0${project}`
const index = new Map()
for (const row of rows) {
  const key = indexKey(row.user_id, row.project_id)
  if (!index.has(key)) index.set(key, new Map())
  index.get(key).set(row.path, row)
}
// projects 表决定 <账号>/<目录> 算不算项目目录。没有这张表（或还是单项目结构）时整体按旧布局对账，
// 免得把用户自己建的普通文件夹误判成项目。
const projectIds = new Map()
let projectLayout = false
if (projectScoped) {
  try {
    for (const row of db.prepare('SELECT user_id,id FROM projects').all()) {
      if (!projectIds.has(row.user_id)) projectIds.set(row.user_id, new Set())
      projectIds.get(row.user_id).add(row.id)
    }
    projectLayout = projectIds.size > 0
  } catch { projectLayout = false }
}

// ---- 生成结果（artifacts）索引 ----
const artifactColumns = new Set(tableColumns(storeView, 'artifacts'))
const artifactRows = artifactColumns.size
  ? db.prepare(`SELECT a.id AS id,a.request_id AS request_id,
      ${artifactColumns.has('size') ? 'a.size' : 'length(a.bytes)'} AS size,
      ${artifactColumns.has('storage') ? 'a.storage' : "'db'"} AS storage,
      ${artifactColumns.has('blob') ? 'a.blob' : 'NULL'} AS blob
    FROM artifacts a`).all()
  : []

const missing = []          // ① 引用在、字节没了
const mismatched = []       // ③ 大小不一致
const corrupted = []        // ④ 内容与文件名不符
const leaked = []           // ② 字节在、引用没了
const fresh = []            // ② 的宽限期内子集：还不能判定，下次对账再看
const strays = []           // 桶里不是 blob 的文件（tmp 残留等）
const leftovers = []        // 路径树布局下桶里没人引用的字节：--link-only 的成果或 --rollback 的残留
const legacyTree = []       // ⑤ 索引行已指向 blob、路径树上的旧文件却没删掉（回收没跑完）
const treeOrphans = []      // ⑤ 磁盘上有、索引里根本没有（迁移前就存在的孤儿文件，--fix 可清）
const pendingTree = []      // ⑤ 行还在路径树上（迁移没跑完，或服务端还没重启）：**绝不能删文件**
const missingTree = []      // 旧口径：索引在、路径树上找不到（只在路径树布局下有意义）
const mismatchedTree = []
const orphanTree = []
const loose = []
const unmigrated = []
const artifactMissing = []
const artifactMismatched = []
const artifactLegacy = []
const artifactUnmigrated = []
let looseBytes = 0

// 引用计数：两份索引合起来才是活跃集合。存计数列会漂移，每次查才作数。
const blobStore = new BlobStore(storeView)
const liveCount = (sha, userId) => blobStore.liveCount(sha, userId)

// ---- 引用 → 字节：① ③ ④ ----
// 每一行引用都要能在自己的桶里找到字节。目录行没有字节，跳过。
const buckets = new Map()   // `${userId}\0${sha}` → 磁盘上的信息
const bucketLists = new Map()
const scanBucket = (userId) => {
  const directory = userId ? join(root, userId, BLOB_DIRECTORY) : join(root, BLOB_DIRECTORY)
  if (bucketLists.has(userId)) return bucketLists.get(userId)
  const blobs = new Map()
  const localStrays = []
  let entries = []
  try { entries = readdirSync(directory, { withFileTypes: true }) } catch { entries = [] }
  for (const entry of entries) {
    const full = join(directory, entry.name)
    let info
    try { info = lstatSync(full) } catch { continue }
    if (info.isSymbolicLink() || !info.isFile()) continue
    if (!isBlobHash(entry.name)) { localStrays.push({ userId, path: entry.name, full, ...snapshot(info) }); continue }
    blobs.set(entry.name, { userId, sha: entry.name, full, ...snapshot(info), nlink: info.nlink })
  }
  bucketLists.set(userId, blobs)
  for (const item of localStrays) (stillWriting(item) ? fresh : strays).push(item)
  return blobs
}

// **先扫盘、再查引用**（顺序不能反，也不只是为了效率）：一个桶里如果一行引用都不剩
// （所有行都删了、账号被清掉），只按「引用」去找桶的话它永远不会被扫到，里面的字节就成了
// 对账看不见的泄漏。所以先把磁盘上所有桶读完，再拿引用去对。
const allBuckets = new BlobStore(storeView).buckets()
for (const bucket of allBuckets) scanBucket(bucket.userId)

for (const row of rows) {
  if (row.storage === 'db' || (!row.blob && row.storage !== 'disk')) { unmigrated.push({ userId: row.user_id, project: row.project_id, path: row.path }); continue }
  if (!row.blob) continue                       // 路径树布局的行：走下面那一段老核对
  const found = scanBucket(row.user_id).get(row.blob)
  if (!found) { missing.push({ kind: '工作区文件', userId: row.user_id, project: row.project_id, path: row.path, sha: row.blob, size: Number(row.size) }); continue }
  if (Number(row.size) !== found.size) mismatched.push({ kind: '工作区文件', userId: row.user_id, project: row.project_id, path: row.path, sha: row.blob, expected: Number(row.size), actual: found.size })
  buckets.set(`${row.user_id}\0${row.blob}`, found)
}

// artifacts 的桶按归属账号（generations.user_id），没有归属的落在根级桶里。
const artifactOwner = new Map()
for (const row of artifactRows) {
  let userId = ''
  try { userId = String(db.prepare('SELECT user_id FROM generations WHERE id=?').get(row.request_id)?.user_id || '') } catch { userId = '' }
  artifactOwner.set(row.id, userId)
  if (row.storage === 'db' || (!row.blob && row.storage !== 'disk')) { artifactUnmigrated.push(row); continue }
  if (!row.blob) continue
  const found = scanBucket(userId).get(row.blob)
  if (!found) { missing.push({ kind: '生成结果', userId: userId || '(无归属)', id: row.id, sha: row.blob, size: Number(row.size) }); continue }
  if (Number(row.size) !== found.size) mismatched.push({ kind: '生成结果', id: row.id, userId, sha: row.blob, expected: Number(row.size), actual: found.size })
  buckets.set(`${userId}\0${row.blob}`, found)
}

// ---- 字节 → 引用：② ④ ----
for (const [userId, blobs] of bucketLists) {
  for (const item of blobs.values()) {
    if (liveCount(item.sha, userId) === 0) {
      // 路径树布局下「没有人引用」不是异常：这些字节是 --link-only 建好的成果
      // （索引还没回填），或者 --rollback 的残留（字节仍然在路径树上，和桶里这份是同一个
      // inode，删了也不省空间、更不该在这里删）。**不当泄漏报，--fix 也一个都不动**——
      // 否则一次误跑就会把刚建好、还没回填的迁移成果清掉。
      if (layout !== MEDIA_LAYOUT_BLOB) { leftovers.push(item); continue }
      if (recent(item)) fresh.push(item)
      else leaked.push(item)
    }
    if (verifyHashes) {
      try {
        const actual = createHash('sha256').update(readFileSync(item.full)).digest('hex')
        if (actual !== item.sha) corrupted.push({ ...item, actual })
      } catch (error) {
        corrupted.push({ ...item, actual: `读取失败：${error?.message || error}` })
      }
    }
  }
}

// ---- 路径树（迁移前的老布局）：索引有磁盘缺 / 大小不一致 / 孤儿文件 ----
// 内容寻址之后路径树是空的，这一段自然什么都不报；它保留是为了迁移前和 --rollback 之后仍然可用。
let diskFiles = 0
let diskBytes = 0
const treeRows = rows.filter(row => !row.blob)
const treeIndex = new Map()
for (const row of treeRows) {
  const key = indexKey(row.user_id, row.project_id)
  if (!treeIndex.has(key)) treeIndex.set(key, new Map())
  treeIndex.get(key).set(row.path, row)
}
function compareProject(userId, projectId_, dir) {
  const seen = new Set()
  const { files, directories } = walk(dir)
  for (const file of files) {
    diskFiles += 1
    diskBytes += file.size
    seen.add(file.path)
    const row = treeIndex.get(indexKey(userId, projectId_))?.get(file.path)
    if (!row) { (stillWriting(file) ? fresh : orphanTree).push({ userId, project: projectId_, ...file }); continue }
    if (row.storage === 'disk' && Number(row.size) !== file.size) mismatchedTree.push({ userId, project: projectId_, path: file.path, expected: Number(row.size), actual: file.size })
  }
  for (const row of treeIndex.get(indexKey(userId, projectId_))?.values() || []) {
    if (row.storage !== 'disk') continue
    if (row.mime === 'inode/directory' ? !directories.has(row.path) : !seen.has(row.path)) missingTree.push({ userId, project: projectId_, path: row.path, size: Number(row.size) })
  }
}
// 整个路径树只在「有人还在用路径树」时才走：内容寻址布局下盘上不该有这些文件，
// 真有的话属于 ⑤ 旧布局残留，在下面单独报。
const treeInUse = layout !== MEDIA_LAYOUT_BLOB || treeRows.some(row => row.storage === 'disk')
const userDirectories = (() => {
  try { return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && !isReservedMediaDirectory(entry.name) && !entry.name.startsWith('.')) } catch { return [] }
})()

for (const directory of userDirectories) {
  const userId = directory.name
  const userRoot = join(root, userId)
  if (layout === MEDIA_LAYOUT_BLOB) {
    // 内容寻址布局：账号目录下只该有 _blobs/（和迁移没清干净的旧目录）。
    // 这里分两类，处置完全不同：
    //   - 索引行在、已经指向 blob，文件却没删 = 迁移的回收阶段没跑完 → 人工确认后删（--fix 不动）；
    //   - 索引里根本没有这一行 = 迁移前就存在的孤儿文件 → --fix 按老规矩清掉。
    // 混成一类的话，运维会看到「请先跑迁移」而去重跑一个已经跑完的迁移。
    const lookup = (relative) => {
      if (projectScoped) {
        const at = relative.indexOf('/')
        if (at < 0) return null
        return index.get(indexKey(userId, relative.slice(0, at)))?.get(relative.slice(at + 1)) || null
      }
      return index.get(indexKey(userId, DEFAULT_PROJECT_ID))?.get(relative) || null
    }
    for (const entry of readdirSync(userRoot, { withFileTypes: true })) {
      if (isReservedMediaDirectory(entry.name) || entry.name.startsWith('.')) continue
      const full = join(userRoot, entry.name)
      const found = entry.isDirectory()
        ? walk(full).files.map(file => ({ ...file, path: `${entry.name}/${file.path}` }))
        : (() => { try { const info = lstatSync(full); return info.isFile() ? [{ path: entry.name, full, ...snapshot(info) }] : [] } catch { return [] } })()
      for (const file of found) {
        const row = lookup(file.path)
        // 三种情况，处置完全不同：
        //   行在、已指向 blob → 回收没跑完（人工确认后删）；
        //   行在、还没指向 blob → **这一行的字节就只有路径树上这一份，删了就是数据丢失**，
        //     多半是服务端还在按旧布局写（没重启）或者 --apply 没跑完；只报告，绝不删；
        //   行根本不在 → 迁移前就存在的孤儿文件，--fix 按老规矩清掉。
        if (row?.blob) legacyTree.push({ userId, path: file.path, full: file.full, size: file.size })
        else if (row) pendingTree.push({ userId, path: file.path, full: file.full, size: file.size })
        else (stillWriting(file) ? fresh : treeOrphans).push({ userId, ...file })
        looseBytes += file.size
      }
    }
    continue
  }
  if (!treeInUse) continue
  if (!projectLayout) { compareProject(userId, DEFAULT_PROJECT_ID, userRoot); continue }
  for (const entry of readdirSync(userRoot, { withFileTypes: true })) {
    if (isReservedMediaDirectory(entry.name) || entry.name.startsWith('.')) continue
    const full = join(userRoot, entry.name)
    const known = projectIds.get(userId)?.has(entry.name) || treeIndex.has(indexKey(userId, entry.name))
    if (entry.isDirectory() && known) { compareProject(userId, entry.name, full); continue }
    if (entry.isDirectory()) {
      const { files } = walk(full)
      if (!files.length) { loose.push({ userId, path: entry.name, full, size: 0, kind: 'directory' }); continue }
      for (const file of files) { loose.push({ userId, path: `${entry.name}/${file.path}`, full: file.full, size: file.size, kind: 'file' }); looseBytes += file.size }
      continue
    }
    let size_ = 0
    try { size_ = statSync(full).size } catch { /* 刚好被删掉，按 0 报 */ }
    loose.push({ userId, path: entry.name, full, size: size_, kind: 'file' })
    looseBytes += size_
  }
}
// 整个用户目录都不在磁盘上的行。
for (const [key, files] of treeIndex) {
  const [userId, projectId_] = key.split('\0')
  if (userDirectories.some(entry => entry.name === userId)) continue
  for (const row of files.values()) {
    if (row.storage !== 'disk') continue
    missingTree.push({ userId, project: projectId_, path: row.path, size: Number(row.size) })
  }
}

// ---- 生成结果的旧字节缓存 _artifacts/ ----
// 内容寻址布局下这个目录该是空的：里面还有文件就是迁移没跑完（⑤）。
const artifactDisk = listArtifactFiles()
const artifactDiskBytes = artifactDisk.reduce((sum, item) => sum + item.size, 0)
if (layout === MEDIA_LAYOUT_BLOB) {
  for (const file of artifactDisk) artifactLegacy.push({ id: file.id, full: file.full, size: file.size })
} else {
  const artifactSeen = new Set()
  const artifactIndex = new Map(artifactRows.filter(row => !row.blob).map(row => [row.id, row]))
  for (const file of artifactDisk) {
    artifactSeen.add(file.id)
    const row = artifactIndex.get(file.id)
    if (!row) { artifactLegacy.push({ id: file.id, full: file.full, size: file.size, kind: 'orphan' }); continue }
    if (row.storage === 'disk' && Number(row.size) !== file.size) artifactMismatched.push({ id: file.id, expected: Number(row.size), actual: file.size })
  }
  for (const row of artifactIndex.values()) {
    if (row.storage !== 'disk') continue
    if (!artifactSeen.has(row.id)) artifactMissing.push({ id: row.id, size: Number(row.size) })
  }
}

const blobFiles = [...bucketLists.values()].reduce((sum, map) => sum + map.size, 0)
const blobBytes = [...bucketLists.values()].reduce((sum, map) => sum + [...map.values()].reduce((s, item) => s + item.size, 0), 0)
const indexDiskRows = rows.filter(row => row.storage === 'disk')
const indexBlobRows = rows.filter(row => Boolean(row.blob))
const artifactBlobRows = artifactRows.filter(row => Boolean(row.blob))

console.log(`媒体对账（内容寻址）：MEDIA_ROOT=${root}`)
console.log(`  数据库 ${maintenance}`)
console.log(`  布局标记：${layout === MEDIA_LAYOUT_BLOB ? 'blob（字节只在 _blobs/）' : 'path（字节在路径树上，内容寻址迁移还没跑）'}`)
// 目录行（mime=inode/directory）没有字节，在哪套布局下都只活在索引里，单独数出来，
// 免得看报告的人把「路径树 54 行」误读成「还有 54 个文件没搬」。
const directoryRows = rows.filter(row => row.mime === 'inode/directory')
console.log(`  工作区索引 ${rows.length} 行：内容寻址 ${indexBlobRows.length} 行 / ${indexBlobRows.reduce((s, r) => s + Number(r.size), 0)} 字节，路径树 ${indexDiskRows.length - directoryRows.length} 行 / ${indexDiskRows.reduce((s, r) => s + Number(r.size), 0)} 字节，目录行（无字节）${directoryRows.length} 行`)
console.log(`  生成结果索引 ${artifactRows.length} 行：内容寻址 ${artifactBlobRows.length} 行，路径树/库内 ${artifactRows.length - artifactBlobRows.length} 行`)
console.log(`  blob 桶：${bucketLists.size} 个，${blobFiles} 个 blob / ${blobBytes} 字节（逻辑上可省 ${Math.max(0, indexBlobRows.reduce((s, r) => s + Number(r.size), 0) + artifactBlobRows.reduce((s, r) => s + Number(r.size), 0) - blobBytes)} 字节的重复）`)
if (unmigrated.length) console.log(`  未迁移（字节还在数据库里）${unmigrated.length} 行，重启服务会继续迁移`)
if (artifactUnmigrated.length) console.log(`  生成结果未迁移（字节还在数据库里）${artifactUnmigrated.length} 行，重启服务会继续迁移`)
if (layout !== MEDIA_LAYOUT_BLOB) console.log(`  路径树上的实体文件 ${diskFiles} 个 / ${diskBytes} 字节，_artifacts/ ${artifactDisk.length} 个 / ${artifactDiskBytes} 字节`)
if (leftovers.length) console.log(`  桶里的字节（路径树布局下没有人引用是正常的）：${leftovers.length} 个 / ${leftovers.reduce((sum, item) => sum + item.size, 0)} 字节——是 --link-only 的成果或 --rollback 的残留，与路径树上的文件共享 inode，不额外占空间；--fix 不动它们`)
console.log('')

if (missing.length) {
  console.log(`【严重】引用在、字节没了：${missing.length} 个（数据丢失，这些链接会返回 404 / 410）`)
  console.log('  这一类只报告、绝不自动处理：字节删了就是删了，没有别的副本能补回来。')
  sample(missing, item => `${item.kind}  ${item.userId}  ${item.project || ''}  ${item.path || item.id}  blob=${String(item.sha).slice(0, 12)}…  (索引 ${item.size} 字节)`)
}
if (mismatched.length) {
  console.log(`大小不一致：${mismatched.length} 个（索引 size 与 blob 实际字节数不符）`)
  sample(mismatched, item => `${item.kind}  ${item.userId}  ${item.path || item.id}  索引 ${item.expected} / 实际 ${item.actual}`)
}
if (corrupted.length) {
  console.log(`【严重】内容与文件名不符：${corrupted.length} 个（blob 被改过或写坏了）`)
  sample(corrupted, item => `${item.userId || '(无归属)'}  ${item.sha.slice(0, 12)}…  实际 ${String(item.actual).slice(0, 16)}…`)
}
if (leaked.length) {
  console.log(`无引用的字节（泄漏）：${leaked.length} 个 / ${leaked.reduce((s, i) => s + i.size, 0)} 字节`)
  sample(leaked, item => `${item.userId || '(无归属)'}  ${item.sha.slice(0, 12)}…  (${item.size} 字节)`)
}
if (fresh.length) {
  console.log(`写入中或宽限期内、暂不回收：${fresh.length} 个（有效写入锁，或最近 ${Math.round(BLOB_GC_GRACE_MS / 1000)} 秒内发生变化）`)
}
if (strays.length) {
  console.log(`桶里不是 blob 的文件：${strays.length} 个（写入中断留下的临时文件等）`)
  sample(strays, item => `${item.userId || '(无归属)'}  ${item.path}  (${item.size} 字节)`)
}
if (missingTree.length) {
  console.log(`路径树 索引有但磁盘缺：${missingTree.length} 个（这些路径的读接口会返回 404）`)
  sample(missingTree, item => `${item.userId}  ${item.project}  ${item.path}  (索引 ${item.size} 字节)`)
}
if (mismatchedTree.length) {
  console.log(`路径树 大小不一致：${mismatchedTree.length} 个`)
  sample(mismatchedTree, item => `${item.userId}  ${item.project}  ${item.path}  索引 ${item.expected} / 实际 ${item.actual}`)
}
if (orphanTree.length) {
  console.log(`路径树 孤儿文件（磁盘有、索引无）：${orphanTree.length} 个 / ${orphanTree.reduce((s, i) => s + i.size, 0)} 字节`)
  sample(orphanTree, item => `${item.userId}  ${item.project}  ${item.path}  (${item.size} 字节)`)
}
if (legacyTree.length) {
  console.log(`【需要处理】索引已经指向 blob、路径树上的旧文件却还在：${legacyTree.length} 项（迁移的回收阶段没跑完）`)
  console.log('  --fix 不动这一类：确认索引读得回之后手工删，或重跑 node scripts/migrate-media-blobs.ts --apply 收尾')
  sample(legacyTree, item => `${item.userId}  ${item.path}  (${item.size} 字节)`)
}
if (pendingTree.length) {
  console.log(`【需要处理】索引行还挂在路径树上、字节也没进 blob：${pendingTree.length} 项（迁移没跑完，或服务端还在按旧布局写）`)
  console.log('  --fix 绝不碰这一类（这些字节只有盘上这一份）。跑 node scripts/migrate-media-blobs.ts --apply 补齐，并重启一次服务让写入切到 blob。')
  sample(pendingTree, item => `${item.userId}  ${item.path}  (${item.size} 字节)`)
}
if (treeOrphans.length) {
  console.log(`路径树上的孤儿文件（磁盘有、索引无）：${treeOrphans.length} 项 / ${treeOrphans.reduce((sum, item) => sum + item.size, 0)} 字节`)
  sample(treeOrphans, item => `${item.userId}  ${item.path}  (${item.size} 字节)`)
}
if (loose.length) {
  console.log(`不属于任何已知项目的字节：${loose.length} 项 / ${looseBytes} 字节（旧布局还没搬过来的文件，或删项目时没删干净的残留）`)
  console.log('  --fix 不动这一类：要么先跑 scripts/migrate-projects.ts --apply，要么人工确认后手动删')
  sample(loose, item => `${item.userId}  ${item.path}${item.kind === 'directory' ? '（空目录）' : `  (${item.size} 字节)`}`)
}
if (artifactMissing.length) {
  console.log(`生成结果（_artifacts/）索引有但磁盘缺：${artifactMissing.length} 个（这些结果链接会返回 410）`)
  sample(artifactMissing, item => `${item.id}  (索引 ${item.size} 字节)`)
}
if (artifactMismatched.length) {
  console.log(`生成结果（_artifacts/）大小不一致：${artifactMismatched.length} 个`)
  sample(artifactMismatched, item => `${item.id}  索引 ${item.expected} / 实际 ${item.actual}`)
}
if (artifactLegacy.length) {
  console.log(`生成结果的旧字节缓存 _artifacts/ 里还有 ${artifactLegacy.length} 个文件 / ${artifactLegacy.reduce((s, i) => s + i.size, 0)} 字节（迁移没跑完）`)
  sample(artifactLegacy, item => `${item.id}  (${item.size} 字节)`)
}

// 迁移把 bytes 置空后，那些页还留在文件里不还给系统（SQLite 只标记为空闲页）。
// VACUUM 才会真正重写数据库文件、把 100MB 级的库缩回索引大小；会短暂锁库，找空闲时段跑。
if (args.has('--vacuum')) {
  const before = statSync(maintenance).size
  const writable = new DatabaseSync(maintenance)
  writable.exec('VACUUM')
  writable.close()
  const after = statSync(maintenance).size
  console.log('')
  console.log(`--vacuum 完成：${maintenance} ${(before / 1048576).toFixed(1)}MB -> ${(after / 1048576).toFixed(1)}MB`)
}

// A crash between acquiring a receive lease and opening its file can leave
// only the empty lock directory. Let proper-lockfile retire its stale lease.
const abandonedLocks = [...importLocks].filter(([path, info]) => {
  if (recent(info)) return false
  try { lstatSync(path); return false } catch (error) { return error.code === 'ENOENT' }
})
if (abandonedLocks.length) console.log(`无临时文件的过期写入锁：${abandonedLocks.length} 个`)

// 无引用的字节及临时残留归 --fix 处理；其余只报告。
const severe = missing.length + corrupted.length
const reclaimable = leaked.length + strays.length + treeOrphans.length + orphanTree.length + abandonedLocks.length
const manual = mismatched.length + missingTree.length + mismatchedTree.length + loose.length + artifactMissing.length + artifactMismatched.length + legacyTree.length + artifactLegacy.length + pendingTree.length
if (!severe && !reclaimable && !manual) {
  console.log('两边一致，没有需要处理的问题。')
  finish(0)
}

if (!fix) {
  console.log('')
  console.log('以上只是报告。加 --fix 才回收无引用的字节与临时残留（索引对应的字节一个不会被删）。')
  finish(1)
}

// --fix：只回收没人引用的东西。
let removed = 0
let removedBytes = 0
let failed = 0
let skipped = 0
const directories = new Map()
const canonicalRoot = realpathSync(root)
function safeParent(full) {
  const within = relative(root, full)
  return within && within !== '..' && !within.startsWith('..' + sep)
    && realpathSync(dirname(full)) === resolve(canonicalRoot, dirname(within))
}
function transaction(fn) {
  db.exec('BEGIN IMMEDIATE')
  try { const value = fn(); db.exec('COMMIT'); return value }
  catch (error) { db.exec('ROLLBACK'); throw error }
}
function collect(item, bucket) {
  return transaction(() => {
    if (mediaLayout(storeView) !== layout || !safeParent(item.full)) return false
    const current = lstatSync(item.full)
    if (!current.isFile() || recent(current) || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => current[key] !== item[key])) return false
    if (bucket && item.sha) {
      // Reuse the live, owner-scoped reference check under the same write lock
      // used by publishers. A scan result is never permission to delete.
      if (liveCount(item.sha, item.userId)) return false
      if (blobStore.release(item.userId, item.sha)) return true
      if (blobStore.stat(item.userId, item.sha)) throw new Error('字节回收未完成，请查看文件权限和存储状态')
      return false
    }
    if (!bucket) {
      const path = relative(join(root, item.userId), item.full).split(sep).join('/')
      const at = path.indexOf('/')
      const referenced = projectScoped
        ? at >= 0 && db.prepare('SELECT 1 FROM workspace_files WHERE user_id=? AND project_id=? AND path=?').get(item.userId, path.slice(0, at), path.slice(at + 1))
        : db.prepare('SELECT 1 FROM workspace_files WHERE user_id=? AND path=?').get(item.userId, path)
      if (referenced) return false
    }
    let release
    try {
      if (isMediaImport(item.full)) release = lockfile.lockSync(item.full, MEDIA_WRITE_LOCK_OPTIONS)
      rmSync(item.full)
      return true
    } finally { release?.() }
  })
}
function removeCandidate(item, bucket) {
  try {
    if (!collect(item, bucket)) { skipped += 1; return false }
    removed += 1; removedBytes += item.size; return true
  } catch (error) {
    if (['ENOENT', 'ELOCKED'].includes(error.code)) { skipped += 1; return false }
    failed += 1; console.log(`    删除失败，保留待重试：${item.full} ${error?.message || error}`)
    return false
  }
}
// 无引用的 blob 与临时残留：再确认一次落点确实在某个桶目录里（防止路径被拼坏误删别的文件）。
const bucketDirectories = [...bucketLists.keys()].map(userId => userId ? join(root, userId, BLOB_DIRECTORY) : join(root, BLOB_DIRECTORY))
const inBucket = (full) => bucketDirectories.some(directory => full.startsWith(directory + sep))
for (const item of [...leaked, ...strays]) {
  if (!inBucket(item.full)) { console.log(`    跳过（路径不在 blob 桶内）：${item.full}`); continue }
  removeCandidate(item, true)
}
// 路径树孤儿：只删孤儿，删除前再确认一次落点还在 <MEDIA_ROOT>/<账号>/<项目>/ 之内，空目录顺手回收。
for (const item of [...orphanTree, ...treeOrphans]) {
  // 项目布局的孤儿落在 <账号>/<项目>/ 里，内容寻址布局下路径树里可能没有项目这一层，两种都按
  // 「必须在账号目录之内」卡住落点，绝不让一个拼错的路径把别的文件删掉。
  const projectRoot = item.project ? join(root, item.userId, item.project) : join(root, item.userId)
  if (item.full !== resolve(projectRoot, ...item.path.split('/')) || !item.full.startsWith(projectRoot + sep)) {
    console.log(`    跳过（路径不在项目目录内）：${item.full}`)
    continue
  }
  if (removeCandidate(item, false)) directories.set(dirname(item.full), projectRoot)
}
let removedLocks = 0
for (const [path, observed] of abandonedLocks) {
  let release
  try {
    if (!safeParent(path)) continue
    const current = lstatSync(path + '.lock')
    if (!current.isDirectory() || recent(current) || ['dev', 'ino', 'mtimeMs'].some(key => observed[key] !== current[key])) continue
    try { lstatSync(path); continue } catch (error) { if (error.code !== 'ENOENT') throw error }
    release = lockfile.lockSync(path, MEDIA_WRITE_LOCK_OPTIONS)
    release(); release = undefined; removedLocks += 1
  } catch (error) {
    if (!['ENOENT', 'ELOCKED'].includes(error.code)) { failed += 1; console.log(`    写入锁回收失败：${path} ${error?.message || error}`) }
  } finally { release?.() }
}
for (const [directory, projectRoot] of directories) pruneEmptyDirectories(directory, projectRoot)
console.log('')
console.log(`--fix 完成：回收 ${removed} 个 / ${removedBytes} 字节；索引对应的字节一个未动。`)
if (removedLocks) console.log(`回收 ${removedLocks} 个无文件的过期写入锁。`)
if (skipped) console.log(`跳过 ${skipped} 个仍在写入、已被引用或扫描后发生变化的文件。`)
if (failed) console.log(`${failed} 项回收失败，保留待重试。`)
if (severe) console.log(`【严重】仍有 ${severe} 个「引用在、字节没了」或内容不符，需要人工确认（--fix 不处理这一类）。`)
if (manual) console.log(`另有 ${manual} 项需要人工确认（--fix 不动这一类）。`)
finish(severe || manual || failed ? 1 : 0)
