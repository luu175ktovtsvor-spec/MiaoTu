import { flatMapAsync } from '../server/async-collections.ts'
export type TaskDownloadFile = { index: number; key: string; path: string; mime: string; revision: string; size: number; sha256: string }
export type TaskDownload = { version: 1; requestId: string; source: Record<string, any>; files: TaskDownloadFile[] }
type TaskTarget = { request_id: string; directory: string; kind: string; project_id: string }

export const taskMediaExtension = (mime: string) => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm' }[mime] || 'bin')
export const taskResultItems = (kind: string, data: any): any[] => kind === 'video' ? data?.video ? [data.video] : [] : Array.isArray(data?.images) ? data.images : []
export const taskItemKey = (item: any) => typeof item?.id === 'string' && item.id ? 'id:' + item.id : 'url:' + String(item?.url || '')
const downloadCopyId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/

export function taskDownloadPath(directory: string, requestId: string, index: number, mime: string, copyId?: string) {
  if (copyId !== undefined && !downloadCopyId.test(copyId)) throw new Error('原件备用文件名无效')
  return `${directory}/${requestId}-${index}${copyId ? '-original-' + copyId : ''}.${taskMediaExtension(mime)}`
}

// Recovery accepts only this exact task/item's original name or an explicit
// UUID copy in the same directory, never a caller-selected unrelated file.
export function isTaskDownloadPath(path: unknown, directory: string, requestId: string, index: number, mime: string) {
  if (typeof path !== 'string' || !Number.isSafeInteger(index) || index < 0 || taskMediaExtension(mime) === 'bin') return false
  if (path === taskDownloadPath(directory, requestId, index, mime)) return true
  const prefix = `${directory}/${requestId}-${index}-original-`, suffix = '.' + taskMediaExtension(mime)
  return path.startsWith(prefix) && path.endsWith(suffix) && downloadCopyId.test(path.slice(prefix.length, -suffix.length))
}

// A late submission error cannot undo saved originals or an existing terminal
// receipt. Only an intent already checkpointed before send is uncertain.
export function localSubmissionFailureStatus(status: string, phase: unknown): 'running' | 'failed' | undefined {
  if (['saving', 'succeeded', 'failed', 'cancelled', 'expired'].includes(status)) return
  return ['dispatching', 'accepted', 'completed'].includes(String(phase)) ? 'running' : 'failed'
}

export function publicTaskResult(value: Record<string, any>) {
  const { localDownload: _localDownload, localRecovery: _localRecovery, routeState: _routeState, ...result } = value
  return result
}

// A checkpoint only proves saved bytes when its original-item identity, target
// path and immutable workspace index still agree. Never guess from filenames.
export async function savedTaskFile(row: TaskTarget, item: any, index: number, checkpoint: any,
  locate: (path: string) => { revision: string; blob?: string; size: number; mime: string } | Promise<{ revision: string; blob?: string; size: number; mime: string }>) {
  if (checkpoint?.version !== 1 || checkpoint.requestId !== row.request_id || !Array.isArray(checkpoint.files)) return
  const file = checkpoint.files.find((entry: any) => entry?.index === index) as TaskDownloadFile | undefined
  if (!file || file.key !== taskItemKey(item) || typeof file.mime !== 'string'
    || !(row.kind === 'video' ? file.mime.startsWith('video/') : file.mime.startsWith('image/'))
    || !isTaskDownloadPath(file.path, row.directory, row.request_id, index, file.mime)
    || typeof file.revision !== 'string' || !file.revision || !Number.isSafeInteger(file.size) || file.size <= 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) return
  let current
  try { current = (await locate(file.path)) }
  catch (error) { if (error.status === 404) return; throw error }
  if (current.revision === file.revision && current.blob === file.sha256 && current.size === file.size && current.mime === file.mime) return file
}

export function localTaskMedia(row: TaskTarget, item: any, file: TaskDownloadFile) {
  const url = `/api/imagine/workspace/files?project=${encodeURIComponent(row.project_id)}&path=${encodeURIComponent(file.path)}`
  const downloadSource = item.watermark?.source === 'platform-player' && item.watermark.noWatermarkConfirmed === false
    ? 'platform-player' : item.watermark?.source === 'platform-download' && item.watermark.noWatermarkConfirmed === true ? 'platform-download' : undefined
  return { ...item, ...(downloadSource ? { downloadSource } : {}), path: file.path, mime: file.mime, thumbnailUrl: url + '&preview=1&previewSize=320', url }
}

// Public recovery links are derived from currently indexed originals, never
// accepted from a cloud receipt or replayed from a stale public snapshot.
export async function localTaskRecovery(row: TaskTarget, checkpoint: any,
  locate: (path: string) => { revision: string; blob?: string; size: number; mime: string } | Promise<{ revision: string; blob?: string; size: number; mime: string }>) {
  if (checkpoint?.version !== 1 || checkpoint.requestId !== row.request_id || checkpoint.source?.requestId !== row.request_id || checkpoint.source?.status !== 'succeeded') return
  const source = checkpoint.source
  const items = taskResultItems(row.kind, source)
  if (!items.length || items.some(item => typeof item?.url !== 'string' || !item.url || source.parameters?.desktopDelivery === 1 && (typeof item.id !== 'string' || !item.id))) return
  const saved = (await flatMapAsync(items, async (item, index) => {
    const file = (await savedTaskFile(row, item, index, checkpoint, locate))
    return file ? [{ ...localTaskMedia(row, item, file), index }] : []
  }))
  if (saved.length) return { total: items.length, saved: saved.length, items: saved }
}
