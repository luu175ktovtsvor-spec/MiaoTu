import { createTextMeter } from './text-metering.ts'
import { json, mutation, sameOrigin } from './http-auth.ts'
import { failure } from './management-store.ts'
import { assertTextAccess, assertTextIdentity } from './text-access.ts'
import { completeProviderText } from './text-providers.ts'
import { createTextCompletion, validateTextRequest } from './text-models.ts'
import { readJsonRequest } from './model-transport.ts'
import { TextOperations } from './text-lifetime.ts'

export function createShortTextApi({ management, workspaceFiles, env = process.env }: Record<string, any>) {
  const operations = new TextOperations()
  return {
    async handle(request, response, session, url) {
      if (url.pathname !== '/api/imagine/text' || request.method !== 'POST') return false
      if (response.destroyed || response.writableEnded) return true
      if (session) mutation(request, session)
      else sameOrigin(request)
      const operation = operations.begin(() => {
        if (!operation.dispatched && !request.complete && !request.destroyed) request.destroy()
      })
      const disconnected = () => operation.disconnect()
      const connected = () => operation.connected && !response.destroyed && !response.writableEnded
      request.once('aborted', disconnected)
      response.once('close', disconnected)
      response.once('error', disconnected)
      if (request.aborted || response.destroyed) disconnected()
      try {
        assertTextIdentity({ management, session })
        const payload = await readJsonRequest(request, { maxBytes: 64000, signal: operation.signal, tooLargeMessage: '请求过大', invalidMessage: '请求格式错误' })
        operation.signal.throwIfAborted()
        if (!connected()) return true
        const providerId = String(payload?.providerId || '').trim()
        if (providerId && providerId !== 'miaoimg') {
          assertTextIdentity({ management, session })
          if (env.ENABLE_MODEL_CALLS !== 'true') throw failure('模型调用开关未开启', 503)
          const providerResult = await completeProviderText(workspaceFiles, session.userId, payload, {
            signal: operation.signal, beforeDispatch: () => assertTextIdentity({ management, session }),
          })
          operation.signal.throwIfAborted()
          if (connected()) json(response, 200, { ok: true, ...providerResult })
          return true
        }
        operation.continueAfterDisconnect(true)
        assertTextAccess({ management, session })
        const modelId = String(payload?.model || '').trim() || management.settings().defaultTextModel || 'gpt-6.1-sol'
        const settings = management.settings()
        if (settings.models?.[modelId] === false) throw failure('这个文本模型已暂停', 403)
        const allowed = management.user(session.userId)?.models
        if (Array.isArray(allowed) && allowed.length && !allowed.includes(modelId)) throw failure('这个文本模型未对你的账号开放', 403)
        const prepared = await operation.wait(validateTextRequest({ ...payload, model: modelId }, env))
        operation.signal.throwIfAborted()
        if (!connected()) return true
        assertTextAccess({ management, session })
        const meter = createTextMeter({ management,session,source:'short_text' })
        const result = await createTextCompletion(prepared, { signal:operation.signal, fetchImpl: async (input,init) => {
          if (request.aborted || response.destroyed) disconnected()
          operation.dispatch(() => assertTextIdentity({ management,session }))
          return meter.fetch(input,init)
        } })
        if (connected()) json(response,200,{ ok:true,...result,billing:meter.summary() })
      } catch (error) {
        if (connected()) json(response, error.status || 502, { ok: false, error: error.message || '文本生成失败' })
      } finally {
        request.off('aborted', disconnected)
        response.off('close', disconnected)
        response.off('error', disconnected)
        operation.finish()
      }
      return true
    },
    stop: () => operations.stop(),
  }
}
