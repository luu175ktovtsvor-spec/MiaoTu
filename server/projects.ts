import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { ARTIFACT_DIRECTORY, BLOB_DIRECTORY, mediaPermissions, mediaRoot } from './media-files.ts'
import { isBlobHash, mediaLayout } from './blob-store.ts'

// 一个账号下的多个工作区（「项目」）。上游 MiaoImg 的项目是用户本机的文件夹，
// 我们是托管产品、没有本机目录概念，等价物就是账号下的多个互相隔离的工作区。
//
// 磁盘布局：<MEDIA_ROOT>/<userId>/<projectId>/<工作区相对路径>，与索引里的 path 一一对应；
// 项目内的相对路径保持不变（assets/<nodeId>/... 这些约定画布和素材清理都依赖）。
// 生成结果的 <MEDIA_ROOT>/_artifacts/ 保持全局不动，跨项目共用、按 artifactId 索引。
//
// 这个模块负责「项目维度」本身：id/名字校验、表结构的升级与回退、以及磁盘字节在两个布局之间的搬迁。
// 项目的增删改查在 management-store.ts，文件读写在 workspace-files.ts。
//
// 两套结构在这里必须分清楚：
//   老结构（legacy）：workspace_files 主键 (user_id,path)，磁盘 <MEDIA_ROOT>/<账号>/<相对路径>
//   项目结构（scoped）：主键 (user_id,project_id,path)，磁盘 <MEDIA_ROOT>/<账号>/<项目>/<相对路径>
// 只有 scripts/migrate-projects.ts 会把一个库从 legacy 改成 scoped。服务端进程在任何情况下
// 都不会自己改这两张表的结构——发布代码和跑迁移是两件事，中间可能有时间差，
// 没迁移过的库上服务必须照常跑（见 workspace-files.ts / management-store.ts 的「兼容老结构」）。

export const DEFAULT_PROJECT_ID = 'default'
export const DEFAULT_PROJECT_NAME = '默认项目'
export const PROJECT_NAME_MAX = 40

// 项目 id 会被直接拼进磁盘路径，形状收得比 userId 更紧：字母数字开头，中段允许 _ -。
// 这样天然挡住 ..、斜杠和点开头的隐藏目录，也是 newProjectId() 能生成的形状。
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

// 与 management-store.failure 同形。这里自带一份，免得两个模块互相 import 成环。
const invalid = message => Object.assign(new Error(message), { status: 422 })

export function newProjectId() {
  // 12 字节随机数的 hex，48 位十六进制；和 artifact id 一样只当不透明标识用。
  return randomBytes(12).toString('hex')
}

// id 来自请求参数，必须校验：它会变成一段目录名。
export function projectId(value) {
  const id = String(value ?? '').trim()
  // _artifacts 是生成结果的保留目录，不能拿来当项目目录名。
  if (!PROJECT_ID_PATTERN.test(id) || id === ARTIFACT_DIRECTORY) throw invalid('项目 id 无效')
  return id
}

export function cleanProjectName(value) {
  const name = String(value ?? '').trim()
  if (!name) throw invalid('项目名称不能为空')
  if (Array.from(name).length > PROJECT_NAME_MAX) throw invalid(`项目名称不能超过 ${PROJECT_NAME_MAX} 个字符`)
  // 控制字符会破坏列表和日志的展示（换行、制表符都在内），直接拒绝。
  if (/[\u0000-\u001f\u007f]/.test(name)) throw invalid('项目名称无效')
  return name
}

// ---- 表结构 ----

export const tableColumns = async (store, table) => (await store.all(`PRAGMA table_info(${table})`)).map(column => column.name)

// 主键是 (user_id, id)：项目 id 只需要在账号内唯一，这样每个账号的默认项目都能叫 default。
// 如果按「id 全局唯一」建表，第二个账号就拿不到 default 这个 id 了，和「默认项目固定用 default」冲突。
export const PROJECTS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS projects(
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_opened_at TEXT,
  PRIMARY KEY(user_id,id),
  UNIQUE(user_id,name))`

export async function ensureProjectsSchema(store) {
  await store.run(PROJECTS_TABLE_DDL)
}

const scopedWorkspaceDdl = name => `CREATE TABLE ${name}(
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  path TEXT NOT NULL, mime TEXT NOT NULL, bytes BLOB,
  revision TEXT NOT NULL, updated_at TEXT NOT NULL,
  storage TEXT NOT NULL DEFAULT 'disk', size INTEGER NOT NULL DEFAULT 0,
  blob TEXT,
  PRIMARY KEY(user_id,project_id,path))`

// 上一轮（媒体落磁盘）之后的老结构：bytes 可空 + storage/size。项目维度不在这里。
const legacyWorkspaceDdl = name => `CREATE TABLE ${name}(
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path TEXT NOT NULL, mime TEXT NOT NULL, bytes BLOB,
  revision TEXT NOT NULL, updated_at TEXT NOT NULL,
  storage TEXT NOT NULL DEFAULT 'disk', size INTEGER NOT NULL DEFAULT 0,
  blob TEXT,
  PRIMARY KEY(user_id,path))`

// 老库的 bytes 是 NOT NULL，而上一轮迁移后要把它写成 NULL，SQLite 改不了列约束，
// 只能重建一次表：列和行一个不少。这仍然是上一轮的行为，和项目维度无关。
export async function ensureWorkspaceSchema(store) {
  const columns = (await store.all('PRAGMA table_info(workspace_files)'))
  if (!columns.length) { await store.run(legacyWorkspaceDdl('workspace_files')); return { created: true, upgraded: false } }
  const names = new Set(columns.map(column => column.name))
  // 已经是项目结构：那张表由 scopedWorkspaceDdl 建的，列一定齐。
  if (names.has('project_id')) return { created: false, upgraded: false }
  const bytesColumn = columns.find(column => column.name === 'bytes')
  if (names.has('storage') && names.has('size') && bytesColumn && !bytesColumn.notnull) return { created: false, upgraded: false }
  const storage = names.has('storage') ? "COALESCE(storage,'db')" : "'db'"
  const size = names.has('size') ? 'size' : 'COALESCE(length(bytes),0)'
  const blob = names.has('blob') ? 'blob' : 'NULL'
  const before = (await store.get('SELECT COUNT(*) AS rows FROM workspace_files')).rows
  await store.transaction(async () => {
    await store.run(legacyWorkspaceDdl('workspace_files_upgrade'))
    await store.run(`INSERT INTO workspace_files_upgrade(user_id,path,mime,bytes,revision,updated_at,storage,size,blob)
      SELECT user_id,path,mime,bytes,revision,updated_at,${storage},${size},${blob} FROM workspace_files`)
    await store.run('DROP TABLE workspace_files')
    await store.run('ALTER TABLE workspace_files_upgrade RENAME TO workspace_files')
  })
  return { created: false, upgraded: true, rows: before }
}

// 内容寻址用的 blob 列：可空 ADD COLUMN，SQLite 不用重建表，存量行(NULL)语义就是「还没搬」。
// 建表和重建表的地方都带上它了，这里只补「表已经存在但还没这一列」的老库。
export async function ensureWorkspaceBlobColumn(store) {
  const columns = (await tableColumns(store, 'workspace_files'))
  if (!columns.length || columns.includes('blob')) return { added: false }
  try {
    await store.run('ALTER TABLE workspace_files ADD COLUMN blob TEXT')
  } catch (error) {
    // 容器里同时起好几个进程（image API / admin / 档案 API），它们都会走到这里。
    // 「先查再改」之间有一个窗口，两边的 ALTER 只有一个能成功，另一个拿到 duplicate column name。
    // 那正说明列已经加好了——当成成功，不要让它把进程的启动打崩。
    if (!/duplicate column name/i.test(error?.message || '')) throw error
    return { added: true, raced: true }
  }
  return { added: true }
}

// 这个库有没有迁移到多项目。两张表分开判断：迁移脚本跑到一半时会出现「一张新一张旧」，
// 那时服务端不该自己猜，按各自的真实结构跑，等运维把脚本跑完。
export async function detectProjectLayout(store) {
  const files = (await tableColumns(store, 'workspace_files'))
  const state = (await tableColumns(store, 'workspace_state'))
  const filesScoped = files.includes('project_id')
  const stateScoped = state.includes('project_id')
  // 没有 workspace_files 表：既没有文件索引，也就没有磁盘布局可言，按「新库」处理最安全——
  // 服务端会直接建项目结构，不涉及任何存量字节。
  // （只建了半截 schema 的库就落这一类：某个只 new ManagementStore() 的进程在新数据目录上跑过一次，
  //   建了 projects / workspace_state 却没建 workspace_files，以前会被永远判成「半迁移」。）
  if (!files.length) return { layout: 'fresh', files: true, state: true, filesScoped: true, stateScoped: true }
  if (filesScoped && stateScoped) return { layout: 'scoped', files: true, state: true, filesScoped: true, stateScoped: true }
  if (!filesScoped && !stateScoped) return { layout: 'legacy', files: false, state: false, filesScoped: false, stateScoped: false }
  return { layout: 'mixed', files: filesScoped, state: stateScoped, filesScoped, stateScoped }
}

// 服务端启动时调用的「保证结构可用」。
//
// 分得很清楚：
//   - workspace_state 是纯结构、不涉及任何字节，服务端可以自己升（改的是这两张表自己的形状）；
//   - workspace_files 的主键决定磁盘布局，那是一次要人显式执行的存量迁移，服务端绝不自己动；
//   - 老库（两张表都是老结构）一列都不动，整个进程按单项目语义跑。
// 能自己修的修完再判 layout，免得日志里出现「报告说没事、启动说中间态」这种自相矛盾的说法。
export async function ensureProjectDimension(store) {
  const before = (await detectProjectLayout(store))
  if (before.layout === 'legacy') {
    // 只把可能缺失的表补上——建表是上一版代码本来就做的事，不是把老数据改成新结构。
    if (!(await tableColumns(store, 'workspace_files')).length) await store.run(legacyWorkspaceDdl('workspace_files'))
    if (!(await tableColumns(store, 'workspace_state')).length) await store.run(legacyWorkspaceStateDdl('workspace_state'))
    return { ...before, before: before.layout }
  }
  if (before.layout === 'fresh') await store.run(scopedWorkspaceDdl('workspace_files'))
  await ensureProjectsSchema(store)
  const state = (await ensureWorkspaceStateSchema(store))
  const after = (await detectProjectLayout(store))
  return { ...after, before: before.layout, stateUpgraded: state.upgraded, stateCreated: state.created, stateRows: state.rows }
}

// 给运维看的一句话：这个库现在卡在哪一步、下一步该做什么。
// `--report` 的「判断」和启动日志的提醒**共用这一份判断**，两边不可能给出互相矛盾的结论。
// 返回 null 表示没什么要提醒的（老结构是正常工作状态，全新库刚建好也没事）。
export function layoutAdvice(report) {
  if (report.layout === 'legacy') return null
  if (report.layout === 'mixed') return '工作区结构处于半迁移状态（workspace_files 和 workspace_state 一新一旧），服务端不会自己改；请把 node scripts/migrate-projects.ts 跑完（继续迁移用 --apply，退回旧结构用 --rollback）'
  const pending = report.atOldOnly + report.atBoth
  if (pending) return `还有 ${pending} 行工作区文件的字节不在项目布局（只在旧布局 ${report.atOldOnly} 行、两边都有 ${report.atBoth} 行），这些文件现在读不到；请把 node scripts/migrate-projects.ts --apply 跑完再重启服务`
  if (report.atNeither) return `有 ${report.atNeither} 行索引在磁盘上找不到字节，node server/media-reconcile.ts 会列出是哪几行，需要人工确认`
  return null
}

const scopedWorkspaceStateDdl = name => `CREATE TABLE ${name}(
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  workspace TEXT NOT NULL DEFAULT '{}',
  assets TEXT NOT NULL DEFAULT '[]',
  canvas_files TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id,project_id))`

// 草稿/素材库这份 JSON 状态也按项目隔离，主键从 (user_id) 改成 (user_id, project_id)。
// 老表的 user_id 只是 PRIMARY KEY、没写 NOT NULL（SQLite 允许它为 NULL），
// 重建时会把约束补齐，真有 NULL 行就停下来报清楚，不静默丢数据。
export async function ensureWorkspaceStateSchema(store) {
  const columns = (await store.all('PRAGMA table_info(workspace_state)'))
  if (!columns.length) { await store.run(scopedWorkspaceStateDdl('workspace_state')); return { created: true, upgraded: false, rows: 0 } }
  if (columns.some(column => column.name === 'project_id')) return { created: false, upgraded: false, rows: 0 }
  const orphans = (await store.get('SELECT COUNT(*) AS rows FROM workspace_state WHERE user_id IS NULL')).rows
  if (orphans) throw Object.assign(new Error(`workspace_state 里有 ${orphans} 行 user_id 为空，无法归入任何账号，请先人工确认`), { status: 500 })
  const before = (await store.get('SELECT COUNT(*) AS rows FROM workspace_state')).rows
  await store.transaction(async () => {
    await store.run(scopedWorkspaceStateDdl('workspace_state_upgrade'))
    await store.run(`INSERT INTO workspace_state_upgrade(user_id,project_id,workspace,assets,canvas_files,updated_at)
      SELECT user_id,'${DEFAULT_PROJECT_ID}',workspace,assets,canvas_files,updated_at FROM workspace_state`)
    await store.run('DROP TABLE workspace_state')
    await store.run('ALTER TABLE workspace_state_upgrade RENAME TO workspace_state')
  })
  return { created: false, upgraded: true, rows: before }
}

// ---- 迁移脚本用：把老结构改成项目结构 ----

// 给 workspace_files 加项目维度。SQLite 改不了主键，只能按官方推荐重建表：
// 列和行一个不少，存量行一律归入默认项目；bytes 仍是 BLOB（回滚老版本代码时数据还在）。
export async function addProjectDimension(store) {
  const upgraded = (await ensureWorkspaceSchema(store))
  const columns = (await store.all('PRAGMA table_info(workspace_files)'))
  const names = new Set(columns.map(column => column.name))
  if (names.has('project_id')) return { upgraded: false, rows: 0, legacyUpgrade: upgraded }
  const project = `'${DEFAULT_PROJECT_ID}'`
  const storage = names.has('storage') ? "COALESCE(storage,'db')" : "'db'"
  const size = names.has('size') ? 'size' : 'COALESCE(length(bytes),0)'
  const blob = names.has('blob') ? 'blob' : 'NULL'
  const before = (await store.get('SELECT COUNT(*) AS rows FROM workspace_files')).rows
  await store.transaction(async () => {
    await store.run(scopedWorkspaceDdl('workspace_files_project'))
    await store.run(`INSERT INTO workspace_files_project(user_id,project_id,path,mime,bytes,revision,updated_at,storage,size,blob)
      SELECT user_id,${project},path,mime,bytes,revision,updated_at,${storage},${size},${blob} FROM workspace_files`)
    await store.run('DROP TABLE workspace_files')
    await store.run('ALTER TABLE workspace_files_project RENAME TO workspace_files')
  })
  return { upgraded: true, rows: before, legacyUpgrade: upgraded }
}

// ---- 回滚（发布回退时用）----

// 回退到老结构。上一版代码读的就是这个形状：主键 (user_id,path)，bytes 可空、storage/size 都在。
// 索引行必须一一对得上，所以路径在两个项目里重名的先拒绝。
export async function revertWorkspaceSchema(store) {
  const columns = (await store.all('PRAGMA table_info(workspace_files)'))
  if (!columns.length || !columns.some(column => column.name === 'project_id')) return { reverted: false, rows: 0 }
  const duplicated = (await store.all('SELECT user_id,path,COUNT(*) AS n FROM workspace_files GROUP BY user_id,path HAVING n>1'))
  if (duplicated.length) {
    const sample = duplicated.slice(0, 20).map(row => `  ${row.user_id} ${row.path}（${row.n} 个项目里都有）`).join('\n')
    throw new Error(`有 ${duplicated.length} 个路径在多个项目里同名，回退后的表存不下，已停止：\n${sample}`)
  }
  const before = (await store.get('SELECT COUNT(*) AS rows FROM workspace_files')).rows
  const blob = (await tableColumns(store, 'workspace_files')).includes('blob') ? 'blob' : 'NULL'
  await store.transaction(async () => {
    await store.run(legacyWorkspaceDdl('workspace_files_revert'))
    await store.run(`INSERT INTO workspace_files_revert(user_id,path,mime,bytes,revision,updated_at,storage,size,blob)
      SELECT user_id,path,mime,bytes,revision,updated_at,storage,size,${blob} FROM workspace_files`)
    await store.run('DROP TABLE workspace_files')
    await store.run('ALTER TABLE workspace_files_revert RENAME TO workspace_files')
  })
  return { reverted: true, rows: before }
}

const legacyWorkspaceStateDdl = name => `CREATE TABLE ${name}(
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  workspace TEXT NOT NULL DEFAULT '{}',
  assets TEXT NOT NULL DEFAULT '[]',
  canvas_files TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL)`

// 旧代码按 user_id 单键读写，只能保留默认项目那一行；其它项目的草稿 JSON 在旧代码里
// 本来就看不见，回退时被丢弃，数量打出来让人知道丢了什么。
export async function revertWorkspaceStateSchema(store) {
  const columns = (await store.all('PRAGMA table_info(workspace_state)'))
  if (!columns.length || !columns.some(column => column.name === 'project_id')) return { reverted: false, rows: 0, kept: 0, dropped: 0 }
  const before = (await store.get('SELECT COUNT(*) AS rows FROM workspace_state')).rows
  const kept = (await store.get('SELECT COUNT(*) AS rows FROM workspace_state WHERE project_id=?', DEFAULT_PROJECT_ID)).rows
  await store.transaction(async () => {
    await store.run(legacyWorkspaceStateDdl('workspace_state_revert'))
    await store.run(`INSERT INTO workspace_state_revert(user_id,workspace,assets,canvas_files,updated_at)
      SELECT user_id,workspace,assets,canvas_files,updated_at FROM workspace_state WHERE project_id='${DEFAULT_PROJECT_ID}'`)
    await store.run('DROP TABLE workspace_state')
    await store.run('ALTER TABLE workspace_state_revert RENAME TO workspace_state')
  })
  return { reverted: true, rows: before, kept, dropped: before - kept }
}

export async function dropProjectsTable(store) {
  await store.run('DROP TABLE IF EXISTS projects')
}

// ---- 字节搬迁 ----

// 一行索引在磁盘上的两个位置。apply 是「老布局 -> 项目布局」，rollback 反过来。
// row.path 在写入时已经校验过（不含 ..、不以 / 开头），这里再 resolve 一次并确认落点在
// 账号目录内，纯粹是搬迁这一步的自我保护——搬错位置就是删错文件。
function layoutOf(root, row, direction) {
  const userRoot = resolve(root, String(row.user_id))
  const projectRoot = resolve(userRoot, String(row.project_id))
  const parts = String(row.path).split('/')
  const inProject = resolve(projectRoot, ...parts)
  const inUser = resolve(userRoot, ...parts)
  if (inProject !== projectRoot && !inProject.startsWith(projectRoot + sep)) throw new Error(`路径越界：${row.user_id}/${row.project_id}/${row.path}`)
  if (inUser !== userRoot && !inUser.startsWith(userRoot + sep)) throw new Error(`路径越界：${row.user_id}/${row.path}`)
  return direction === 'apply'
    ? { from: inUser, to: inProject, userRoot }
    : { from: inProject, to: inUser, userRoot }
}

const isDirectoryMime = mime => mime === 'inode/directory'

async function workspaceRows(store) {
  const columns = new Set((await store.all('PRAGMA table_info(workspace_files)')).map(column => column.name))
  if (!columns.size) return []
  const project = columns.has('project_id') ? 'project_id' : `'${DEFAULT_PROJECT_ID}' AS project_id`
  const size = columns.has('size') ? 'size' : 'COALESCE(length(bytes),0) AS size'
  const storage = columns.has('storage') ? 'storage' : "'db' AS storage"
  const blob = columns.has('blob') ? 'blob' : 'NULL AS blob'
  // 浅路径在前：目录行会把整棵子树一起搬走，它下面的行就不用再搬一次。
  return (await store.all(`SELECT user_id,${project},path,mime,${size},${storage},${blob} FROM workspace_files ORDER BY user_id,project_id,length(path),path`))
}

// 只报账：每一行的字节现在落在老布局、项目布局、还是两边都有/都没有。
export async function projectLayoutReport(store, { root = mediaRoot() }: Record<string, any> = {}) {
  const hasProjects = Boolean((await store.get("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='projects'")))
  const columns = (await tableColumns(store, 'workspace_files'))
  const stateColumns = (await tableColumns(store, 'workspace_state'))
  const total = columns.length ? (await store.get('SELECT COUNT(*) AS rows FROM workspace_files')).rows : 0
  const rows = columns.length ? (await workspaceRows(store)) : []
  const counts = { rows: total, atOldOnly: 0, atNewOnly: 0, atBoth: 0, atNeither: 0, bytesAtOldOnly: 0, bytesAtNewOnly: 0, atBlob: 0, bytesAtBlob: 0, missingBlob: 0, virtualDirectories: 0 }
  const blobLayout = (await mediaLayout(store)) === 'blob'
  for (const row of rows) {
    if (blobLayout && isDirectoryMime(row.mime)) { counts.virtualDirectories++; continue }
    if (row.blob) {
      const path = isBlobHash(row.blob) ? join(root, String(row.user_id), BLOB_DIRECTORY, row.blob) : null
      let available = false
      try { available = !!path && statSync(path).isFile() } catch {}
      if (available) { counts.atBlob++; counts.bytesAtBlob += Number(row.size) || 0 }
      else { counts.missingBlob++; counts.atNeither++ }
      continue
    }
    const { from, to } = layoutOf(root, row, 'apply')
    const atOld = existsSync(from)
    const atNew = existsSync(to)
    const size = Number(row.size) || 0
    if (atOld && atNew) counts.atBoth += 1
    else if (atOld) { counts.atOldOnly += 1; counts.bytesAtOldOnly += size }
    else if (atNew) { counts.atNewOnly += 1; counts.bytesAtNewOnly += size }
    else counts.atNeither += 1
  }
  return {
    root,
    layout: columns.length ? (await detectProjectLayout(store)).layout : 'fresh',
    hasProjectsTable: hasProjects,
    hasProjectColumn: columns.includes('project_id'),
    hasWorkspaceStateProject: stateColumns.includes('project_id'),
    users: (await store.all('SELECT COUNT(*) AS n FROM users'))[0]?.n ?? 0,
    workspaceStateRows: stateColumns.length ? (await store.get('SELECT COUNT(*) AS rows FROM workspace_state')).rows : 0,
    ...counts,
  }
}

// ---- 复制 + 校验 ----

async function hashOf(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

// 目录下所有的子目录和文件（相对路径）。空目录也要列出来：工作区里允许有空文件夹，
// 索引里也有它们对应的目录行，复制时漏掉的话用户会发现文件夹不见了。
function walkTree(dir) {
  const directories = new Set()
  const files = new Map()
  const stack = [['', dir]]
  while (stack.length) {
    const [prefix, current] = stack.pop()
    let entries
    try { entries = readdirSync(current, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const full = join(current, entry.name)
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      let info
      try { info = lstatSync(full) } catch { continue }
      // 软链一律不跟随、不复制：工作区写入不会产生软链，出现了就该人工看。
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) { directories.add(relative); stack.push([relative, full]) }
      else if (info.isFile()) files.set(relative, info.size)
    }
  }
  return { directories, files }
}

function copyOne(from, to) {
  const temp = `${to}.tmp-${randomBytes(8).toString('hex')}`
  try {
    copyFileSync(from, temp)
    // copyFileSync 会照搬源文件权限，这里按当前档位统一一次。
    chmodSync(temp, mediaPermissions().file)
    renameSync(temp, to)
  } catch (error) {
    try { rmSync(temp, { force: true }) } catch { /* 残留的临时文件交给对账回收 */ }
    throw error
  }
}

// 复制一棵目录（目录行在磁盘上就是真实目录），目录结构一个不少地建出来，文件逐个原子复制。
function copyTree(from, to) {
  mkdirSync(to, { recursive: true, mode: mediaPermissions().directory })
  let count = 0
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const destination = join(to, entry.name)
    let info
    try { info = lstatSync(source) } catch { continue }
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) { count += copyTree(source, destination); continue }
    if (!info.isFile()) continue
    copyOne(source, destination)
    count += 1
  }
  return count
}

// 复制一个文件或一整棵目录。
function copyPath(from, to) {
  const info = statSync(from)
  if (!info.isDirectory()) {
    mkdirSync(dirname(to), { recursive: true, mode: mediaPermissions().directory })
    copyOne(from, to)
    return 1
  }
  return copyTree(from, to)
}

// 复制完再逐字节校验。目录行把整棵子树一起比：目录集合、文件集合、每个文件的大小、以及每个文件的 sha256。
// 校验不过就不删源，宁可停下来让人看，也不留一份半截的字节。
async function verifyPath(from, to) {
  const source = statSync(from)
  if (!source.isDirectory()) {
    const copied = statSync(to)
    if (copied.size !== source.size) return `字节数不一致（源 ${source.size} / 目标 ${copied.size}）`
    if (await hashOf(to) !== await hashOf(from)) return '内容校验不一致（sha256）'
    return null
  }
  const expected = walkTree(from)
  const actual = walkTree(to)
  for (const directory of expected.directories) if (!actual.directories.has(directory)) return `目标缺少目录 ${directory}`
  if (expected.files.size !== actual.files.size) return `文件个数不一致（源 ${expected.files.size} / 目标 ${actual.files.size}）`
  for (const [relative, size] of expected.files) {
    if (!actual.files.has(relative)) return `目标缺少 ${relative}`
    if ((await actual.files.get(relative)) !== size) return `${relative} 字节数不一致（源 ${size} / 目标 ${(await actual.files.get(relative))}）`
    const sourceFile = join(from, ...relative.split('/'))
    const targetFile = join(to, ...relative.split('/'))
    if (await hashOf(targetFile) !== await hashOf(sourceFile)) return `${relative} 内容校验不一致（sha256）`
  }
  return null
}

// 把字节从一个布局搬到另一个布局：**先整份复制并校验，全部过了再删旧的那一份**。
//
// 为什么不是 rename：发布是「备份 → 停旧容器 → 起新容器 → 健康检查 → 失败回滚到旧容器」。
// rename 搬到一半崩掉，老布局就只剩一半字节，回滚到旧容器对用户就是文件消失。
// 复制完再删的话，任何时刻至少有一个布局是完整的：崩在复制阶段老布局原样可用（直接回滚）；
// 崩在删除阶段新布局已经完整（继续往前发，或者 --rollback 从新布局把老布局重建回来）。
//
// 幂等可续跑：目标已在、源也还在且校验一致的行按「已复制、待删源」处理，重跑不会重复复制；
// 源已不在、目标在的行按「已完成」跳过。严格模式（默认 allowMissing=false）在体检发现
// 任何一行搬不动时一行都不动，把问题行全列出来再退出。
export async function copyProjectLayout(store, { direction = 'apply', root = mediaRoot(), allowMissing = false, copyOnly = false, batch = 500, log = console.log }: Record<string, any> = {}) {
  if (!['apply', 'rollback'].includes(direction)) throw new Error(`未知的搬迁方向：${direction}`)
  const rows = (await workspaceRows(store))
  // 回滚要把每个项目里的同一相对路径收回到账号根下，两个项目都有 画布1.json 时索引层面就冲突了，
  // 这时候回滚必然丢文件，先查出来直接拒绝。
  if (direction === 'rollback') {
    const duplicated = (await store.all('SELECT user_id,path,COUNT(*) AS n FROM workspace_files GROUP BY user_id,path HAVING n>1'))
    if (duplicated.length) {
      const sample = duplicated.slice(0, 20).map(row => `  ${row.user_id} ${row.path}（${row.n} 个项目里都有）`).join('\n')
      throw new Error(`有 ${duplicated.length} 个路径在多个项目里同名，回滚到单项目布局会互相覆盖，已停止：\n${sample}`)
    }
  }

  // 体检：先把每一行的状态分好类，有搬不动的就地停下。
  const plan = []
  const missing = []
  for (const row of rows) {
    const { from, to, userRoot } = layoutOf(root, row, direction)
    const atFrom = existsSync(from)
    const atTo = existsSync(to)
    const item = { row, from, to, userRoot, atFrom, atTo }
    if (!atFrom && !atTo) { missing.push(item); continue }
    plan.push(item)
  }
  if (missing.length && !allowMissing) {
    const sample = missing.slice(0, 20).map(item => `  ${item.row.user_id} ${item.row.project_id} ${item.row.path}（${item.row.storage}，${item.row.size} 字节）`).join('\n')
    throw new Error(`有 ${missing.length} 行的字节在两个布局里都找不到，已停止、一行都没动：\n${sample}\n（确认这些是迁移前就缺失的孤儿索引后，加 --allow-missing 放行）`)
  }
  if (missing.length) {
    log(`  跳过 ${missing.length} 行两个布局里都没有的索引（只影响这些行，其余照常处理）：`)
    for (const item of missing.slice(0, 20)) log(`    ${item.row.user_id} ${item.row.project_id} ${item.row.path}`)
    if (missing.length > 20) log(`    …… 其余 ${missing.length - 20} 行省略`)
  }

  let copied = 0
  let copiedBytes = 0
  let reused = 0
  let covered = 0
  let already = 0
  const directories = new Set()
  // 每个 (账号, 项目) 里已经整棵处理过的目录前缀，子树里的行不用再单独处理。
  const movedPrefixes = new Map()
  const isCovered = item => movedPrefixes.get(`${item.row.user_id}\0${item.row.project_id}`)?.some(prefix => item.row.path.startsWith(`${prefix}/`))
  const markCovered = item => {
    if (!isDirectoryMime(item.row.mime)) return
    const key = `${item.row.user_id}\0${item.row.project_id}`
    if (!movedPrefixes.has(key)) movedPrefixes.set(key, [])
    movedPrefixes.get(key).push(item.row.path)
  }

  // ---- 阶段 1：复制 + 校验，这一步一个源字节都不删 ----
  for (const item of plan) {
    if (isCovered(item)) { covered += 1; continue }
    const { row, from, to } = item
    if (!item.atFrom) { already += 1; markCovered(item); continue }
    if (item.atTo) {
      // 两个布局都有：上一次跑到这里崩了（复制完还没删源）。校验一致就只等阶段 2 删源。
      const mismatch = await verifyPath(from, to)
      if (mismatch) throw new Error(`两个布局里都有这一行，但内容对不上，不敢删任何一边，已停止：${row.user_id} ${row.project_id} ${row.path}\n  源 ${from}\n  目标 ${to}\n  ${mismatch}`)
      reused += 1
      markCovered(item)
      continue
    }
    try {
      copyPath(from, to)
    } catch (error) {
      throw new Error(`复制这一行时失败，已停止（重跑会从这里继续，源一个字节都没删）：${row.user_id} ${row.project_id} ${row.path}\n  源 ${from}\n  目标 ${to}\n  ${error?.message || error}`)
    }
    const mismatch = await verifyPath(from, to)
    if (mismatch) throw new Error(`复制完校验不过，已停止、源没删：${row.user_id} ${row.project_id} ${row.path}\n  源 ${from}\n  目标 ${to}\n  ${mismatch}`)
    copied += 1
    copiedBytes += Number(row.size) || 0
    if (batch > 0 && copied % batch === 0) log(`    已复制校验 ${copied} 行 / ${copiedBytes} 字节……`)
    markCovered(item)
  }
  log(`  阶段 1（复制+校验）完成：复制 ${copied} 行 / ${copiedBytes} 字节，沿用上次已复制好的 ${reused} 行，被上级目录整棵带走 ${covered} 行，早已搬完 ${already} 行`)

  if (copyOnly) return { copied, copiedBytes, reused, covered, already, deleted: 0, deletedBytes: 0, missing: missing.length, directories, copyOnly: true, plan }

  // ---- 阶段 2：删掉旧的那一份。走到这里新布局已经整份校验过了 ----
  movedPrefixes.clear()
  let deleted = 0
  let deletedBytes = 0
  for (const item of plan) {
    if (isCovered(item)) continue
    const { row, from, to } = item
    markCovered(item)
    if (!existsSync(from)) continue
    // 再确认一次目标在（阶段 1 校验过，除非有人在这中间动过）。
    if (!existsSync(to)) throw new Error(`准备删源时目标不见了，已停止：${row.user_id} ${row.project_id} ${row.path}\n  源 ${from}\n  目标 ${to}`)
    try {
      rmSync(from, { recursive: true, force: true })
    } catch (error) {
      throw new Error(`删除旧位置失败，已停止（重跑会从这里继续）：${row.user_id} ${row.project_id} ${row.path}\n  源 ${from}\n  ${error?.message || error}`)
    }
    deleted += 1
    deletedBytes += Number(row.size) || 0
    if (batch > 0 && deleted % batch === 0) log(`    已清理旧位置 ${deleted} 行 / ${deletedBytes} 字节……`)
    // 记录搬空后的目录，收尾时只删空目录（从最深的父目录往上走，非空就停）。
    directories.add(`${dirname(from)}\0${item.userRoot}`)
  }
  log(`  阶段 2（清理旧位置）完成：删除 ${deleted} 行 / ${deletedBytes} 字节`)
  return { copied, copiedBytes, reused, covered, already, deleted, deletedBytes, missing: missing.length, directories, copyOnly: false }
}

// 只删空目录：有内容（还没搬、或者是别的项目/别的文件）就停手。
export function pruneEmptyDirectories(directories, log = console.log) {
  let removed = 0
  for (const entry of directories) {
    const [directory, stopAt] = entry.split('\0')
    let current = directory
    while (current !== stopAt && current.startsWith(stopAt + sep)) {
      try { rmdirSync(current) } catch { break }
      removed += 1
      current = dirname(current)
    }
  }
  if (removed) log(`  清理搬空后的空目录：${removed} 个`)
  return removed
}
