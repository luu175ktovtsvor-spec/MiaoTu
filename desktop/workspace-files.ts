import { createReadStream, statSync, existsSync, constants } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { finished } from 'node:stream/promises'
import { IncomingMessage } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WorkspaceFiles } from '../server/workspace-files.ts'
import { withStreamedMedia } from '../server/media-files.ts'
import { currentProject } from '../server/workspace-scope.ts'
import { DEFAULT_PROJECT_ID, projectId } from '../server/projects.ts'
import { preserveProvidersBeforeProjectRemoval } from '../server/text-providers.ts'

// Desktop media stays on disk, including uploads and processing results.
export class DesktopWorkspaceFiles extends WorkspaceFiles {
  localLargeFiles = true
  // 自定义模型是应用级配置，不属于任何一个画布项目；所有项目共用 default 作用域里的这一份。
  providerProject = () => DEFAULT_PROJECT_ID
  async prepareProjectRemoval(userId, project) { await preserveProvidersBeforeProjectRemoval(this, userId, project) }
  async removeProject(userId, project, options: { preserveDefault?: boolean } = {}) {
    await this.prepareProjectRemoval(userId, project)
    return (await super.removeProject(userId, project, options))
  }
  // Enabled by the desktop host only after constructor migrations and account
  // restoration. Ordinary unbound projects retain LocalStore's shared semantics.
  declare projectAccess: ((project: string) => void | Promise<void>) | undefined
  private async projectForAccess(project: unknown) {
    const scope = projectId(project === undefined || project === null || project === '' ? currentProject() || DEFAULT_PROJECT_ID : project)
    await this.projectAccess?.(scope)
    return scope
  }
  async scopeArgs(userId, project) { return (await super.scopeArgs(userId, await this.projectForAccess(project))) }
  async projectRoot(userId, project, options: Record<string, any> = {}) { return (await super.projectRoot(userId, (await this.projectForAccess(project)), options)) }
  async writeStream(userId, { path, project = currentProject() || 'default', mime, stream, revision = null, signal, overwrite = false, beforeCommit, onFileCommit }: Record<string, any>) {
    let target: string, absolute: string
    try {
      signal?.throwIfAborted()
      await this.store.project(project)
      target = this.path(path)
      const current = (await this.store.get(`SELECT mime FROM workspace_files WHERE ${this.scopeWhere()} AND path=?`, ...(await this.scopeArgs(userId, project)), target))
      await this.assertWriteTarget(userId, project, target, mime, current)
      absolute = (await this.fileFor(userId, project, target, { create: true }))
    } catch (error) {
      // Pipeline does not yet own the source. Release file handles and downloaded
      // bodies, but let the HTTP handler send its error before closing an upload.
      if (!(stream instanceof IncomingMessage)) {
        const closed = finished(stream, { cleanup: true }).catch(() => {})
        stream.destroy()
        await closed
      }
      throw error
    }
    return withStreamedMedia(stream, { path: absolute, signal }, async ({ path: temp, size, sha256 }) => {
      await this.store.project(project)
      const nextRevision = randomUUID()
      await this.withDeferredBytes(async () => {
        signal?.throwIfAborted()
        await beforeCommit?.(size)
        await this.userMutationGuard?.(userId, project, { operation: 'write', path: target })
        // The destination may have changed while the stream was being read.
        await this.fileFor(userId, project, target)
        const current = (await this.store.get(`SELECT revision,blob,storage,mime FROM workspace_files WHERE ${this.scopeWhere()} AND path=?`, ...(await this.scopeArgs(userId, project)), target))
        if (!overwrite && revision !== (current?.revision ?? null)) throw Object.assign(new Error('文件已更新，请重新打开后再保存。'), { status: 409 })
        await this.assertWriteTarget(userId, project, target, mime, current)
        if (mime === 'inode/directory') {
          await this.place(userId, project, target, mime, Buffer.alloc(0)); await this.putIndex(userId, project, target, mime, 0, nextRevision, null); return
        }
        if (existsSync(absolute) && !statSync(absolute).isFile()) throw Object.assign(new Error('目标路径不是普通文件，请选择其他文件名。'), { status: 409 })
        const blob = sha256
        this.blobs.linkFromFile(userId, temp, blob, { copyFallback: true })
        await this.putIndex(userId, project, target, /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime : 'application/octet-stream', size, nextRevision, blob)
        if (current?.blob && current.blob !== blob) await this.deferBytes(userId, project, [{ path: target, blob: current.blob }])
        else if (current?.storage === 'disk' && !current.blob) await this.deferBytes(userId, project, [{ path: target, blob: null }])
        // The awaited owner checkpoint commits with the new file index.
        // Its failure rolls back the reference as well, preserving old bytes.
        await onFileCommit?.({ path: target, mime, revision: nextRevision, size, sha256 })
      }, userId)
      return { revision: nextRevision, size, sha256 }
    })
  }
  async importFile(userId, path, mime, source, signal, options: { overwrite?: boolean; beforeCommit?: (size: number) => void } = {}) {
    return this.writeStream(userId, { path, mime, stream: createReadStream(source), signal, overwrite: options.overwrite ?? true, beforeCommit: options.beforeCommit })
  }
  async copyTo(userId, path, target) {
    const file = (await this.locate(userId, path))
    if (file.diskPath) return copyFile(file.diskPath, target, constants.COPYFILE_FICLONE)
    const { writeFile } = await import('node:fs/promises')
    return writeFile(target, file.bytes)
  }
}
