import { useCallback, useEffect, useRef, useState } from 'react'
import { ADMIN_API_BASE } from './api-base'
import { adminText } from './i18n'

type AdminSession = { role: 'admin'; csrf: string }

class DiscardedAdminRequest extends Error {
  constructor() { super('Admin session changed'); this.name = 'DiscardedAdminRequest' }
}

class AdminApiError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export function isDiscardedAdminRequest(error: unknown) {
  return error instanceof DiscardedAdminRequest || error instanceof Error && error.name === 'AbortError'
}

function readSession(value: unknown): AdminSession {
  const candidate = value as Partial<AdminSession> | null
  if (candidate?.role !== 'admin' || typeof candidate.csrf !== 'string' || !candidate.csrf) {
    throw new Error('管理后台返回的登录状态无效，请重新登录')
  }
  return { role: candidate.role, csrf: candidate.csrf }
}

export function useAdminSession({ lang, onInvalidated, onError }: {
  lang: string
  onInvalidated: () => void
  onError: (message: string) => void
}) {
  const [session, setSession] = useState<AdminSession | null>(null)
  const [ready, setReady] = useState(false)
  const current = useRef<AdminSession | null>(null)
  const revision = useRef(0)
  const mounted = useRef(false)
  const requests = useRef(new Set<AbortController>())
  const callbacks = useRef({ lang, onInvalidated, onError })
  callbacks.current = { lang, onInvalidated, onError }

  const capture = useCallback(() => revision.current, [])
  const isCurrent = useCallback((value: number) => mounted.current && revision.current === value, [])
  const advance = useCallback(() => {
    revision.current++
    for (const request of requests.current) request.abort()
    requests.current.clear()
    return revision.current
  }, [])
  const invalidate = useCallback(() => {
    advance()
    current.current = null
    setSession(null)
    setReady(true)
    callbacks.current.onInvalidated()
  }, [advance])

  const api = useCallback(async (path: string, method = 'GET', body?: unknown, signal?: AbortSignal) => {
    const token = capture()
    if (!isCurrent(token)) throw new DiscardedAdminRequest()
    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    requests.current.add(controller)
    try {
      const response = await fetch(`${ADMIN_API_BASE}/${path}`, {
        method, signal: controller.signal,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(current.current?.csrf ? { 'x-csrf-token': current.current.csrf } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      if (!isCurrent(token)) throw new DiscardedAdminRequest()
      // An expired session must be cleared even when the response body is not JSON.
      if (response.status === 401 && path !== 'login' && path !== 'logout') {
        invalidate()
        throw new DiscardedAdminRequest()
      }
      const data = await response.json().catch(() => null)
      if (!isCurrent(token)) throw new DiscardedAdminRequest()
      if (controller.signal.aborted) throw new DOMException('Request aborted', 'AbortError')
      if (!response.ok) throw new AdminApiError(adminText(data?.error || '操作未完成', callbacks.current.lang), response.status)
      if (data === null) throw new Error(adminText('管理后台响应无效，请刷新重试', callbacks.current.lang))
      return data
    } catch (error) {
      if (!isCurrent(token)) throw new DiscardedAdminRequest()
      throw error
    } finally {
      requests.current.delete(controller)
      signal?.removeEventListener('abort', abort)
    }
  }, [capture, isCurrent, invalidate])

  useEffect(() => {
    mounted.current = true
    const token = advance()
    api('session').then(data => {
      if (!isCurrent(token)) return
      current.current = readSession(data)
      setSession(current.current)
    }).catch(error => {
      if (isCurrent(token) && !isDiscardedAdminRequest(error)) {
        callbacks.current.onError(adminText('后台连接失败，请刷新重试', callbacks.current.lang))
      }
    }).finally(() => { if (isCurrent(token)) setReady(true) })
    return () => { mounted.current = false; advance() }
  }, [advance, api, isCurrent])

  const signIn = useCallback(async (email: string, password: string) => {
    const token = advance()
    const data = await api('login', 'POST', { email, password })
    if (!isCurrent(token)) throw new DiscardedAdminRequest()
    current.current = readSession(data)
    setSession(current.current)
    setReady(true)
  }, [advance, api, isCurrent])

  const signOut = useCallback(async () => {
    const token = advance()
    try {
      await api('logout', 'POST', {})
    } catch (error) {
      if (!isCurrent(token)) throw new DiscardedAdminRequest()
      if (!(error instanceof AdminApiError && error.status === 401)) {
        // Keep a failed sign-out visible and reload requests cancelled at its start.
        setSession(current.current ? { ...current.current } : null)
        throw error
      }
    }
    if (!isCurrent(token)) throw new DiscardedAdminRequest()
    invalidate()
  }, [advance, api, invalidate, isCurrent])

  return { session, ready, api, signIn, signOut, capture, isCurrent }
}
