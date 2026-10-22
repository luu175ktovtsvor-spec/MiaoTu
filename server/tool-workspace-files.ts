import { AsyncLocalStorage } from 'node:async_hooks'
import { hasCanvasHeader } from './canvas-document.ts'
import { isInternalAssetPath, isProtectedWorkspacePath, isWorkspacePath } from './workspace-path.ts'
import { currentProject, DEFAULT_PROJECT_ID, withWorkspaceProject } from './workspace-scope.ts'
import { readWorkspaceRange } from './workspace-read.ts'

type Entry = { path: string; mime?: string }
export type ToolWorkspaceView = { paths: readonly string[]; uncertain?: boolean; busy?: boolean }
type ViewProvider = (userId: any, project: string) => readonly ToolWorkspaceView[]
const failure = (message: string, status = 409) => Object.assign(new Error(message), { status })
const contains = (parent: string, child: string) => child.toLowerCase() === parent.toLowerCase() || child.toLowerCase().startsWith(parent.toLowerCase() + '/')

export function toolWorkspaceStatePaths(state: any): string[] {
  return [state?.canvasId, state?.document?.selection?.filePath, state?.document?.selection?.canvasPath,
    ...(state?.retainedPaths ?? []), ...(state?.document?.selection?.nodeId && state?.document?.handleId === 'text'
      ? [`assets/${state.document.selection.nodeId}/content.md`] : []),
  ].filter(isWorkspacePath)
}

// Pure policy shared by both tool transports. The raw workspace service remains
// available to node saves, canvas transactions and other admitted host writers.
export function assertToolFileMutation({ path, target, operation = 'write', revision, entries, views, isCanvas, ownsWrite }: {
  path: string; target?: string; operation?: string; revision?: string; entries: readonly Entry[];
  views: readonly ToolWorkspaceView[]; isCanvas(entry: Entry): boolean; ownsWrite(path: string, revision: string): boolean;
}) {
  const protectedTree = (candidate: string) => isProtectedWorkspacePath(candidate)
    || entries.some(entry => isProtectedWorkspacePath(entry.path) && contains(candidate, entry.path))
  if (protectedTree(path) || (target && (protectedTree(target) || entries.some(entry => contains(path, entry.path)
    && isProtectedWorkspacePath(target + entry.path.slice(path.length)))))) throw failure('该路径包含供应商密钥，工具不能修改或移动', 403)
  const intersects = (candidate: string, open: string) => contains(candidate, open) || contains(open, candidate)
  if (!['copy', 'mkdir'].includes(operation) && entries.some(entry => contains(path, entry.path))
    && views.some(view => view.uncertain || view.busy)) throw failure('画布正在同步状态或处理操作，暂不能直接修改已有文件；请稍后读取应用状态')
  if (views.some(view => view.paths.some(open => (operation !== 'copy' && intersects(path, open)) || (target && intersects(target, open))))) {
    throw failure('这个文件正在妙图里打开，请改用画布或文档工具修改')
  }
  if (target && isInternalAssetPath(target)) throw failure('节点内部文件保持原位，请将副本保存到素材库目录')
  if (operation !== 'copy' && isInternalAssetPath(path)) {
    const newDirectory = operation === 'mkdir' && !entries.some(entry => contains(path, entry.path)
      || (contains(entry.path, path) && entry.mime !== 'inode/directory'))
    const rollback = operation === 'remove' && typeof revision === 'string' && ownsWrite(path, revision)
      && !entries.some(entry => contains(path, entry.path) && entry.path !== path)
    if (!rollback && !newDirectory && (operation !== 'write' || entries.some(entry => intersects(path, entry.path)
      && (entry.mime !== 'inode/directory' || contains(path, entry.path))))) {
      throw failure('节点内部文件保持原位；请用节点工具编辑，或另存到素材库后整理副本')
    }
  }
  if (operation !== 'copy' && entries.some(entry => contains(path, entry.path) && !isProtectedWorkspacePath(entry.path) && isCanvas(entry))) {
    throw failure('画布文件请使用画布工具修改、重命名或删除；复制请使用 duplicateCanvas')
  }
}

const writes = new AsyncLocalStorage<Map<string, string>>()
const guards = new WeakMap<object, ReturnType<typeof createGuard>>()
const projectOf = (project?: string) => project || currentProject() || DEFAULT_PROJECT_ID

function createGuard(raw: any) {
  const providers = new Set<ViewProvider>()
  const writeKey = (userId, project, path) => JSON.stringify([userId, project, raw.referenceOwner?.(userId), path])
  const remember = (userId, project, path, revision) => {
    if (isInternalAssetPath(path) && typeof revision === 'string') writes.getStore()?.set(writeKey(userId, project, path), revision)
  }
  const isCanvasFile = (userId, entry: Entry, project = projectOf()) => {
    if (entry.mime === 'inode/directory' || !/\.json$/i.test(entry.path)) return false
    const file = typeof raw.locate === 'function' ? raw.locate(userId, entry.path, project) : raw.read(userId, entry.path, project)
    return hasCanvasHeader(readWorkspaceRange(file, { limit: 4096 }).bytes.toString('utf8'))
  }
  const assertWritable = (userId, value, target?: string, operation = 'write', revision?: string, project = projectOf()) => {
    const path = raw.path(value)
    assertToolFileMutation({ path, target: target === undefined ? undefined : raw.path(target), operation, revision,
      entries: raw.list(userId, project), views: [...providers].flatMap(read => read(userId, project)),
      isCanvas: entry => isCanvasFile(userId, entry, project),
      ownsWrite: (path, revision) => writes.getStore()?.get(writeKey(userId, project, path)) === revision })
  }
  const files = new Proxy(raw, { get(target, key) {
    const value = Reflect.get(target, key, target)
    if (key === 'list') return (...args) => value.apply(target, args).filter(entry => !isProtectedWorkspacePath(entry.path))
    if (['read', 'locate', 'stat', 'copyTo'].includes(String(key))) return (userId, path, ...args) => {
      if (isProtectedWorkspacePath(raw.path(path))) throw failure('该文件包含供应商密钥，工具不能读取', 403)
      return value.call(target, userId, path, ...args)
    }
    if (key === 'upsert') return (userId, valuePath, mime, bytes, projectArg) => {
      const path = raw.path(valuePath), project = projectOf(projectArg)
      assertWritable(userId, path, undefined, mime === 'inode/directory' ? 'mkdir' : 'write', undefined, project)
      if (!isInternalAssetPath(path)) return value.call(target, userId, path, mime, bytes, project)
      const result = target.writeBytes(userId, { path, mime, bytes, project, revision: null })
      remember(userId, project, path, result.revision)
      return result.revision
    }
    if (key === 'write') return (userId, projectArg, valuePath, mime, bytes) => {
      const path = raw.path(valuePath), project = projectOf(projectArg)
      assertWritable(userId, path, undefined, mime === 'inode/directory' ? 'mkdir' : 'write', undefined, project)
      const revision = isInternalAssetPath(path)
        ? target.writeBytes(userId, { path, mime, bytes, project, revision: null }).revision
        : value.call(target, userId, project, path, mime, bytes)
      remember(userId, project, path, revision)
      return revision
    }
    if (key === 'importFile') return async (userId, valuePath, mime, source, signal, options: Record<string, any> = {}) => {
      const path = raw.path(valuePath), project = projectOf(options.project)
      assertWritable(userId, path, undefined, 'write', undefined, project)
      const result = await withWorkspaceProject(project, () => value.call(target, userId, path, mime, source, signal, { ...options,
        ...(isInternalAssetPath(path) ? { overwrite: false } : {}),
        beforeCommit: size => { assertWritable(userId, path, undefined, 'write', undefined, project); options.beforeCommit?.(size) },
      }))
      remember(userId, project, path, result.revision)
      return result
    }
    if (key === 'writeStream') return async (userId, options: Record<string, any>) => {
      const path = raw.path(options.path), project = projectOf(options.project)
      assertWritable(userId, path, undefined, 'write', undefined, project)
      const result = await value.call(target, userId, { ...options, path, project,
        ...(isInternalAssetPath(path) ? { overwrite: false, revision: null } : {}),
        beforeCommit: size => { assertWritable(userId, path, undefined, 'write', undefined, project); options.beforeCommit?.(size) },
      })
      remember(userId, project, path, result.revision)
      return result
    }
    if (key === 'importFiles') return async (userId, entries, options: Record<string, any> = {}) => {
      const project = projectOf(options.project)
      const entriesToWrite = entries.map(entry => {
        const path = raw.path(entry.path)
        assertWritable(userId, path, undefined, 'write', undefined, project)
        return { ...entry, path, ...(isInternalAssetPath(path) ? { revision: null } : {}) }
      })
      const result = await value.call(target, userId, entriesToWrite, { ...options, beforeCommit: path => {
        assertWritable(userId, path, undefined, 'write', undefined, project)
        options.beforeCommit?.(path)
      } })
      for (const entry of result) remember(userId, project, entry.path, entry.revision)
      return result
    }
    if (['writeBytes', 'mutate'].includes(String(key))) return (userId, args, ...rest) => {
      const operation = key === 'mutate' ? args.operation : 'write', project = projectOf(args.project)
      assertWritable(userId, args.path, ['rename', 'copy'].includes(operation) ? args.target : undefined, operation, args.revision, project)
      const result = value.call(target, userId, args, ...rest)
      if (operation === 'write') remember(userId, project, raw.path(args.path), result.revision)
      return result
    }
    if (['removeTree', 'replaceTree'].includes(String(key))) return (userId, path, ...args) => {
      const project = projectOf(key === 'removeTree' ? args[0] : args[1]?.project)
      assertWritable(userId, path, undefined, key === 'removeTree' ? 'remove' : 'replace', undefined, project)
      if (key === 'replaceTree') for (const entry of args[0]) assertWritable(userId, entry.path, undefined, 'write', undefined, project)
      return value.call(target, userId, path, ...args)
    }
    return typeof value === 'function' ? value.bind(target) : value
  } })
  return { files, isCanvasFile,
    addViews(read: ViewProvider) { providers.add(read); return () => providers.delete(read) },
    run<T>(operation: () => T): T { return writes.run(new Map(), operation) },
  }
}

export function toolWorkspaceFiles(workspaceFiles: any) {
  let guard = guards.get(workspaceFiles)
  if (!guard) { guard = createGuard(workspaceFiles); guards.set(workspaceFiles, guard); guards.set(guard.files, guard) }
  return guard
}
