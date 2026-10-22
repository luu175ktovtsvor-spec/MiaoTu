import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, stat, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import { dirname, extname } from 'node:path'
import { localPath } from './local-file-search.ts'
import { isProtectedWorkspacePath } from '../server/agent-tools.ts'
import { publishExportFile } from './export-file.ts'

const mediaTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json' }
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })

// Registered only through the desktop computer permission gate. Project is captured
// from the Agent request, never accepted from tool arguments.
export function workspaceTransferTools({ files, userId, project, cwd }: Record<string, any>) {
  if (!files) return []
  return [{
    name: 'importLocalFile',
    description: '把本机已有文件流式导入本次对话所属的妙图项目，保留原文件，返回工作区相对路径、MIME 和大小。不会自动创建画布节点；再通过实际节点函数使用返回路径。仅桌面本机授权后可用。',
    parameters: { type: 'object', properties: { source: { type: 'string', minLength: 1 }, mime: { type: 'string', pattern: '^[\\w.+-]+/[\\w.+-]+$' } }, required: ['source'], additionalProperties: false },
    async execute(_id, args, signal) {
      const source = localPath(cwd, args.source), info = await stat(source)
      if (!info.isFile()) throw new Error('请选择实际文件，不能导入整个文件夹。')
      signal.throwIfAborted()
      const extension = extname(source).toLowerCase()
      const mime = args.mime || mediaTypes[extension] || 'application/octet-stream'
      if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime)) throw new Error('文件类型无效。')
      const path = `assets/imported-${randomUUID()}${/^[.a-z0-9_-]{1,20}$/.test(extension) ? extension : ''}`
      const saved = await files.writeStream(userId, { path, project, mime, stream: createReadStream(source), signal })
      const stored = files.stat(userId, path, project)
      return result({ path, mime, size: stored.size, revision: saved.revision, project, canvasNodeCreated: false })
    },
  }, {
    name: 'exportWorkspaceFile',
    description: '把本次对话所属项目中的工作区文件复制到指定本机路径，供本地软件继续处理。保留项目原件，不覆盖目标已有文件；返回真实绝对路径。仅桌面本机授权后可用。',
    parameters: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, destination: { type: 'string', minLength: 1 } }, required: ['path', 'destination'], additionalProperties: false },
    async execute(_id, args, signal) {
      if (isProtectedWorkspacePath(args.path)) throw new Error('此配置包含凭据，不能通过 Agent 导出。')
      const file = files.locate(userId, args.path, project), destination = localPath(cwd, args.destination)
      if (file.mime === 'inode/directory') throw new Error('请选择实际文件。')
      signal.throwIfAborted()
      await mkdir(dirname(destination), { recursive: true })
      const temp = destination + '.export-' + randomUUID()
      let cleanupWarning
      try {
        await pipeline(file.diskPath ? createReadStream(file.diskPath) : Readable.from(file.bytes), createWriteStream(temp, { flags: 'wx', mode: 0o600 }), { signal })
        signal.throwIfAborted()
        await publishExportFile(temp, destination, signal)
      } catch (error) {
        if (error.code === 'EEXIST') throw new Error('目标文件已存在，请选择新的文件名。')
        throw error
      } finally {
        // Publication already succeeded or has its own error. Cleanup must not
        // turn an exported file into a reported failure or hide the real error.
        try { await rm(temp, { force: true }) }
        catch (error) {
          cleanupWarning = { path: temp, code: error.code || 'unknown', message: '临时副本未能清理，请在权限或文件占用解除后删除。' }
          console.warn('[workspace] 导出临时文件清理失败', cleanupWarning.code)
        }
      }
      return result({ path: destination, mime: file.mime, size: file.size, source: args.path, project, ...(cleanupWarning ? { cleanupWarning } : {}) })
    },
  }]
}
