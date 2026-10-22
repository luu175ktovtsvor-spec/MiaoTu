import { reactive } from 'vue'

// 上传进度按**节点**记：节点先建出来，进度就画在那个节点的框里，不再往画布上方飘浮条。
// 条目只活在内存里（File 对象也不落盘），画布 JSON 里不会存下上传态。
export type UploadStatus = 'pending' | 'uploading' | 'done' | 'error'

export type UploadEntry = {
  // 就是节点 id：上传完成后素材要写进 assets/<节点id>/。
  id: string
  name: string
  status: UploadStatus
  percent: number
  message?: string
  // 失败后重试要用的原始文件；只在本页面会话里存在。
  file?: File
  mimeType: string
  // Keep the original write receipt when only publishing into the node failed.
  saved?: { path: string; revision?: string; directory: string; size: number; mimeType: string }
}

const entries = reactive(new Map<string, UploadEntry>())
const dismissTimers = new Map<string, number>()

export function uploadEntry(id: string): UploadEntry | undefined {
  return entries.get(id)
}

export function beginUpload(id: string, name: string, file: File | undefined, mimeType: string) {
  const timer = dismissTimers.get(id)
  if (timer) { window.clearTimeout(timer); dismissTimers.delete(id) }
  // 推断出的 MIME 也写入原始请求，不能只写在节点输出里。
  const source = file && mimeType && file.type !== mimeType
    ? new File([file], file.name, { type: mimeType, lastModified: file.lastModified }) : file
  entries.set(id, { id, name, status: 'pending', percent: 0, file: source, mimeType })
}

export function setUploadProgress(id: string, percent: number) {
  const entry = entries.get(id)
  if (!entry || entry.status === 'done' || entry.status === 'error') return
  entry.status = 'uploading'
  entry.percent = Math.min(100, Math.max(0, Math.round(percent)))
}

export function finishUpload(id: string, ok: boolean, message?: string) {
  const entry = entries.get(id)
  if (!entry) return
  entry.status = ok ? 'done' : 'error'
  entry.percent = ok ? 100 : entry.percent
  entry.message = message
  // 成功态和「已加入画布」一样短暂露个面就收起；失败态留着等用户重试或移除。
  if (ok) {
    dismissTimers.set(id, window.setTimeout(() => dismissUpload(id), 2000))
  }
}

// 已保存时只重新发布；尚未确认保存时沿原文件重试上传。
export function retryUpload(id: string) {
  const entry = entries.get(id)
  if (!entry || !entry.file && !entry.saved) return
  entry.status = 'pending'
  entry.percent = 0
  entry.message = undefined
}

export function dismissUpload(id: string) {
  const timer = dismissTimers.get(id)
  if (timer) { window.clearTimeout(timer); dismissTimers.delete(id) }
  entries.delete(id)
}
