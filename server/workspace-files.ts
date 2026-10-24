import { hasCanvasMarker, hasCanvasHeader } from './canvas-document.ts'
import { isWorkspacePath, type WorkspaceReferenceScope } from './workspace-path.ts'
import { createHash, randomUUID } from 'node:crypto'
import { validCanvas, mergeCanvasState, persistentCanvas } from './canvas-state.ts'
import { closeSync, openSync, readSync, constants as fsConstants, createReadStream, existsSync, lstatSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { failure } from './management-store.ts'
import { alignMediaOwner, ensureMediaDirectory, mediaPermissions, mediaRoot, validMediaOwner, withStreamedMedia } from './media-files.ts'
import { MEDIA_LAYOUT_BLOB, BlobStore, mediaLayout } from './blob-store.ts'
import { DEFAULT_PROJECT_ID, ensureProjectsSchema, ensureWorkspaceBlobColumn, ensureWorkspaceSchema, projectId, tableColumns } from './projects.ts'
import { currentProject } from './workspace-scope.ts'
import { canvasFileReferences, type CanvasFileReference } from './canvas-file-references.ts'
import { t } from './i18n.ts'
import { isMarkdownFile, markdownFileReferences, type MarkdownFileReference } from './markdown-file-references.ts'
import { rebaseMarkdownPaths } from './markdown-rebase.ts'
import { prepareCanvasCopies } from './canvas-copy.ts'
import { assertCanvasCleanupSafe, canvasCleanupDocument } from './canvas-cleanup.ts'
import { assertWorkspaceTreeSnapshot } from './workspace-tree.ts'

// MEDIA_ROOT、权限档位、原子写这些公共约定在 media-files.ts，和生成结果（artifact-files.ts）共用一份。
export { mediaRoot }

// 工作区文件的字节存在磁盘上，数据库只留瘦索引
// （user_id / project_id / path / mime / size / revision / updated_at / storage）。
//
// 磁盘布局分两种，由 media_layout 标记决定（见 blob-store.ts）：
//   'path'（默认）—— <MEDIA_ROOT>/<userId>/<projectId>/<工作区相对路径>，索引里的 path 一一对应磁盘文件；
//   'blob'        —— 字节只在 <MEDIA_ROOT>/<userId>/_blobs/<sha256>，path 只活在索引里，盘上没有目录树。
// 一个账号下可以有多个项目（工作区），互不可见；项目内的相对路径约定在两种布局下完全一样，
// 前端与 nginx 直出（X-Accel-Redirect 跟的是 diskPath，不是拼出来的路径）都不需要区分。
// 桌面流式文件、技能包及已有路径文件的更新可在 path 布局中使用 blob 行；后续编辑保留内容寻址存储。
// 真实文件位置始终以行的 blob/storage 为准，不从全局布局推断。
// MEDIA_ROOT 优先读 OIP_MEDIA_ROOT（兼容 MEDIA_ROOT），否则从 OIP_DATA_DIR 推导。
//
// **没迁移到多项目的老库**：workspace_files 还是 (user_id,path) 主键、磁盘还是
// <MEDIA_ROOT>/<userId>/<相对路径>。这种库整个就是一个默认项目，本类照常读写老结构，
// 不自己改表、不自己搬字节——迁移只由 scripts/migrate-projects.ts 显式执行。
// 发布代码和跑迁移是两件事，中间可能有时间差，这段时间服务必须能跑。
//
// 数据库里保留 bytes 列（不 drop）：历史行迁移前仍是唯一副本，storage='db' 时回退读它，
// 迁移后置 NULL 只作历史痕迹，回滚老版本代码时还能看出这行是从哪来的。
//
// blob 列是内容寻址之后的字节引用（sha256）。**删除只删引用**：只要还有别的引用指向同一份
// 字节（例如生成历史里那条），字节必须留着——画布上删掉节点不等于结果没了。
// 引用没了才回收，判定与竞态防护都收在 blob-store.ts 的 release() 里。
export const WORKSPACE_FILE_MAX_BYTES = 200 * 1024 * 1024

const cleanMime = value => typeof value === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(value) ? value : 'application/octet-stream'
const now = () => new Date().toISOString()

// 目录行（workspaceFiles.upsert(..., 'inode/directory', 空)）在磁盘上就是真实目录，
// 不能再写成 0 字节的文件，否则它的子路径没法落地。
const isDirectoryMime = mime => mime === 'inode/directory'

// 项目从哪来，优先级：调用方显式传的 > 当前请求的项目上下文 > 默认项目。
// 注意：下面这些方法**不能在形参上写 project = DEFAULT_PROJECT_ID** —— 默认参数会把 undefined
// 补成默认项目，请求上下文就永远轮不上了（踩过一次）。统一在这里兜底。
// 显式传参的老调用方（Agent 对话、MCP、插件、ffmpeg）不带 project，于是自动落到
// HTTP 入口挂上的当前项目；后台任务和脚本没有请求上下文，落回默认项目——和
// 「不传 project 一律默认项目」的口径一致。
const requestedProject = value => projectId(
  (value === undefined || value === null || value === '')
    ? (currentProject() || DEFAULT_PROJECT_ID)
    : value)

export class WorkspaceFiles {
  declare store: any
  declare scoped: any
  declare blobs: any
  declare layout: any
  declare pendingBytes: any[]
  declare userMutationGuard: ((userId: any, project: string, payload: Record<string, any>) => void) | undefined
  declare userListFilter: ((userId: any, project: string, entries: any[]) => any[]) | undefined
  declare beforeRemove: ((userId: any, project: string, entries: any[], options: { trash: boolean; path: string }) => (() => void) | void) | undefined
  declare referenceOwner: ((userId: any) => string) | undefined
  declare referenceScope: ((userId: any, project: string) => WorkspaceReferenceScope) | undefined
  declare canvasCleanupReferences: ((userId: any, project: string) => readonly string[]) | undefined
  declare referenceCache: { key: string; canvases: Map<string, { revision: string; references: CanvasFileReference[] }>; markdown: Map<string, { revision: string; references: MarkdownFileReference[] }> } | undefined

  // migrate=false 供只读入口使用：只建表，不动数据。
  constructor(store, { migrate = true }: Record<string, any> = {}) {
    this.store = store
    // 结构由 management-store 更早定好（projects.ts 的 ensureProjectDimension）：老库一列都没动。
    // 单独用本类（没有 ManagementStore）时按表的真实结构判断。
    this.scoped = store.projectScoped === undefined
      ? tableColumns(store, 'workspace_files').includes('project_id')
      : Boolean(store.projectScoped)
    ensureWorkspaceSchema(store)
    ensureWorkspaceBlobColumn(store)
    if (this.scoped) ensureProjectsSchema(store)
    // blob 列一定存在（上面刚补过），所以查询里可以无条件带上它。
    this.blobs = typeof store.blobStore === 'function' ? store.blobStore() : new BlobStore(store)
    this.layout = mediaLayout(store)
    // 事务里只登记要回收的字节，提交之后再动盘（见 deferBytes）。
    this.pendingBytes = []
    store.run("UPDATE workspace_files SET size=length(bytes) WHERE bytes IS NOT NULL AND size=0")
    ensureMediaDirectory(mediaRoot())
    if (migrate) this.migrateToDisk()
  }

  // ---- 两种结构下的查询片段 ----
  // 老库里整个库就是默认项目，磁盘也没有项目这一层。这几个片段让每个方法只写一遍。
  scopeWhere() { return this.scoped ? 'user_id=? AND project_id=?' : 'user_id=?' }
  scopeArgs(userId, project) { return this.scoped ? [userId, project] : [userId] }
  projectColumn() { return this.scoped ? 'project_id' : `'${DEFAULT_PROJECT_ID}' AS project_id` }

  path(value) {
    // 第一段不许是保留目录名（_artifacts / _blobs / .agent-sessions 这类）。
    // 老布局（没有项目层）下工作区的相对路径直接落在账号目录里，`_blobs/x` 会和 blob 存储
    // 撞在同一层——今天没有任何一行索引是这种形状，收紧不会误伤存量。
    if (!isWorkspacePath(value)) throw failure('文件路径无效')
    return value
  }

  // ---- 物理路径 ----

  // userId 来自数据库里的账号 id，仍然做一次校验，避免它被拼进路径时越权。
  userRoot(userId, { create = false }: Record<string, any> = {}) {
    const id = String(userId || '')
    // 保留目录（_artifacts / _blobs / .agent-sessions）不能当账号目录用，否则两边会互相覆盖。
    if (!validMediaOwner(id)) throw failure('文件路径无效')
    const root = join(mediaRoot(), id)
    // 用户目录首次写入时创建，权限 0700：同机其他账号不能直接读别人的素材。
    if (create) ensureMediaDirectory(root)
    return root
  }

  // 项目目录：<MEDIA_ROOT>/<userId>/<projectId>。projectId 的形状在 projects.ts 里收紧了，
  // 斜杠、.. 和 _artifacts 都进不来，所以拼进来的这一段一定只是一个普通目录名。
  projectRoot(userId, project, { create = false }: Record<string, any> = {}) {
    const id = requestedProject(project)
    if (!this.scoped) {
      // 老库只有默认项目，磁盘也没有项目这一层。带别的项目 id 进来要明确拒绝：
      // 放过去就等于把「项目 B」的文件写进账号根目录，两个项目会串在一起。
      if (id !== DEFAULT_PROJECT_ID) throw failure('工作区还没有迁移到多项目，请先运行 node scripts/migrate-projects.ts --apply', 409)
      return this.userRoot(userId, { create })
    }
    // 非默认项目必须确实是这个账号的项目。校验放在这一层，所有入口（工作区接口、节点插件、
    // Agent、MCP、ffmpeg）就都挡住了——别人的 id 和不存在的 id 一样是 404，不泄露存在性；
    // 也避免随便一个 id 就在账号下写出一堆没人认领的目录。
    if (id !== DEFAULT_PROJECT_ID && !this.store.get('SELECT 1 FROM projects WHERE user_id=? AND id=?', userId, id)) throw failure('项目不存在', 404)
    const root = this.userRoot(userId, { create })
    const scoped = join(root, id)
    if (create) ensureMediaDirectory(scoped)
    return scoped
  }

  // 相对路径 → 磁盘绝对路径。path() 已经挡掉 ..、绝对路径和反斜杠，
  // 这里再用 resolve + 前缀比较确认落点还在该项目目录内，并额外检查软链，
  // 保证任何情况下都不会写到项目目录之外。
  fileFor(userId, project, path, { create = false }: Record<string, any> = {}) {
    const target = this.path(path)
    const root = this.projectRoot(userId, project, { create })
    const absolute = resolve(root, ...target.split('/'))
    if (absolute !== root && !absolute.startsWith(root + sep)) throw failure('文件路径无效')
    const parent = dirname(absolute)
    if (create) ensureMediaDirectory(parent)
    let realRoot
    try { realRoot = realpathSync(root) } catch { return absolute }
    let realParent
    try { realParent = realpathSync(parent) } catch { return absolute }
    if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) throw failure('文件路径无效')
    try {
      if (lstatSync(absolute).isSymbolicLink()) throw failure('文件路径无效')
    } catch (error) {
      if (error && error.status) throw error
    }
    return absolute
  }

  // 索引行只写瘦字段，bytes 一律留 NULL。blob 非空表示字节在那份内容寻址的文件里，
  // storage 跟着写成 'blob'；路径树布局下 blob 是 NULL、storage='disk'，和以前完全一样。
  putIndex(userId, project, path, mime, size, revision, blob = null) {
    const storage = blob ? 'blob' : 'disk'
    if (!this.scoped) {
      this.store.run(
        `INSERT INTO workspace_files(user_id,path,mime,bytes,revision,updated_at,storage,size,blob) VALUES(?,?,?,NULL,?,?,?,?,?)
         ON CONFLICT(user_id,path) DO UPDATE SET mime=excluded.mime,bytes=NULL,revision=excluded.revision,updated_at=excluded.updated_at,storage=excluded.storage,size=excluded.size,blob=excluded.blob`,
        userId, path, mime, revision, now(), storage, size, blob)
      return
    }
    this.store.run(
      `INSERT INTO workspace_files(user_id,project_id,path,mime,bytes,revision,updated_at,storage,size,blob) VALUES(?,?,?,?,NULL,?,?,?,?,?)
       ON CONFLICT(user_id,project_id,path) DO UPDATE SET mime=excluded.mime,bytes=NULL,revision=excluded.revision,updated_at=excluded.updated_at,storage=excluded.storage,size=excluded.size,blob=excluded.blob`,
      userId, project, path, mime, revision, now(), storage, size, blob)
  }

  // 把一行索引变成字节：内容寻址布局下落进 blob 桶（同内容直接复用，不写第二份），
  // 路径树布局下写文件。返回 { blob, size }——size 是真实字节数，目录行是 0。
  // 每次写入都现读布局标记，不用构造时缓存的那份。
  // 迁移可以在服务运行期间跑完（--apply 的第 4 步翻标记），缓存住的话这个进程会继续往路径树里写：
  // 那时路径树已经开始被回收，新写进去的文件既没有 blob 引用、又可能被对账当成孤儿清掉。
  // 一次小查询换掉这个坑，值。
  currentLayout() {
    try { return mediaLayout(this.store) } catch { return this.layout }
  }

  assertWriteTarget(userId, project, path, mime, current) {
    const directory = isDirectoryMime(mime)
    if (current && directory !== isDirectoryMime(current.mime)) throw failure('文件和目录不能互相覆盖，请选择其他路径', 409)
    const where = this.scopeWhere(), args = this.scopeArgs(userId, project)
    const parts = path.split('/'), parents = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'))
    if (parents.length && this.store.get(`SELECT 1 FROM workspace_files WHERE ${where} AND path IN (${parents.map(() => '?').join(',')}) AND mime<>? LIMIT 1`, ...args, ...parents, 'inode/directory')) throw failure('父路径不是目录，请选择其他路径', 409)
    // Binary path ordering makes [path + '/', path + '0') an indexed range
    // containing exactly its descendants, without LIKE wildcard/case rules.
    if (!directory && this.store.get(`SELECT 1 FROM workspace_files WHERE ${where} AND path>=? AND path<? LIMIT 1`, ...args, path + '/', path + '0')) throw failure('目标路径下已有文件，不能替换成普通文件', 409)
    if (current && !directory && !this.isSystemPath(path) && !this.isCanvasFile(userId, path, project)) this.assertCanvasOriginal(userId, project, path, { mediaOnly: true, mime: current.mime })
  }

  isSystemPath(path) { return /^(assets|agent|settings|skills)(\/|$)/i.test(path) }

  referenceScopeFor(userId, project): WorkspaceReferenceScope {
    return this.referenceScope?.(userId, project)
      || { owner: this.referenceOwner?.(userId) || String(userId), project, defaultProject: DEFAULT_PROJECT_ID }
  }

  isCanvasFile(userId, path, project) {
    if (!/\.json$/i.test(path)) return false
    const file = this.locate(userId, path, project)
    if (!file.diskPath) return hasCanvasHeader(Buffer.from(file.bytes || []).subarray(0, 4096).toString('utf8'))
    const descriptor = openSync(file.diskPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    try {
      const bytes = Buffer.alloc(4096)
      return hasCanvasHeader(bytes.subarray(0, readSync(descriptor, bytes, 0, bytes.length, 0)).toString('utf8'))
    } finally { closeSync(descriptor) }
  }

  assertCanvasOriginal(userId, project, path, { mediaOnly = false, deleting = false, relocating = false, mime = '' } = {}) {
    if (this.isSystemPath(path)) return
    // File URLs follow their host's read scope; the cloud uses its public key.
    const scope = this.referenceScopeFor(userId, project)
    const key = JSON.stringify([String(userId), scope, this.store.activeAccount || ''])
    if (this.referenceCache?.key !== key) this.referenceCache = { key, canvases: new Map(), markdown: new Map() }
    const cache = this.referenceCache.canvases
    const inventory = this.store.all(`SELECT path,revision,mime FROM workspace_files WHERE ${this.scopeWhere()} AND mime<>? AND (lower(substr(path,-5))='.json' OR lower(substr(path,-3))='.md' OR lower(substr(path,-9))='.markdown' OR mime='text/markdown') ORDER BY path`, ...this.scopeArgs(userId, project), 'inode/directory')
    const rows = inventory.filter(row => /\.json$/i.test(row.path) && !/^(agent|assets)\//.test(row.path) && row.path.toLowerCase() !== 'settings/providers.json')
    const markdown = inventory.filter(row => (/\.(md|markdown)$/i.test(row.path) || row.mime === 'text/markdown') && !/^(agent|settings|skills)\//i.test(row.path))
    const affected = reference => (reference.path === path || reference.path.startsWith(path + '/')) && (!mediaOnly || reference.kind === 'media' || reference.kind === 'link' && /^(image|audio|video)\//i.test(mime))
    const known = new Set(rows.map(row => row.path))
    for (const cached of cache.keys()) if (!known.has(cached)) cache.delete(cached)
    for (const row of rows) {
      if (deleting && (row.path === path || row.path.startsWith(path + '/'))) continue
      let entry = cache.get(row.path)
      if (entry?.revision !== row.revision) {
        let references: CanvasFileReference[] = []
        try {
          if (this.isCanvasFile(userId, row.path, project)) {
            const canvas = JSON.parse(this.read(userId, row.path, project).bytes.toString('utf8'))
            if (!Array.isArray(canvas.nodes) || canvas.nodes.some(node => !node || typeof node.id !== 'string')) throw new Error('画布节点无效')
            references = canvasFileReferences(canvas.nodes, scope)
          }
        } catch { throw failure(t`无法确认画布 ${row.path} 的文件引用，原件已保留`, 409) }
        entry = { revision: row.revision, references }; cache.set(row.path, entry)
      }
      if (entry.references.some(affected)) {
        throw failure(t`该文件仍被画布 ${row.path} 作为原件使用，请保持原位，另存副本后整理`, 409)
      }
    }
    const markdownCache = this.referenceCache.markdown
    const knownMarkdown = new Set(markdown.map(row => row.path))
    for (const cached of markdownCache.keys()) if (!knownMarkdown.has(cached)) markdownCache.delete(cached)
    for (const row of markdown) {
      if ((deleting || relocating) && (row.path === path || row.path.startsWith(path + '/'))) continue
      let entry = markdownCache.get(row.path)
      if (entry?.revision !== row.revision) {
        try { entry = { revision: row.revision, references: markdownFileReferences(this.read(userId, row.path, project).bytes.toString('utf8'), row.path, scope) } }
        catch { throw failure(t`无法确认 ${row.path} 的素材引用，原件已保留`, 409) }
        markdownCache.set(row.path, entry)
      }
      if (entry.references.some(affected)) throw failure(t`该文件仍被文档 ${row.path} 作为原件使用，请保持原位，另存副本后整理`, 409)
    }
  }

  relocatedMarkdown(userId, project, row, sourceRoot, targetRoot) {
    if (isDirectoryMime(row.mime) || !isMarkdownFile(row.path, row.mime)) return
    const original = this.read(userId, row.path, project).bytes
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(original) }
    catch { throw failure(t`无法转换 Markdown ${row.path} 的编码，原文件已保留`, 422) }
    const next = rebaseMarkdownPaths(text, row.path, row.next, {
      mapPath: path => path === sourceRoot || path.startsWith(sourceRoot + '/') ? targetRoot + path.slice(sourceRoot.length) : path,
      scope: this.referenceScopeFor(userId, project),
    })
    if (next === text) return
    const bytes = Buffer.from(next, 'utf8')
    if (bytes.length > WORKSPACE_FILE_MAX_BYTES) throw failure('单个文件不能超过 200MB', 413)
    return bytes
  }

  assertCanvasCleanup(userId, project, path, directories: ReadonlySet<string>, rows) {
    if (!directories.size) return
    const removedFiles = new Set<string>(rows.filter(row => row.path === path || row.path.startsWith(path + '/')).map(row => row.path))
    const canvases = []
    for (const row of rows) {
      if (isDirectoryMime(row.mime) || !/\.json$/i.test(row.path) || /^agent\//i.test(row.path)
        || row.path.toLowerCase() === 'settings/providers.json') continue
      let bytes: Uint8Array
      try { bytes = this.read(userId, row.path, project).bytes }
      catch { throw failure(t`无法确认画布 ${row.path} 的文件引用，画布与素材均未删除`, 409) }
      const canvas = canvasCleanupDocument(bytes, row.path)
      if (canvas) canvases.push(canvas)
    }
    assertCanvasCleanupSafe({ directories: [...directories], removedFiles, canvases, files: rows,
      scope: this.referenceScopeFor(userId, project),
      readText: path => new TextDecoder('utf-8', { fatal: true }).decode(this.read(userId, path, project).bytes),
      activePaths: this.canvasCleanupReferences?.(userId, project) || [],
    })
  }

  place(userId, project, path, mime, bytes) {
    const layout = this.currentLayout()
    const current = this.store.get(`SELECT blob,storage,mime FROM workspace_files WHERE ${this.scopeWhere()} AND path=?`, ...this.scopeArgs(userId, project), path)
    this.assertWriteTarget(userId, project, path, mime, current)
    if (isDirectoryMime(mime)) {
      // 路径树布局下目录行在磁盘上是真目录（回滚镜像时还要用）；内容寻址布局下目录只活在索引里。
      if (layout !== MEDIA_LAYOUT_BLOB) {
        const absolute = this.fileFor(userId, project, path, { create: true })
        if (existsSync(absolute) && !lstatSync(absolute).isDirectory()) throw failure('目标路径已是文件，请选择其他目录名', 409)
        ensureMediaDirectory(absolute)
      } else this.projectRoot(userId, project)
      return { blob: null, size: 0 }
    }
    const content = Buffer.from(bytes)
    // Updating a path-backed file must not overwrite the bytes still owned by
    // its old index revision. Publish immutable bytes through the same commit.
    const immutable = layout === MEDIA_LAYOUT_BLOB || current?.blob || (current?.storage === 'disk' && !isDirectoryMime(current.mime))
    // An unindexed file or a case-insensitive alias may belong to another
    // revision. Keep those bytes intact and publish this write as a blob.
    const publishBlob = () => {
      const blob = this.blobs.put(userId, content)
      const retired = current?.blob && current.blob !== blob ? { path, blob: current.blob }
        : current?.storage === 'disk' && !current.blob ? { path, blob: null } : null
      return { blob, size: content.length, retired }
    }
    if (immutable) { this.projectRoot(userId, project); return publishBlob() }
    const absolute = this.fileFor(userId, project, path, { create: true })
    const physical = existsSync(absolute) ? lstatSync(absolute) : null
    if (physical && !physical.isFile()) throw failure('目标路径不是普通文件，请选择其他文件名', 409)
    if (physical) return publishBlob()
    // A path file is still invisible to readers until its index commits. Use
    // exclusive creation so a local file appearing after the check is preserved.
    try { writeFileSync(absolute, content, { flag: 'wx', mode: mediaPermissions().file }) }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const raced = this.fileFor(userId, project, path)
      if (!lstatSync(raced).isFile()) throw failure('目标路径不是普通文件，请选择其他文件名', 409)
      return publishBlob()
    }
    alignMediaOwner(absolute)
    return { blob: null, size: content.length }
  }

  // 落字节 + 改索引。先字节后索引：索引写失败会抛错，调用方不会拿到成功，
  // 磁盘上最坏是多一份没人认领的字节，由 media-reconcile 报告并回收。
  write(userId, project, path, mime, bytes) {
    const write = () => {
      this.userMutationGuard?.(userId, project, { operation: 'write', path })
      const revision = randomUUID()
      const placed = this.place(userId, project, path, mime, bytes)
      this.putIndex(userId, project, path, mime, placed.size, revision, placed.blob)
      if ('retired' in placed && placed.retired) this.deferBytes(userId, project, [placed.retired])
      return revision
    }
    // 写字节与索引共用数据库写锁，不能让后台回收插入这两个步骤之间。
    return this.store.db?.isTransaction ? write() : this.withDeferredBytes(write)
  }

  // ---- 迁移 ----

  // 幂等：把 bytes 列里的历史数据搬到磁盘，索引改成 storage='disk'、bytes 置 NULL。
  // 逐行事务，单行失败只记日志继续处理其余行；中途崩溃后重跑即可（未搬的行仍是 storage='db'）。
  migrateToDisk() {
    const before = this.store.get('SELECT COUNT(*) AS rows, COALESCE(SUM(length(bytes)),0) AS bytes FROM workspace_files')
    const project = this.scoped ? 'project_id' : `'${DEFAULT_PROJECT_ID}' AS project_id`
    const pending = this.store.all(`SELECT user_id,${project},path,mime,bytes FROM workspace_files WHERE storage<>'disk' AND bytes IS NOT NULL`)
    if (!pending.length) return { migrated: 0, failed: 0, bytes: 0 }
    console.log(`[workspace] 开始把工作区文件搬到磁盘：索引 ${before.rows} 行 / ${before.bytes} 字节，本次待迁 ${pending.length} 个文件，MEDIA_ROOT=${mediaRoot()}`)
    let migrated = 0
    let failed = 0
    let moved = 0
    for (const row of pending) {
      const content = Buffer.from(row.bytes)
      try {
        const placed = this.place(row.user_id, row.project_id, row.path, row.mime, content)
        this.store.transaction(() => {
          this.store.run(`UPDATE workspace_files SET bytes=NULL,storage=?,size=?,blob=? WHERE ${this.scopeWhere()} AND path=?`, placed.blob ? 'blob' : 'disk', placed.size, placed.blob, ...this.scopeArgs(row.user_id, row.project_id), row.path)
        })
        migrated += 1
        moved += content.length
      } catch (error) {
        failed += 1
        console.error(`[workspace] 迁移失败，这一行保留在数据库里下次重试：user=${row.user_id} project=${row.project_id} path=${row.path} ${error?.message || error}`)
      }
    }
    const after = this.store.get('SELECT COUNT(*) AS rows, COALESCE(SUM(length(bytes)),0) AS bytes FROM workspace_files')
    console.log(`[workspace] 迁移结束：成功 ${migrated} 个 / ${moved} 字节，失败 ${failed} 个；索引 ${after.rows} 行（迁移前 ${before.rows}），bytes 剩余 ${after.bytes} 字节（迁移前 ${before.bytes}）`)
    return { migrated, failed, bytes: moved }
  }

  // ---- 读 ----

  // 旧版把画布 JSON 存在 workspace_state.canvas_files 里，首次访问时逐条搬到文件存储。
  migrate(userId, project) {
    const old = this.store.workspaceForUser(userId, project).canvasFiles
    if (!Object.keys(old).length) return
    this.withDeferredBytes(() => {
      for (const [path, content] of Object.entries(old)) {
        if (typeof content !== 'string') continue
        const target = this.path(path)
        if (this.store.get(`SELECT 1 FROM workspace_files WHERE ${this.scopeWhere()} AND path=?`, ...this.scopeArgs(userId, project), target)) continue
        this.write(userId, project, target, 'application/json', Buffer.from(content))
      }
      this.store.run(this.scoped
        ? "UPDATE workspace_state SET canvas_files='{}' WHERE user_id=? AND project_id=?"
        : "UPDATE workspace_state SET canvas_files='{}' WHERE user_id=?", ...this.scopeArgs(userId, project))
    })
  }

  // 索引 + 磁盘（未迁移时回退 bytes 列）合起来定位一个文件；HTTP 层可以直接拿 diskPath 流式发送。
  locate(userId, path, project?: any) {
    const target = this.path(path)
    const scope = requestedProject(project)
    const row = this.store.get(`SELECT ${this.projectColumn()},path,mime,bytes,revision,updated_at,storage,blob FROM workspace_files WHERE ${this.scopeWhere()} AND path=?`, ...this.scopeArgs(userId, scope), target)
    if (!row) throw failure('文件不存在', 404)
    // 目录行没有字节，保持老行为：读接口拿到一个 0 字节的空响应。
    if (isDirectoryMime(row.mime)) return { project: row.project_id, path: row.path, mime: row.mime, revision: row.revision, updated_at: row.updated_at, size: 0, storage: row.storage, diskPath: null, bytes: Buffer.alloc(0) }
    // 内容寻址：字节在 blob 桶里，diskPath 直接指向它——nginx 直出跟的就是这个 diskPath，
    // 所以索引怎么变都不用动 nginx（曾经按 userId/project/path 自己拼一遍，拼错了让所有媒体 404）。
    if (row.blob) {
      const info = this.blobs.stat(userId, row.blob)
      if (!info) {
        console.warn(`[workspace] 索引存在但 blob 缺失（数据丢失，跑 node server/media-reconcile.ts 看完整清单）：user=${userId} project=${row.project_id} path=${row.path} blob=${row.blob}`)
        throw failure('文件不存在', 404)
      }
      return { project: row.project_id, path: row.path, mime: row.mime, revision: row.revision, updated_at: row.updated_at, size: info.size, storage: 'blob', blob: row.blob, diskPath: info.full, bytes: null }
    }
    if (row.storage === 'disk') {
      const absolute = this.fileFor(userId, row.project_id, row.path)
      let info = null
      try { info = statSync(absolute) } catch { /* 缺失，统一按 404 处理 */ }
      if (!info?.isFile()) {
        // 索引在、文件没了：记一条日志，方便和 media-reconcile 的报告对照。
        console.warn(`[workspace] 索引存在但磁盘文件缺失：user=${userId} project=${row.project_id} path=${row.path} file=${absolute}`)
        throw failure('文件不存在', 404)
      }
      return { project: row.project_id, path: row.path, mime: row.mime, revision: row.revision, updated_at: row.updated_at, size: info.size, storage: 'disk', diskPath: absolute, bytes: null }
    }
    const bytes = row.bytes ? Buffer.from(row.bytes) : Buffer.alloc(0)
    return { project: row.project_id, path: row.path, mime: row.mime, revision: row.revision, updated_at: row.updated_at, size: bytes.length, storage: 'db', diskPath: null, bytes }
  }

  read(userId, path, project) {
    const file = this.locate(userId, path, project)
    if (!file.bytes) file.bytes = readFileSync(file.diskPath)
    return file
  }

  list(userId, project) {
    const scope = requestedProject(project)
    this.migrate(userId, scope)
    const entries = this.store.all(`SELECT path,mime,size,revision,updated_at AS updatedAt FROM workspace_files WHERE ${this.scopeWhere()} ORDER BY path`, ...this.scopeArgs(userId, scope))
    return this.userListFilter ? this.userListFilter(userId, scope, entries) : entries
  }

  listSnapshot(userId, project) {
    const scope = requestedProject(project)
    const entries = this.list(userId, scope)
    const filesRevision = createHash('sha256').update(JSON.stringify([String(userId), scope, entries.map(entry => [entry.path, entry.revision])])).digest('hex')
    return { entries, filesRevision }
  }

  // 技能列表只读取技能索引，避开整个项目的媒体和聊天文件列表。
  listSkillFiles(userId, project) {
    const scope = requestedProject(project)
    return this.store.all(
      `SELECT path,mime,size,revision,updated_at AS updatedAt FROM workspace_files WHERE ${this.scopeWhere()} AND path>='skills/' AND path<'skills0' AND path GLOB 'skills/*/SKILL.md' ORDER BY path`,
      ...this.scopeArgs(userId, scope))
  }

  // 只读索引，不碰磁盘：目录列表和存在性判断不应该因为某个文件缺失而变慢或报错。
  stat(userId, path, project) {
    const row = this.store.get(`SELECT path,mime,size,revision,updated_at FROM workspace_files WHERE ${this.scopeWhere()} AND path=?`, ...this.scopeArgs(userId, requestedProject(project)), this.path(path))
    if (!row) throw failure('文件不存在', 404)
    return row
  }

  // ---- 项目 ----

  // 项目列表里的「文件数」：目录行不算文件，否则数字会比用户看到的多一截。
  // 老库没有项目维度，所有行就是默认项目的。
  fileCounts(userId) {
    const counts = new Map()
    if (!this.scoped) {
      const row = this.store.get("SELECT COUNT(*) AS n FROM workspace_files WHERE user_id=? AND mime<>'inode/directory'", userId)
      counts.set(DEFAULT_PROJECT_ID, row?.n || 0)
      return counts
    }
    for (const row of this.store.all("SELECT project_id, COUNT(*) AS n FROM workspace_files WHERE user_id=? AND mime<>'inode/directory' GROUP BY project_id", userId)) counts.set(row.project_id, row.n)
    return counts
  }

  // 删项目：索引和 projects 行在一个事务里删掉，提交后再递归删磁盘目录。
  // 顺序是刻意的——先让索引消失（用户立刻看不到这个项目），再删字节。
  // 反过来先删字节的话，中途失败会留下「索引还在、文件打不开」的项目，用户看得见但全 404；
  // 现在最坏是残留一个没有索引的项目目录，用户看不见，由 media-reconcile 报出来并回收。
  removeProject(userId, project, { preserveDefault = false }: { preserveDefault?: boolean } = {}) {
    const id = requestedProject(project)
    if (!this.scoped) throw failure('工作区还没有迁移到多项目，请先运行 node scripts/migrate-projects.ts --apply', 409)
    if (id === DEFAULT_PROJECT_ID && !preserveDefault) throw failure('默认项目不能删除')
    return this.withDeferredBytes(() => {
      const root = this.projectRoot(userId, id)
      const stats = this.store.get('SELECT COUNT(*) AS rows, COALESCE(SUM(size),0) AS bytes FROM workspace_files WHERE user_id=? AND project_id=?', userId, id)
      const rows = this.store.all('SELECT path,blob FROM workspace_files WHERE user_id=? AND project_id=?', userId, id)
      this.store.run('DELETE FROM workspace_files WHERE user_id=? AND project_id=?', userId, id)
      this.store.run('DELETE FROM workspace_state WHERE user_id=? AND project_id=?', userId, id)
      if (id === DEFAULT_PROJECT_ID) this.store.run("UPDATE projects SET last_opened_at=NULL WHERE user_id=? AND id=?", userId, id)
      else this.store.run('DELETE FROM projects WHERE user_id=? AND id=?', userId, id)
      this.deferBytes(userId, id, rows, { projectRoot: root })
      return { rows: stats.rows, bytes: stats.bytes }
    })
  }

  // ---- 写 ----

  // 服务端内部写入（Agent 对话等）：不做修订号校验，直接落盘并返回新修订号。
  upsert(userId, path, mime, bytes, project) {
    const target = this.path(path)
    const content = Buffer.from(bytes)
    if (content.length > WORKSPACE_FILE_MAX_BYTES) throw failure('单个文件不能超过 200MB', 413)
    return this.write(userId, requestedProject(project), target, mime, content)
  }

  // Package files use the existing immutable blob store even in a path-layout
  // workspace. One SQLite commit publishes the complete set; an interrupted
  // transaction leaves the old paths, bytes and revisions intact. No directory
  // swap or separate recovery journal is needed.
  replaceTree(userId, path, entries, { expected = [], project }: Record<string, any> = {}) {
    if (this.store.db?.isTransaction) throw failure('文件更新正在进行，请稍后重试', 409)
    const target = this.path(path), scope = requestedProject(project)
    const names = new Set<string>()
    const prepared = entries.map(entry => {
      const path = this.path(entry.path), bytes = Buffer.isBuffer(entry.bytes) ? entry.bytes : Buffer.from(entry.bytes)
      if (!path.startsWith(target + '/') || names.has(path.toLowerCase())) throw failure('文件更新路径冲突', 422)
      if (bytes.length > WORKSPACE_FILE_MAX_BYTES) throw failure('单个文件不能超过 200MB', 413)
      names.add(path.toLowerCase())
      return { path, bytes, mime: cleanMime(entry.mime), revision: randomUUID() }
    })
    if (!prepared.length) throw failure('没有可安装的文件', 422)
    for (const entry of prepared) {
      const parts = entry.path.toLowerCase().split('/')
      while (parts.pop() && parts.length) if (names.has(parts.join('/'))) throw failure('文件更新路径冲突', 422)
    }
    const args = this.scopeArgs(userId, scope), where = this.scopeWhere()
    let previous = []
    this.store.transaction(() => {
      this.projectRoot(userId, scope)
      const current = this.store.all(`SELECT path,mime,revision,blob FROM workspace_files WHERE ${where}`, ...args)
      if (current.some(row => (row.path === target || target.startsWith(row.path + '/')) && !isDirectoryMime(row.mime))) throw failure('技能目录被其他文件占用', 409)
      previous = current.filter(row => row.path === target || row.path.startsWith(target + '/'))
      const revisions = new Map(expected.map(entry => [entry.path, entry.revision]))
      if (previous.length !== revisions.size || previous.some(row => revisions.get(row.path) !== row.revision)) throw failure('技能文件已发生变化，请重新确认后再安装', 409)
      const next = prepared.map(entry => ({ ...entry, blob: this.blobs.put(userId, entry.bytes) }))
      for (const row of previous) this.store.run(`DELETE FROM workspace_files WHERE ${where} AND path=?`, ...args, row.path)
      for (const entry of next) this.putIndex(userId, scope, entry.path, entry.mime, entry.bytes.length, entry.revision, entry.blob)
    })
    // Cleanup cannot undo a committed install. Another process may have since
    // written a new path-backed file, so recheck under the database write lock.
    try {
      this.store.transaction(() => {
        const retired = previous.filter(row => row.blob || this.store.get(`SELECT storage FROM workspace_files WHERE ${where} AND path=?`, ...args, row.path)?.storage !== 'disk')
        this.dropBytes(userId, scope, retired)
      })
    } catch (error) { console.warn('[workspace] 旧技能文件回收失败，交给对账回收', error?.code || 'unknown') }
    return { files: prepared.length }
  }

  // 浏览器上传二进制媒体时使用原始请求体，避免 Base64 额外膨胀和 JSON 解析占用。
  // 修订号检查和发布必须共用数据库写锁；同步调用仍可能被其他进程的提交穿插。
  writeBytes(userId, { path, mime, bytes, revision = null, project }: Record<string, any>) {
    const target = this.path(path)
    const scope = requestedProject(project)
    const content = Buffer.from(bytes)
    if (content.length > WORKSPACE_FILE_MAX_BYTES) throw failure('单个文件不能超过 200MB', 413)
    return this.withDeferredBytes(() => {
      this.userMutationGuard?.(userId, scope, { operation: 'write', path: target })
      const current = this.store.get(`SELECT revision FROM workspace_files WHERE ${this.scopeWhere()} AND path=?`, ...this.scopeArgs(userId, scope), target)
      if (revision !== (current?.revision ?? null)) throw failure('文件已在其他页面更新，请刷新后再编辑；当前改动未覆盖服务器数据', 409)
      return { revision: this.write(userId, scope, target, cleanMime(mime), content) }
    })
  }

  // FFmpeg may produce several files. Keep every streamed temporary leased until
  // all are ready, then publish immutable blobs and indexes in one transaction.
  // No file becomes visible if a later output fails or another writer intervenes.
  async importFiles(userId, entries: { path: string; mime: string; source: string; revision?: string | null }[],
    { signal, beforeCommit, maxBytes = WORKSPACE_FILE_MAX_BYTES, project }: {
      signal?: AbortSignal; beforeCommit?: (path: string) => void; maxBytes?: number; project?: string
    } = {}) {
    const scope = requestedProject(project)
    const seen = new Set<string>()
    const assertTarget = (path, mime, current) => {
      this.assertWriteTarget(userId, scope, path, mime, current)
      const absolute = this.fileFor(userId, scope, path)
      if (existsSync(absolute) && !lstatSync(absolute).isFile()) throw failure('目标路径不是普通文件，请选择其他文件名', 409)
    }
    const targets = entries.map(entry => {
      const path = this.path(entry.path), mime = cleanMime(entry.mime)
      if (mime === 'inode/directory' || seen.has(path.toLowerCase())) throw failure('媒体输出路径重复或不是普通文件', 422)
      seen.add(path.toLowerCase())
      const current = this.store.get(`SELECT mime,revision FROM workspace_files WHERE ${this.scopeWhere()} AND path=?`, ...this.scopeArgs(userId, scope), path)
      assertTarget(path, mime, current)
      const revision = Object.hasOwn(entry, 'revision') ? entry.revision : current?.revision ?? null
      if (revision !== null && typeof revision !== 'string') throw failure('媒体输出修订号无效', 422)
      if (revision !== (current?.revision ?? null)) throw failure('媒体输出文件已更新，本次结果未覆盖现有文件', 409)
      return { ...entry, path, mime, revision }
    })
    if (!targets.length) return []
    const stagePath = join(this.projectRoot(userId, scope, { create: true }), '_media-batch')
    const prepared: (typeof targets[number] & { temp: string; size: number; sha256: string })[] = []
    const stage = async (index: number, activeSignal?: AbortSignal) => {
      activeSignal?.throwIfAborted()
      if (index < targets.length) {
        const entry = targets[index]
        return withStreamedMedia(createReadStream(entry.source), { path: stagePath, signal: activeSignal, maxBytes }, (file, leaseSignal) => {
          prepared.push({ ...entry, temp: file.path, size: file.size, sha256: file.sha256 })
          return stage(index + 1, leaseSignal)
        })
      }
      return this.withDeferredBytes(() => {
        const previous = prepared.map(entry => {
          activeSignal?.throwIfAborted()
          beforeCommit?.(entry.path)
          this.userMutationGuard?.(userId, scope, { operation: 'write', path: entry.path })
          const current = this.store.get(`SELECT mime,revision,blob,storage FROM workspace_files WHERE ${this.scopeWhere()} AND path=?`, ...this.scopeArgs(userId, scope), entry.path)
          if (entry.revision !== (current?.revision ?? null)) throw failure('媒体输出文件已更新，本次结果未覆盖现有文件', 409)
          assertTarget(entry.path, entry.mime, current)
          return current
        })
        return prepared.map((entry, index) => {
          // Validate again after earlier outputs enter the same transaction, so
          // one output cannot become another output's parent file.
          this.assertWriteTarget(userId, scope, entry.path, entry.mime, previous[index])
          this.blobs.linkFromFile(userId, entry.temp, entry.sha256, { copyFallback: true })
          const revision = randomUUID()
          this.putIndex(userId, scope, entry.path, entry.mime, entry.size, revision, entry.sha256)
          const current = previous[index]
          if (current?.blob && current.blob !== entry.sha256) this.deferBytes(userId, scope, [{ path: entry.path, blob: current.blob }])
          else if (current?.storage === 'disk' && !current.blob) this.deferBytes(userId, scope, [{ path: entry.path, blob: null }])
          return { path: entry.path, revision, size: entry.size, sha256: entry.sha256 }
        })
      })
    }
    return stage(0, signal)
  }

  // ---- 删 / 改 ----

  // 事务里只登记，事务提交之后才动字节。**顺序不能反**：
  // 在事务里删字节，事务一旦回滚就是「引用还在、字节没了」——那是最严重的一类数据丢失，
  // 对账只能报出来、救不回来。登记制保证「字节被删」这件事只发生在引用确实已经落库删除之后。
  deferBytes(userId, project, rows, { projectRoot }: { projectRoot?: string } = {}) {
    if (rows.length || projectRoot) this.pendingBytes.push({ userId, project, rows, projectRoot })
  }

  withDeferredBytes(operation) {
    const start = this.pendingBytes.length
    let result
    try { result = this.store.db?.isTransaction ? operation() : this.store.transaction(operation) }
    catch (error) { this.pendingBytes.splice(start); throw error }
    this.flushBytes()
    return result
  }

  flushBytes() {
    // A nested caller cannot reclaim bytes before its enclosing commit.
    if (this.store.db?.isTransaction) return
    const pending = this.pendingBytes
    this.pendingBytes = []
    for (const item of pending) {
      try {
        this.store.transaction(() => {
          if (item.projectRoot) {
            // The enclosing transaction may have rolled back, or a restore may
            // have recreated this project since deletion committed. Keep its
            // entire directory in either case; hold the write lock until done.
            if (this.store.get('SELECT 1 FROM projects WHERE user_id=? AND id=?', item.userId, item.project)) return
            this.dropBytes(item.userId, item.project, item.rows.filter(row => row.blob))
            rmSync(item.projectRoot, { recursive: true, force: true })
            return
          }
          // A rolled-back outer transaction or a concurrent writer can retain
          // or recreate a path-backed file. A blob row uses separate bytes and
          // does not keep an obsolete path file alive after a successful update.
          const rows = item.rows.filter(row => row.blob || this.store.get(`SELECT storage FROM workspace_files WHERE ${this.scopeWhere()} AND path=?`, ...this.scopeArgs(item.userId, item.project), typeof row === 'string' ? row : row.path)?.storage !== 'disk')
          this.dropBytes(item.userId, item.project, rows)
        })
      } catch (error) {
        console.warn(`[workspace] 处理待回收字节时出错，交给对账回收：user=${item.userId} project=${item.project} ${error?.message || error}`)
      }
    }
  }

  // 一行引用消失之后，字节该怎么处理。
  //
  // 内容寻址的行（有 blob）：**删的是引用，不是字节**。画布上删掉一个节点、一条画布，
  // 只要生成历史里那条引用还指向同一份字节，字节就必须留着——用户从历史里还要能找回来。
  // 只有活跃集合里再没有任何一行指向它，release() 才会真正回收。
  // 路径树布局的行（没有 blob）：磁盘上有实体文件，照老办法删。
  dropBytes(userId, project, rows) {
    const blobs = new Set()
    const directories = new Set()
    for (const row of rows) {
      const blob = typeof row === 'string' ? null : row.blob
      const path = typeof row === 'string' ? row : row.path
      if (blob) { blobs.add(blob); continue }
      try {
        const absolute = this.fileFor(userId, project, path)
        try { rmSync(absolute, { force: true }) } catch (error) {
          if (error?.code !== 'ERR_FS_EISDIR') throw error
          // 目录行落在磁盘上就是目录，rmSync 删不掉它，交给下面的空目录回收。
          directories.add(absolute)
        }
        directories.add(dirname(absolute))
      } catch (error) {
        console.warn(`[workspace] 删除磁盘文件失败，留给对账回收：user=${userId} project=${project} path=${path} ${error?.message || error}`)
      }
    }
    for (const blob of blobs) {
      try { this.blobs.release(userId, blob) } catch (error) {
        console.warn(`[workspace] 回收 blob 失败，留给对账回收：user=${userId} blob=${blob} ${error?.message || error}`)
      }
    }
    for (const directory of directories) this.pruneEmptyDirectories(userId, project, directory)
  }

  // 只删空目录，一路往上直到项目目录为止（老库里就是账号目录）；非空就停。
  pruneEmptyDirectories(userId, project, directory) {
    let root
    try { root = this.projectRoot(userId, project) } catch { return }
    let current = directory
    while (current !== root && current.startsWith(root + sep)) {
      try { rmdirSync(current) } catch { return }
      current = dirname(current)
    }
  }

  // Callers may guard a whole package with its manifest's current revision.
  removeTree(userId, path, project, guard?: { path: string; revision: string }) {
    const target = this.path(path)
    const scope = requestedProject(project)
    const guardPath = guard ? this.path(guard.path) : null
    if (guardPath && guardPath !== target && !guardPath.startsWith(target + '/')) throw failure('删除校验路径不属于目标目录', 422)
    const result = this.withDeferredBytes(() => {
      if (guard) {
        const current = this.store.get(`SELECT revision FROM workspace_files WHERE ${this.scopeWhere()} AND path=?`, ...this.scopeArgs(userId, scope), guardPath)
        if (!current || current.revision !== guard.revision) throw failure('技能文件已发生变化，请重新确认后再删除', 409)
      }
      const rows = this.store.all(`SELECT path,blob FROM workspace_files WHERE ${this.scopeWhere()}`, ...this.scopeArgs(userId, scope)).filter(row => row.path === target || row.path.startsWith(`${target}/`))
      if (!rows.length) throw failure('文件不存在', 404)
      for (const row of rows) this.store.run(`DELETE FROM workspace_files WHERE ${this.scopeWhere()} AND path=?`, ...this.scopeArgs(userId, scope), row.path)
      this.deferBytes(userId, scope, rows)
      return { removed: rows.length }
    })
    return result
  }

  // Copy and rename use the same namespace rules. Validate the whole target
  // tree before importing bytes, including paths that are not indexed yet.
  treeTargets(userId, project, path, value, { allowCaseRename = false } = {}) {
    const target = this.path(value)
    if (target === path || target.startsWith(path + '/')) throw failure('目标路径无效')
    this.projectRoot(userId, project)
    const all = this.store.all(`SELECT path,mime,storage,blob,size,revision FROM workspace_files WHERE ${this.scopeWhere()}`, ...this.scopeArgs(userId, project))
    const rows = all.filter(row => row.path === path || row.path.startsWith(path + '/'))
      .sort((a, b) => a.path.length - b.path.length)
      .map(row => ({ ...row, next: this.path(target + row.path.slice(path.length)) }))
    if (!rows.length) throw failure('文件不存在', 404)
    if (all.some(row => row.path === target || row.path.startsWith(target + '/') || (target.startsWith(row.path + '/') && !isDirectoryMime(row.mime)))) throw failure('目标文件已存在', 409)
    for (const row of rows) {
      const destination = this.fileFor(userId, project, row.next)
      if (existsSync(destination)) {
        const info = lstatSync(destination)
        const source = allowCaseRename && row.storage === 'disk' && !row.blob && row.path.toLowerCase() === row.next.toLowerCase()
          ? lstatSync(this.fileFor(userId, project, row.path)) : null
        const sameFile = source && source.dev === info.dev && source.ino === info.ino
        if (!sameFile && (!isDirectoryMime(row.mime) || !info.isDirectory())) throw failure('目标文件已存在', 409)
      }
    }
    return rows
  }

  // payload.project 由 HTTP 层确认过归属后写进来，这里只校验形状。
  mutate(userId, payload) {
    const path = this.path(payload.path)
    const project = requestedProject(payload.project)
    let rollbackRemoval: (() => void) | void
    let result
    try { result = this.withDeferredBytes(() => {
      this.userMutationGuard?.(userId, project, payload)
      const where = this.scopeWhere()
      const args = this.scopeArgs(userId, project)
      const current = this.store.get(`SELECT path,mime,bytes,revision,storage,blob FROM workspace_files WHERE ${where} AND path=?`, ...args, path)
      if (payload.operation === 'saveCanvas') {
        if (!current) throw failure('画布已在其他页面删除或改名，本页改动尚未保存', 409)
        if (!Object.hasOwn(payload, 'revision') || !validCanvas(payload.canvas) || !validCanvas(payload.base)) throw failure('画布保存数据无效')
        const stored = JSON.parse(this.read(userId, path, project).bytes.toString('utf8'))
        if (!validCanvas(stored)) throw failure('画布文件格式无效', 409)
        let canvas = persistentCanvas(payload.canvas)
        const merged = payload.revision !== current.revision
        if (merged) {
          const result = mergeCanvasState(payload.base, canvas, stored)
          if (result.conflicts.length) throw failure('画布已在其他页面更新，请刷新页面后继续', 409)
          canvas = result.canvas
        }
        const bytes = Buffer.from(JSON.stringify(canvas))
        if (bytes.length > WORKSPACE_FILE_MAX_BYTES) throw failure('单个文件不能超过 200MB', 413)
        const revision = JSON.stringify(stored) === bytes.toString('utf8') ? current.revision
          : this.write(userId, project, path, 'application/json', bytes)
        return { revision, canvas, merged }
      }
      // Old pages cannot promote a list/header revision into permission to overwrite a canvas.
      if (current && payload.operation === 'write' && payload.encoding === 'text' && /\.json$/i.test(path)) {
        let incoming
        try { incoming = JSON.parse(payload.content) } catch {}
        if (hasCanvasMarker(incoming)) throw failure('画布保存已升级，请先保留本页内容再刷新页面；服务器内容未被覆盖', 409)
      }
      if (!Object.hasOwn(payload, 'revision') || payload.revision !== (current?.revision ?? null)) throw failure('文件已在其他页面更新，请刷新后再编辑；当前改动未覆盖服务器数据', 409)
      if (['remove', 'rename', 'copy'].includes(payload.operation)) {
        const sources = this.store.all(`SELECT path,mime,revision FROM workspace_files WHERE ${where} AND (path=? OR (path>=? AND path<?)) ORDER BY path`, ...args, path, path + '/', path + '0')
        assertWorkspaceTreeSnapshot(path, sources, payload)
      }
      if (payload.operation === 'write') {
        if (typeof payload.content !== 'string' || !['text', 'base64'].includes(payload.encoding)) throw failure('文件内容无效')
        const bytes = Buffer.from(payload.content, payload.encoding === 'base64' ? 'base64' : 'utf8')
        if (bytes.length > WORKSPACE_FILE_MAX_BYTES) throw failure('单个文件不能超过 200MB', 413)
        return { revision: this.write(userId, project, path, cleanMime(payload.mime), bytes) }
      }
      // Nested writes need not create a directory row. All tree operations
      // resolve these implicit directories by their indexed descendants.
      if (!current && !['remove', 'copy', 'rename'].includes(payload.operation)) throw failure('文件不存在', 404)
      if (payload.operation === 'rename') {
        this.assertCanvasOriginal(userId, project, path, { relocating: true })
        const rows = this.treeTargets(userId, project, path, payload.target, { allowCaseRename: true })
        const target = this.path(payload.target)
        const entries = []
        for (const row of rows) {
          const next = row.next
          let blob = row.blob, size = row.size, storage = row.storage
          const content = this.relocatedMarkdown(userId, project, row, path, target)
          if (content) {
            blob = this.blobs.put(userId, content); size = content.length; storage = 'blob'
          } else if (isDirectoryMime(row.mime)) this.place(userId, project, next, row.mime, Buffer.alloc(0))
          else if (blob) {
            if (!this.blobs.stat(userId, blob)) throw failure('文件不存在', 404)
          } else if (storage === 'disk') {
            // Preserve the old path until the whole index transaction commits.
            // Later renames reuse the blob and only update the index.
            const prepared = this.blobs.putFile(userId, this.fileFor(userId, project, row.path))
            blob = prepared.blob; size = prepared.size; storage = 'blob'
          }
          // Moving unchanged bytes preserves their version. This also lets a
          // client identify a committed move after losing its receipt. Markdown
          // whose destinations changed receives a new content revision.
          const revision = content ? randomUUID() : row.revision
          this.store.run(`UPDATE workspace_files SET path=?,revision=?,updated_at=?,storage=?,blob=?,size=?,bytes=CASE WHEN ? THEN NULL ELSE bytes END WHERE ${where} AND path=?`, next, revision, now(), storage, blob, size, content ? 1 : 0, ...args, row.path)
          if (row.blob && row.blob !== blob) this.deferBytes(userId, project, [{ path: row.path, blob: row.blob }])
          entries.push({ path: next, revision })
        }
        this.deferBytes(userId, project, rows.filter(row => row.storage === 'disk' && !row.blob))
        return { revision: null, entries }
      } else if (payload.operation === 'remove') {
        this.assertCanvasOriginal(userId, project, path, { deleting: true })
        if (payload.recursive !== undefined && typeof payload.recursive !== 'boolean') throw failure('删除选项无效', 422)
        if (payload.trash !== undefined && typeof payload.trash !== 'boolean') throw failure('删除选项无效', 422)
        const cleanup = new Set<string>()
        if (payload.canvasCleanup !== undefined) {
          const value = payload.canvasCleanup
          if (!value || typeof value !== 'object' || !Array.isArray(value.directories)
            || typeof value.filesRevision !== 'string' || !/^[a-f0-9]{64}$/.test(value.filesRevision)) throw failure('画布素材清理数据无效', 422)
          for (const directory of value.directories) {
            if (typeof directory !== 'string' || !/^assets\/[^/]+$/.test(directory) || cleanup.has(directory)) throw failure('画布素材清理目录无效', 422)
            cleanup.add(this.path(directory))
          }
          if (this.listSnapshot(userId, project).filesRevision !== value.filesRevision) throw failure('项目文件已更新，画布与素材均未删除，请重新操作', 409)
          for (const directory of cleanup) this.userMutationGuard?.(userId, project, { operation: 'remove', path: directory })
        }
        const rows = this.store.all(`SELECT path,mime,blob FROM workspace_files WHERE ${where}`, ...args)
        const main = rows.filter(row => row.path === path || row.path.startsWith(path + '/'))
        if (!main.length) throw failure('文件不存在', 404)
        if (payload.recursive === false && main.some(row => row.path !== path)) throw failure('目录内仍有文件，未删除', 409)
        this.assertCanvasCleanup(userId, project, path, cleanup, rows)
        const targets = rows.filter(row => row.path === path || row.path.startsWith(path + '/') || cleanup.has(row.path.split('/').slice(0, 2).join('/')))
        if (payload.discard !== true) rollbackRemoval = this.beforeRemove?.(userId, project, targets, { trash: payload.trash === true, path })
        for (const row of targets) this.store.run(`DELETE FROM workspace_files WHERE ${where} AND path=?`, ...args, row.path)
        this.deferBytes(userId, project, targets)
      } else if (payload.operation === 'copy') {
        if (payload.copies !== undefined) {
          if (!Array.isArray(payload.copies) || !payload.copies.length || payload.copies.length > 100) throw failure('素材复制数据无效', 422)
          const destinations = new Set<string>()
          const copies = payload.copies.map(item => {
            const source = this.path(item?.path), target = this.path(item?.target)
            if (typeof item.revision !== 'string' || !item.revision || destinations.has(target)) throw failure('素材复制路径或版本无效', 422)
            destinations.add(target)
            const row = this.stat(userId, source, project)
            if (row.mime === 'inode/directory') throw failure('批量素材复制只支持普通文件', 422)
            return { path: source, target, revision: item.revision }
          })
          return { revision: null, entries: copies.flatMap(item => this.mutate(userId, { ...item, project, operation: 'copy' }).entries) }
        }
        const sources = this.treeTargets(userId, project, path, payload.target)
        const copies = prepareCanvasCopies(sources, payload, source => this.read(userId, source, project).bytes, WORKSPACE_FILE_MAX_BYTES)
        const entries = []
        for (const row of sources) {
          const next = row.next
          const revision = randomUUID()
          const canvasCopy = copies.get(row.path)
          const content = canvasCopy ?? this.relocatedMarkdown(userId, project, row, path, this.path(payload.target))
          if (content) {
            const blob = this.blobs.put(userId, content)
            this.putIndex(userId, project, next, canvasCopy ? 'application/json' : row.mime, content.length, revision, blob)
            entries.push({ path: next, revision })
            continue
          }
          if (isDirectoryMime(row.mime)) {
            this.place(userId, project, next, row.mime, null)
            this.putIndex(userId, project, next, row.mime, 0, revision, null)
            entries.push({ path: next, revision })
            continue
          }
          // 内容寻址：复制**只多一行索引**，指向同一份字节，一个字节都不复制。
          // 复制一个装满素材的节点目录从「按体积搬字节」变成「插几行」。
          if (row.blob) {
            const info = this.blobs.stat(userId, row.blob)
            if (!info) throw failure('文件不存在', 404)
            this.putIndex(userId, project, next, row.mime, info.size, revision, row.blob)
            entries.push({ path: next, revision })
            continue
          }
          // Publish copies through the existing immutable store as well. A
          // failed later file or index write cannot expose a partial target tree.
          let prepared
          if (row.storage === 'disk') prepared = this.blobs.putFile(userId, this.fileFor(userId, project, row.path))
          else {
            const stored = row.path === path ? current : this.store.get(`SELECT bytes FROM workspace_files WHERE ${where} AND path=?`, ...args, row.path)
            const content = Buffer.from(stored.bytes || [])
            prepared = { blob: this.blobs.put(userId, content), size: content.length }
          }
          this.putIndex(userId, project, next, row.mime, prepared.size, revision, prepared.blob)
          entries.push({ path: next, revision })
        }
        return { revision: null, entries }
      } else throw failure('文件操作无效')
      return { revision: null }
    }) } catch (error) {
      try { if (typeof rollbackRemoval === 'function') rollbackRemoval() } catch { console.warn('[workspace] 删除失败后的备份清理未完成') }
      throw error
    }
    return result
  }
}
