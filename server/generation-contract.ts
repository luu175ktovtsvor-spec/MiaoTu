import { randomUUID } from 'node:crypto'
import { modelById } from './image-models.ts'
import { ownTextModelById } from './text-model-registry.ts'

/**
 * Shared contract for generation identity, ownership and lifecycle.
 *
 * The HTTP API may accept a legacy `requestId` field as an idempotency-key
 * alias, but the public request ID, database primary key and idempotency key
 * remain separate concepts.
 */

export const GENERATION_STATES = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
})

export const GENERATION_TRANSITIONS = Object.freeze({
  queued: Object.freeze(['running', 'cancelled', 'failed', 'expired']),
  running: Object.freeze(['succeeded', 'failed', 'cancelled', 'expired']),
  succeeded: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([]),
  expired: Object.freeze([]),
})

export const GENERATION_OWNERS = Object.freeze({
  USER: 'user',
  ADMIN: 'admin',
  GUEST: 'guest',
})

// This version owns temporary server media and local delivery receipts. An old
// server must not be treated as if it implements the local-only storage policy.
export const DESKTOP_MEDIA_PROTOCOL = 1
export const DESKTOP_MEDIA_CAPABILITIES = Object.freeze({ mediaProtocols: Object.freeze([DESKTOP_MEDIA_PROTOCOL]) })
export function assertDesktopMediaProtocol(config: any) {
  if (!Array.isArray(config?.desktop?.mediaProtocols) || !config.desktop.mediaProtocols.includes(DESKTOP_MEDIA_PROTOCOL)) {
    throw Object.assign(new Error('当前服务暂不支持桌面文件保存，请稍后重试或联系支持。'), { status: 503, code: 'DESKTOP_MEDIA_PROTOCOL_UNAVAILABLE' })
  }
}

// Creating an already admitted task is a status read. Keep its original media,
// billing snapshot and terminal state instead of returning a thin acknowledgement.
export function generationReceipt(record, extra: Record<string, any> = {}) {
  const active = [GENERATION_STATES.QUEUED, GENERATION_STATES.RUNNING].includes(record.status)
  const points = active ? record.reservedPoints : record.chargedPoints
  return { ...record, cost: { points: points ?? null }, ...extra, async: active, pollAfterMs: 1000, httpStatus: active ? 202 : 200 }
}

export const PUBLIC_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{20,100}$/
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{10,100}$/
export const GENERATION_LIMITS = Object.freeze({ queueMs: 15 * 60_000, leaseMs: 30_000 })

export function newRequestId() {
  return randomUUID()
}

export function newGenerationId() {
  return randomUUID()
}

export function validRequestId(value) {
  return PUBLIC_REQUEST_ID_PATTERN.test(String(value || ''))
}

export function validIdempotencyKey(value) {
  return IDEMPOTENCY_KEY_PATTERN.test(String(value || ''))
}

export function canTransition(from, to) {
  return Boolean(GENERATION_TRANSITIONS[from]?.includes(to))
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) throw new Error(`不允许将生成状态从 ${from} 改为 ${to}`)
  return to
}

export function ownerForSession(session) {
  if (session?.role === 'admin') return { type: GENERATION_OWNERS.ADMIN, id: session.userId || null, scope: 'admin' }
  if (session?.userId) return { type: GENERATION_OWNERS.USER, id: session.userId, scope: `user:${session.userId}` }
  return { type: GENERATION_OWNERS.GUEST, id: null, scope: 'guest' }
}

export function publicModelId(value) {
  const model = typeof value === 'object' ? value : modelById(value)
  if (model?.publicId || model?.id) return model.publicId || model.id
  const textModel = typeof value === 'object' ? null : ownTextModelById(value)
  return textModel?.id || ''
}

export function internalModelId(value) {
  const model = typeof value === 'object' ? value : modelById(value)
  return model?.id || ''
}

export function normalizeModelList(values) {
  if (!Array.isArray(values)) return []
  return [...new Set(values.map(publicModelId).filter(Boolean))]
}

export function idempotencyInput(payload: Record<string, any> = {}) {
  return String(payload.idempotencyKey || payload.requestId || '').trim()
}

// A transport failure is not a model's terminal response. Connection refusal
// and DNS/connect timeout occur before a request is sent; other disconnects
// can hide accepted work and must never trigger a second paid submission.
export function submissionUncertain(error) {
  // A failed result download can carry connection/HTTP errors even though the
  // preceding model request already returned media. Its stage takes precedence.
  if (error?.upstreamAccepted === true) return true
  if (error?.submissionNotStarted === true) return false
  const code = error?.cause?.code || error?.code || ''
  if (['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) return false
  if (Number(error?.upstreamStatus) >= 400 && Number(error?.upstreamStatus) < 500) return false
  return Boolean(error?.submissionUncertain || error?.transient || Number(error?.upstreamStatus) >= 500 || ['AbortError', 'TimeoutError', 'TypeError'].includes(error?.name) || /^(UND_ERR_|ECONNRESET|EPIPE|ETIMEDOUT)/.test(code) || (Number(error?.status) >= 500 && !error?.upstreamStatus))
}
