// 错误文案经 shellT 取词：这个模块不依赖 React，语言由 LangProvider 注入（见 shellText.ts）。
import { shellT } from './shellText'

const STORAGE_KEY = 'miao-library-handoff'
const HANDOFF_TTL_MS = 10 * 60 * 1000
export const LIBRARY_TEXT_LIMIT = 64_000

function storage() {
  if (typeof window === 'undefined' || !window.sessionStorage) throw new Error(shellT('当前标签页无法保存选择'))
  return window.sessionStorage
}

function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function validRecord(record, now = Date.now(), requireSelection = false) {
  if (!record || typeof record !== 'object') return false
  if (!record.handoffId || !record.createdAt || !record.expiresAt || !record.source || !record.mode) return false
  if (!['prompt', 'reference'].includes(record.mode) || record.expiresAt <= now) return false
  return !requireSelection || ['prompt', 'reference'].includes(record.type)
}

export function createLibraryHandoff(mode, source = 'studio') {
  if (!['prompt', 'reference'].includes(mode)) throw new Error(shellT('选择模式无效'))
  const createdAt = Date.now()
  const record = {
    handoffId: newId(),
    createdAt,
    expiresAt: createdAt + HANDOFF_TTL_MS,
    source,
    mode,
  }
  storage().setItem(STORAGE_KEY, JSON.stringify(record))
  return record
}

export function readLibraryHandoff({ requireSelection = true } = {}) {
  let record
  try {
    record = JSON.parse(storage().getItem(STORAGE_KEY) || 'null')
  } catch {
    return null
  }
  const structurallyValid = validRecord(record, Date.now(), false)
  if (structurallyValid && (!requireSelection || ['prompt', 'reference'].includes(record.type))) return record
  // A valid handoff can exist before the library item is selected. Keep that
  // short-lived record so the result can still carry the original ID.
  if (structurallyValid && requireSelection) return null
  if (record) {
    try { storage().removeItem(STORAGE_KEY) } catch { /* keep the caller on the current page */ }
  }
  return null
}

export function writeLibrarySelection(selection) {
  const text = String(selection.text || '')
  if (selection.type === 'prompt' && text.length > LIBRARY_TEXT_LIMIT) throw new Error(shellT('提示词太长，请复制后在画布中分段使用'))
  let rawRecord
  try {
    rawRecord = JSON.parse(storage().getItem(STORAGE_KEY) || 'null')
  } catch {
    rawRecord = null
  }
  if (rawRecord?.expiresAt && rawRecord.expiresAt <= Date.now()) {
    try { storage().removeItem(STORAGE_KEY) } catch { /* the write below reports the storage failure */ }
    throw new Error(shellT('这次选择已过期，请返回工作台重新打开案例'))
  }
  let record = readLibraryHandoff({ requireSelection: false })
  if (!record) record = createLibraryHandoff(selection.mode, 'library')
  if (record.mode !== selection.mode) throw new Error(shellT('选择模式已变化，请重新打开案例'))
  const next = {
    ...record,
    type: selection.type,
    selectedAt: Date.now(),
    ...(selection.type === 'prompt' ? { text } : {}),
    // 参考图交接只留图片本身：作者和上游推文 id 都不写进来。
    // 这条记录存在 sessionStorage，用户翻得到，不能带上游信息。
    ...(selection.type === 'reference' ? {
      images: Array.isArray(selection.images) ? selection.images.slice(0, 1) : [],
    } : {}),
  }
  storage().setItem(STORAGE_KEY, JSON.stringify(next))
  return next
}

export function clearLibraryHandoff(handoffId) {
  const store = storage()
  const current = readLibraryHandoff({ requireSelection: false })
  if (!current || current.handoffId === handoffId) store.removeItem(STORAGE_KEY)
}

export { HANDOFF_TTL_MS, STORAGE_KEY }
