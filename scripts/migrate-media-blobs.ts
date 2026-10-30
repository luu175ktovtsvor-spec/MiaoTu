#!/usr/bin/env node
import { assertLegacySQLiteMaintenance } from './legacy-sqlite-maintenance.ts'
// 媒体字节内容寻址化（把工作区文件与生成结果的字节合并成一份 blob 存储）。
//
//   node scripts/migrate-media-blobs.ts                # 只报账（默认）
//   node scripts/migrate-media-blobs.ts --report       # 同上
//   node scripts/migrate-media-blobs.ts --link-only    # 只建 blob + 校验，表结构一个都不动
//   node scripts/migrate-media-blobs.ts --apply        # 建 blob -> 校验 -> 回填索引 -> 翻布局 -> 回收旧位置
//   node scripts/migrate-media-blobs.ts --rollback     # 反向：从 blob 把字节放回路径树 -> 退回旧布局
//
// 可选：--batch N（进度打印间隔，默认 500）、--allow-missing（放过迁移前就已经缺失的孤儿索引）、
//       --verify-hashes（校验阶段把所有 blob 全量重算一遍 sha，慢但最稳）、
//       --drop-blobs（只给 --rollback：退回旧布局后顺手把 blob 桶清掉）
//
// **搬迁是「先硬链接 → 逐字节校验 → 再删旧位置」，不是 rename。**
// 发布是「备份 → 停旧容器 → 起新容器 → 健康检查 → 失败回滚到旧容器」；rename 搬到一半崩掉，
// 旧布局就只剩一半字节，回滚到旧容器对用户就是文件消失。同一块盘上的硬链接不额外占空间，
// 而且任何时刻两个布局都能完整解析同一份字节：崩在链接阶段旧布局原样可用（直接回滚镜像）；
// 崩在回收阶段新布局已经整份校验过（继续往前跑，或者 --rollback 把路径树重建回来）。
//
// **省下来的空间来自去重**：同一份内容第二次出现时不会再建第二个 inode，回收阶段把多出来的
// 那几份 unlink 掉，磁盘上就只剩一份。真正的空间释放发生在第 5 步，不是第 1 步。
//
// **唯一的不可逆点**是回填索引（第 3 步）：从那一刻起索引行指向 blob，旧镜像读不了
// （它只认路径树）。回滚镜像之前必须先跑 --rollback。
// 可以随便停的安全点是 --link-only：blob 建好校验完、一个源字节没删、表结构一列没动，
// 那一刻旧镜像新镜像都能跑（对应 migrate-projects.ts 的 --copy-only）。
//
// **顺序**：项目迁移（scripts/migrate-projects.ts）必须在前，内容寻址迁移在后。
// 反过来做的话，项目迁移要的路径树已经被这一轮清掉了。两个方向都做了护栏，跑反了会直接拒绝。
//
// 环境变量：OIP_MANAGEMENT_DB（默认 data/management.sqlite）、OIP_MEDIA_ROOT（媒体根目录）。
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { createReadStream, linkSync, lstatSync, mkdirSync, readdirSync, rmdirSync, rmSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { artifactDirectory, mediaRoot } from '../server/media-files.ts'
import { MEDIA_LAYOUT_BLOB, MEDIA_LAYOUT_PATH, BlobStore, blobDirectory, hashBytes, isBlobHash, mediaLayout, setMediaLayout } from '../server/blob-store.ts'
import { DEFAULT_PROJECT_ID, ensureWorkspaceBlobColumn, ensureWorkspaceSchema, tableColumns } from '../server/projects.ts'
import { ensureArtifactSchema } from '../server/artifact-files.ts'

assertLegacySQLiteMaintenance()

const args = process.argv.slice(2)
const has = flag => args.includes(flag)
const option = (name, fallback) => {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback
}
// --link-only 单独给的时候按 --apply 的链接阶段跑（容易少打一个 --apply，不能让它静默变成只报账）。
const mode = has('--rollback') ? 'rollback' : (has('--apply') || has('--link-only')) ? 'apply' : 'report'
const linkOnly = has('--link-only')
const allowMissing = has('--allow-missing')
const verifyHashes = has('--verify-hashes')
const dropBlobs = has('--drop-blobs')
const batch = Number(option('--batch', '500'))
const maintenance = process.env.OIP_MANAGEMENT_DB || join(process.env.OIP_DATA_DIR || 'data', 'management.sqlite')
const root = mediaRoot()
const number = value => Number(value || 0).toLocaleString('en-US')
const step = title => console.log(`\n[${title}]`)
const isDirectoryMime = mime => mime === 'inode/directory'

async function openStore(readOnly) {
  const db = new DatabaseSync(maintenance, readOnly ? { readOnly: true } : {})
  if (!readOnly) await db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000')
  return {
    db,
    all: async (sql, ...values) => (await (await db.prepare(sql)).all(...values)),
    get: async (sql, ...values) => (await (await db.prepare(sql)).get(...values)),
    run: async (sql, ...values) => (await (await db.prepare(sql)).run(...values)),
    async transaction(fn) { await db.exec('BEGIN IMMEDIATE'); try { const result = (await fn()); await db.exec('COMMIT'); return result } catch (error) { await db.exec('ROLLBACK'); throw error } },
    close: async () => (await db.close()),
  }
}

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

const statOrNull = path => { try { const info = lstatSync(path); return info.isFile() ? info : null } catch { return null } }

// ---- 字节来源清单 ----
// 三种来源：路径树上的文件、_artifacts/ 里的文件、还留在数据库 bytes 列里的老行。
// 只列位置、不读内容（库内 bytes 在读的时候才取），所以清单本身很小。
async function collect(store) {
  const columns = new Set((await tableColumns(store, 'workspace_files')))
  const scoped = columns.has('project_id')
  const storage = columns.has('storage') ? 'storage' : "'db' AS storage"
  const blob = columns.has('blob') ? 'blob' : 'NULL AS blob'
  const project = scoped ? 'project_id' : `'${DEFAULT_PROJECT_ID}' AS project_id`
  const size = columns.has('size') ? 'size' : 'length(bytes) AS size'
  const items = []
  for (const row of (await store.all(`SELECT user_id,${project},path,mime,${size},${storage},${blob} FROM workspace_files ORDER BY user_id,path`))) {
    if (isDirectoryMime(row.mime)) continue                 // 目录行没有字节
    if (row.blob as string) continue                                  // 已经搬过（重跑时跳过）
    const userRoot = resolve(root, String(row.user_id))
    const from = scoped ? resolve(userRoot, String(row.project_id), ...String(row.path).split('/')) : resolve(userRoot, ...String(row.path).split('/'))
    items.push({
      kind: 'workspace', userId: row.user_id, project: row.project_id, path: row.path, mime: row.mime,
      size: Number(row.size), inDatabase: row.storage !== 'disk', from: row.storage === 'disk' ? from : null,
      to: from,   // 回收/回滚要用的落点
    })
  }
  const artifactColumns = new Set((await tableColumns(store, 'artifacts')))
  if (artifactColumns.size) {
    for (const row of (await store.all(`SELECT a.id AS id,a.request_id AS request_id,a.mime AS mime,
        ${artifactColumns.has('size') ? 'a.size' : 'length(a.bytes)'} AS size,
        ${artifactColumns.has('storage') ? 'a.storage' : "'db'"} AS storage,
        ${artifactColumns.has('blob') ? 'a.blob' : 'NULL'} AS blob,
        g.user_id AS user_id
      FROM artifacts a LEFT JOIN generations g ON g.id=a.request_id`))) {
      if (row.blob as string) continue
      items.push({
        kind: 'artifact', id: row.id, requestId: row.request_id, userId: row.user_id || '', mime: row.mime,
        size: Number(row.size), inDatabase: row.storage !== 'disk',
        from: row.storage === 'disk' ? join(artifactDirectory(), row.id as string) : null,
        to: join(artifactDirectory(), row.id as string),
      })
    }
  }
  return items
}

async function sourceBytes(store, item, scoped) {
  if (item.kind === 'artifact') return (await store.get('SELECT bytes FROM artifacts WHERE id=?', item.id))?.bytes
  return (await store.get(scoped ? 'SELECT bytes FROM workspace_files WHERE user_id=? AND project_id=? AND path=?' : 'SELECT bytes FROM workspace_files WHERE user_id=? AND path=?',
    ...(scoped ? [item.userId, item.project, item.path] : [item.userId, item.path])))?.bytes
}

// 逐项算出内容哈希。这一趟是只读的：读不到字节就停下来、一行都不往下动
// ——「任何一行搬不动就整体停下并报出是哪一行」。
//
// **索引里的 size 一律以实际字节为准**：索引的 size 可能是旧的（历史遗留、上次写入中断）。
// 那不是「搬不动」，是索引该被这一轮修正——回填时写进去的就是真实长度。
// 把它当成错误拦下来会让整个迁移因为几行陈旧的 size 卡死，而那几行的字节其实好好的。
async function scan(store, items, { log = () => {} }: Record<string, any> = {}) {
  const scoped = (await tableColumns(store, 'workspace_files')).includes('project_id')
  const scanned = []
  const missing = []
  const resized = []
  let done = 0
  for (const item of items) {
    done += 1
    if (batch > 0 && done % batch === 0) log(`    已扫描 ${done} / ${items.length} 项……`)
    try {
      let sha
      let size = item.size
      if (item.inDatabase) {
        const bytes = (await sourceBytes(store, item, scoped))
        if (!bytes) { missing.push({ ...item, reason: '数据库里的 bytes 是空的' }); continue }
        size = bytes.length
        sha = hashBytes(Buffer.from(bytes))
      } else {
        let info
        try { info = lstatSync(item.from) } catch (error) {
          missing.push({ ...item, reason: error?.code === 'ENOENT' ? '磁盘上没有这个文件（索引还在）' : (error?.message || String(error)) })
          continue
        }
        if (!info.isFile()) { missing.push({ ...item, reason: `路径上不是普通文件（${info.isDirectory() ? '目录' : '软链或其他'}）` }); continue }
        size = info.size
        sha = await hashFile(item.from)
      }
      if (size !== item.size) resized.push({ ...item, indexSize: item.size, size })
      scanned.push({ ...item, size, sha })
    } catch (error) {
      missing.push({ ...item, reason: error?.message || String(error) })
    }
  }
  return { scanned, missing, resized }
}

// 索引 size 和实际字节对不上的行：不是错误，是这一轮顺手修正的对象，报出来让人知道。
function reportResized(resized) {
  if (!resized.length) return
  console.log(`  索引里的 size 和实际字节数对不上的：${resized.length} 行（以实际字节为准，回填时一并修正）`)
  for (const item of resized.slice(0, 10)) console.log(`    ${item.userId || '(无归属)'}  ${item.path || item.id}  索引 ${item.indexSize} → 实际 ${item.size}`)
  if (resized.length > 10) console.log(`    …… 其余 ${resized.length - 10} 行省略`)
}

function groupByHash(scanned) {
  const groups = new Map()
  for (const item of scanned) {
    if (!groups.has(item.sha)) groups.set(item.sha, [])
    groups.get(item.sha).push(item)
  }
  return groups
}

// 去重**只在一个账号内做**（跨账号去重会让「这份字节别人是不是也有」变成可探测的，
// 账号目录本来就是权限与归属的边界）。所以算省了多少必须按 (账号, 内容) 分组，
// 不能按内容全局分组——否则会把「两个账号碰巧有同一张图」也算进收益里，报出来的数字
// 比实际落盘的多。两个数字都给出来：bucketBlobs 是真实占用，crossAccount 只作说明。
function reportFacts(scanned) {
  const globalGroups = groupByHash(scanned)
  const bucketGroups = new Map()
  for (const item of scanned) {
    const key = `${item.userId || ''}\0${item.sha}`
    if (!bucketGroups.has(key)) bucketGroups.set(key, [])
    bucketGroups.get(key).push(item)
  }
  const logical = scanned.reduce((sum, item) => sum + item.size, 0)
  const uniqueScoped = [...bucketGroups.values()].reduce((sum, group) => sum + group[0].size, 0)
  const uniqueGlobal = [...globalGroups.values()].reduce((sum, group) => sum + group[0].size, 0)
  const duplicates = [...bucketGroups.values()].filter(group => group.length > 1)
    .sort((a, b) => (b.length - 1) * b[0].size - (a.length - 1) * a[0].size)
  const crossAccount = [...globalGroups.values()].reduce((sum, group) => {
    const owners = new Set(group.map(item => item.userId || ''))
    return sum + (owners.size > 1 ? group[0].size * (owners.size - 1) : 0)
  }, 0)
  return { groups: globalGroups, bucketGroups, logical, unique: uniqueScoped, uniqueGlobal, duplicates, crossAccount, saved: logical - uniqueScoped }
}

function assertMissing(missing, verb) {
  if (missing.length && !allowMissing) {
    const sample = missing.slice(0, 20).map(item => `  ${item.userId || '(无归属)'}  ${item.path || item.id}（${item.reason}）`).join('\n')
    throw new Error(`有 ${missing.length} 项读不到字节，已停止、一行都没动：\n${sample}\n（确认是迁移前就缺失的孤儿索引后，加 --allow-missing 放行）`)
  }
  if (missing.length) {
    console.log(`  跳过 ${missing.length} 项读不到的字节（--allow-missing），它们保持原样：`)
    for (const item of missing.slice(0, 20)) console.log(`    ${item.userId || '(无归属)'}  ${item.path || item.id}  ${item.reason}`)
    if (missing.length > 20) console.log(`    …… 其余 ${missing.length - 20} 项省略`)
  }
  void verb
}

async function report() {
  const store = (await openStore(true))
  try {
    const layout = (await mediaLayout(store))
    const items = (await collect(store))
    const already = (await tableColumns(store, 'workspace_files')).includes('blob')
      ? (await store.get('SELECT COUNT(*) AS n FROM workspace_files WHERE blob IS NOT NULL')).n
      : 0
    console.log(`媒体内容寻址迁移报告\n  数据库 ${maintenance}\n  媒体根目录 ${root}\n  当前布局 ${layout === MEDIA_LAYOUT_BLOB ? 'blob（已经是内容寻址）' : 'path（路径树，还没迁移）'}`)
    console.log(`  工作区索引里已经有 blob 的 ${number(already)} 行（之前跑过一部分）`)
    if (!items.length) { console.log('\n没有需要搬的字节。'); return }
    console.log(`\n待搬 ${number(items.length)} 项，索引记的字节数合计 ${number(items.reduce((sum, item) => sum + item.size, 0))}`)
    const { scanned, missing, resized } = await scan(store, items, { log: console.log })
    const { bucketGroups, logical, unique, uniqueGlobal, duplicates, crossAccount, saved } = reportFacts(scanned)
    if (resized.length) console.log(`  其中 ${resized.length} 行的索引 size 是旧的，已按实际字节数计算`)
    console.log('')
    console.log(`  索引里的字节合计：${number(logical)} 字节`)
    console.log(`  落盘后实际占用：${number(unique)} 字节（${number(bucketGroups.size)} 个 blob，按账号去重）`)
    console.log(`  **迁移后省下：${number(saved)} 字节（${logical ? ((1 - unique / logical) * 100).toFixed(1) : '0.0'}%）**`)
    console.log(`  重复组（同一账号内）：${number(duplicates.length)} 组，涉及 ${number(duplicates.reduce((sum, group) => sum + group.length, 0))} 项；最大重复份数 ${number(duplicates[0]?.length || 0)}`)
    if (crossAccount > 0) console.log(`  另有 ${number(crossAccount)} 字节是两个账号各存了一份同样的内容（内容全局唯一时是 ${number(uniqueGlobal)} 字节）——按设计不做跨账号去重，这部分不省。`)
    for (const group of duplicates.slice(0, 10)) {
      // 名字要带上账号：同一个内容在几个账号里各存一份是不同组，只打路径会看起来像重复打印。
      const names = group.slice(0, 3).map(item => `${String(item.userId || '(无归属)').slice(0, 8)}…/${item.path || item.id}`).join(' | ')
      console.log(`    ×${group.length}  ${number(group[0].size)} 字节  ${group[0].sha.slice(0, 12)}…  ${names}${group.length > 3 ? ` | …… 其余 ${group.length - 3} 项` : ''}`)
    }
    if (duplicates.length > 10) console.log(`    …… 其余 ${duplicates.length - 10} 组省略`)
    const buckets = new Map()
    for (const item of scanned) buckets.set(item.userId || '(无归属)', (buckets.get(item.userId || '(无归属)') || 0) + 1)
    console.log('')
    console.log(`  桶分布：${[...buckets.entries()].map(([id, n]) => `${id} ${number(n)} 项`).join('，')}`)
    if (missing.length) {
      console.log('')
      console.log(`读不到的字节：${number(missing.length)} 项（--apply 会在这里停下来，一行都不动）`)
      for (const item of missing.slice(0, 30)) console.log(`    ${item.userId || '(无归属)'}  ${item.path || item.id}  ${item.reason}`)
      if (missing.length > 30) console.log(`    …… 其余 ${missing.length - 30} 项省略`)
      console.log('    确认这些是迁移前就缺失的孤儿索引后，加 --allow-missing 放行。')
    }
  } finally { await store.close() }
}

// 建 blob：走 BlobStore 的实现（它负责权限、属主、已存在时的长度校验），
// 这一步**不删任何源**——回收是第 5 步，也是 --link-only 能安全停下的原因。
async function link(store, items, blobs) {
  const { scanned, missing, resized } = await scan(store, items, { log: console.log })
  assertMissing(missing, '链接')
  reportResized(resized)
  const scoped = (await tableColumns(store, 'workspace_files')).includes('project_id')
  let created = 0
  let reused = 0
  let done = 0
  for (const item of scanned) {
    done += 1
    if (batch > 0 && done % batch === 0) console.log(`    已处理 ${done} / ${scanned.length} 项，新建 ${created} 个 blob……`)
    const action = item.from
      ? blobs.linkFromFile(item.userId || '', item.from, item.sha)
      : ((await blobs.put(item.userId || '', Buffer.from((await sourceBytes(store, item, scoped))))) ? 'linked' : 'linked')
    if (action === 'reused') reused += 1
    else created += 1
  }
  console.log(`  建 blob 完成：新建 ${number(created)} 个，复用已有的 ${number(reused)} 个，共 ${number(new Set(scanned.map(item => `${item.userId || ''}\0${item.sha}`)).size)} 份不同内容`)
  return { scanned, missing, created, reused }
}

// 校验：每个引用都能在桶里找到字节，长度对得上；（可选）内容哈希也对得上。
async function verify(scanned) {
  const seen = new Set()
  let checked = 0
  for (const item of scanned) {
    const key = `${item.userId || ''}\0${item.sha}`
    if (seen.has(key)) continue
    seen.add(key)
    const target = join(blobDirectory(item.userId || ''), item.sha)
    const info = statOrNull(target)
    if (!info) throw new Error(`校验失败：blob 不存在 ${target}（来自 ${item.userId || '(无归属)'} ${item.path || item.id}）`)
    if (info.size !== item.size) throw new Error(`校验失败：blob 长度不符 ${target}（盘上 ${info.size} / 期望 ${item.size}）`)
    if (verifyHashes) {
      const actual = await hashFile(target)
      if (actual !== item.sha) throw new Error(`校验失败：blob 内容与文件名不符 ${target}（实际 ${actual}）`)
    }
    checked += 1
  }
  console.log(`  校验通过：${number(checked)} 个 blob，长度全部一致${verifyHashes ? '，内容哈希已全量重算' : '（要连内容一起校验加 --verify-hashes）'}`)
}

async function apply() {
  const store = (await openStore(false))
  try {
    const layout = (await mediaLayout(store))
    const items = (await collect(store))
    console.log(`媒体内容寻址迁移 ${linkOnly ? '--link-only' : '--apply'}\n  数据库 ${maintenance}\n  媒体根目录 ${root}\n  当前布局 ${layout}`)
    if (!items.length) {
      console.log('\n没有需要搬的字节。')
      if (!linkOnly && layout !== MEDIA_LAYOUT_BLOB) {
        step('只有布局标记要翻')
        await setMediaLayout(store, MEDIA_LAYOUT_BLOB)
        console.log('  已把布局标记翻成 blob：之后的写入落 _blobs/，不再写路径树。')
      }
      return
    }
    const blobs = new BlobStore(store)

    step(`1/5 建 blob（${number(items.length)} 项，硬链接，不复制）`)
    const { scanned } = await link(store, items, blobs)

    step('2/5 校验 blob')
    await verify(scanned)

    if (linkOnly) {
      console.log('\n--link-only 完成：blob 已整份建好并校验过，**源一个字节没删、表结构一列没动**。')
      console.log('这一刻旧镜像、新镜像都能正常读写，是这个迁移唯一可以随便停的安全点。')
      console.log('确认无误后再跑一次 --apply（会跳过已建好的 blob，只回填索引、翻布局、回收旧位置）。')
      return
    }

    step('3/5 回填索引（这一步之后旧镜像读不了，回滚镜像前必须先 --rollback）')
    // 先把两处结构补齐（老库的 bytes 还是 NOT NULL、还没有 storage/size/blob）：复用服务端
    // 启动时用的同一份结构升级函数，不在这里另写一套 DDL——artifacts 那张表带 ON DELETE CASCADE
    // 的子表，重建流程有讲究（先关外键、事务里重建、foreign_key_check 验完再打开），抄一遍必错。
    await ensureWorkspaceSchema(store)
    await ensureWorkspaceBlobColumn(store)
    await ensureArtifactSchema(store)
    const scoped = (await tableColumns(store, 'workspace_files')).includes('project_id')
    let backfilled = 0
    await store.transaction(async () => {
      for (const item of scanned) {
        if (item.kind === 'workspace') {
          await store.run(`UPDATE workspace_files SET blob=?,storage='blob',size=? WHERE user_id=?${scoped ? ' AND project_id=?' : ''} AND path=?`,
            item.sha, item.size, item.userId, ...(scoped ? [item.project] : []), item.path)
        } else {
          await store.run("UPDATE artifacts SET blob=?,storage='blob',size=?,bytes=NULL WHERE id=?", item.sha, item.size, item.id)
        }
        backfilled += 1
      }
    })
    console.log(`  回填 ${number(backfilled)} 行索引（工作区 + 生成结果）`)

    step('4/5 翻布局标记')
    await setMediaLayout(store, MEDIA_LAYOUT_BLOB)
    console.log('  之后的写入直接落 _blobs/，不再写路径树。')

    step('5/5 回收旧位置')
    let removed = 0
    let removedBytes = 0
    const directories = new Set()
    for (const item of scanned) {
      if (!item.from) continue
      // 删之前再确认一次：桶里那份字节在、长度对得上（硬链接的 nlink 保证字节还在）。
      const info = statOrNull(join(blobDirectory(item.userId || ''), item.sha))
      if (!info || info.size !== item.size) { console.log(`    跳过（blob 不在或长度不符，先别删源）：${item.from}`); continue }
      try {
        unlinkSync(item.from)
        removed += 1
        removedBytes += item.size
        directories.add(dirname(item.from))
      } catch (error) {
        console.log(`    删除失败（交给对账回收）：${item.from} ${error?.message || error}`)
      }
    }
    for (const directory of directories) pruneUpTo(directory, root)
    // Never recursively delete unindexed files or files created outside this scan.
    pruneUpTo(artifactDirectory(), root)
    const facts = reportFacts(scanned)
    console.log(`  回收旧位置 ${number(removed)} 个 / ${number(removedBytes)} 字节`)
    console.log(`  其中重复内容的 ${number(facts.logical - facts.unique)} 字节是**真正省下来的空间**，其余是与 blob 共享 inode 的旧名字。`)
    console.log('\n--apply 完成。跑 node server/media-reconcile.ts 核对一遍：')
    console.log('  「引用在、字节没了」必须是 0；「无引用的字节」应当是 0 或只有刚写入的少数几个。')
  } finally { await store.close() }
}

function pruneUpTo(directory, stopAt) {
  let current = directory
  while (current !== stopAt && current.startsWith(stopAt + sep)) {
    try { rmdirSync(current) } catch { return }
    current = dirname(current)
  }
}

async function rollback() {
  const store = (await openStore(false))
  try {
    const layout = (await mediaLayout(store))
    const workspaceColumns = (await tableColumns(store, 'workspace_files'))
    const scoped = workspaceColumns.includes('project_id')
    const rows = workspaceColumns.includes('blob')
      ? (await store.all(`SELECT user_id,${scoped ? 'project_id' : `'${DEFAULT_PROJECT_ID}' AS project_id`},path,mime,size,blob FROM workspace_files WHERE blob IS NOT NULL`))
      : []
    const artifactColumns = (await tableColumns(store, 'artifacts'))
    const artifactRows = artifactColumns.includes('blob')
      ? (await store.all(`SELECT a.id AS id,a.size AS size,a.blob AS blob,g.user_id AS user_id FROM artifacts a LEFT JOIN generations g ON g.id=a.request_id WHERE a.blob IS NOT NULL`))
      : []
    console.log(`媒体内容寻址迁移 --rollback\n  数据库 ${maintenance}\n  媒体根目录 ${root}\n  当前布局 ${layout}`)
    console.log(`  需要放回路径树的：工作区 ${number(rows.length)} 行、生成结果 ${number(artifactRows.length)} 行`)

    step('1/3 从 blob 把字节硬链接回原位置')
    let linked = 0
    for (const row of rows) {
      if (isDirectoryMime(row.mime)) continue
      const userRoot = resolve(root, String(row.user_id))
      const target = scoped ? resolve(userRoot, String(row.project_id), ...String(row.path).split('/')) : resolve(userRoot, ...String(row.path).split('/'))
      const source = join(blobDirectory(row.user_id), row.blob as string)
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
      try { linkSync(source, target) } catch (error) {
        if (error?.code !== 'EEXIST') throw new Error(`放回路径树失败，已停止（索引一列都没动）：${row.user_id} ${row.path}\n  源 ${source}\n  目标 ${target}\n  ${error?.message || error}`)
      }
      const info = statOrNull(target)
      if (!info || info.size !== Number(row.size)) throw new Error(`放回后长度不符，已停止：${target}（${info?.size} / 索引 ${row.size}）`)
      linked += 1
    }
    for (const row of artifactRows) {
      const target = join(artifactDirectory(), row.id as string)
      mkdirSync(artifactDirectory(), { recursive: true, mode: 0o700 })
      try { linkSync(join(blobDirectory(row.user_id || ''), row.blob as string), target) } catch (error) {
        if (error?.code !== 'EEXIST') throw new Error(`放回生成结果失败，已停止（索引一列都没动）：${row.id} ${error?.message || error}`)
      }
      linked += 1
    }
    console.log(`  放回 ${number(linked)} 个文件（硬链接，不额外占空间）`)

    step('2/3 退回索引与布局标记')
    await store.transaction(async () => {
      await store.run("UPDATE workspace_files SET blob=NULL,storage='disk' WHERE blob IS NOT NULL")
      await store.run("UPDATE artifacts SET blob=NULL,storage='disk' WHERE blob IS NOT NULL")
      await setMediaLayout(store, MEDIA_LAYOUT_PATH)
    })
    console.log('  索引里的 blob 已清空、布局标记退回 path：旧镜像可以直接读这一份数据了。')

    step('3/3 收尾')
    if (dropBlobs) {
      let removed = 0
      const owners = new Set([...rows.map(row => row.user_id || ''), ...artifactRows.map(row => row.user_id || ''), ''])
      for (const owner of owners) {
        const directory = blobDirectory(owner)
        let entries = []
        try { entries = readdirSync(directory) } catch { continue }
        for (const entry of entries) {
          if (!isBlobHash(entry)) continue
          try { unlinkSync(join(directory, entry)); removed += 1 } catch { /* 交给对账 */ }
        }
        try { rmdirSync(directory) } catch { /* 还有别的东西，留着 */ }
      }
      console.log(`  已删除 ${number(removed)} 个 blob（路径树上的链接已经建好，字节不会丢）`)
    } else {
      console.log('  blob 桶保留着（路径树上的文件是它的硬链接，不额外占空间）。确认一切正常后可以手动清，或下次加 --drop-blobs。')
    }
    console.log('\n--rollback 完成。')
  } finally { await store.close() }
}

try {
  if (mode !== 'report' && process.env.OIP_MEDIA_MAINTENANCE !== '1') throw new Error('请先停止工作区写入，并设置 OIP_MEDIA_MAINTENANCE=1；在线服务运行时禁止媒体迁移')
  if (mode === 'rollback') await rollback()
  else if (mode === 'apply') await apply()
  else await report()
} catch (error) {
  console.error('')
  console.error(`迁移已停止：${error?.message || error}`)
  process.exit(1)
}
