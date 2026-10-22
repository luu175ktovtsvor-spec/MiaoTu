import { randomUUID } from 'node:crypto'
import { json, mutation, sameOrigin } from './http-auth.ts'
import { failure } from './management-store.ts'
import { assertTextAccess, assertTextIdentity } from './text-access.ts'
import { completeProviderText } from './text-providers.ts'
import { createTextCompletion, validateTextRequest } from './text-models.ts'
import { textCreditsForUsage, textCreditsReserve } from './text-pricing.ts'
import { readJsonRequest } from './model-transport.ts'
import { TextOperations } from './text-lifetime.ts'

const tokenCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0

// Non-streaming HTTP receipts must carry both counters. A missing field is
// not zero usage, and neither prompt length nor returned text proves tokens.
function completionUsage(protocol: string, usage: any) {
  const input = protocol === 'openai-responses' ? usage?.input_tokens : usage?.prompt_tokens
  const output = protocol === 'openai-responses' ? usage?.output_tokens : usage?.completion_tokens
  return tokenCount(input) && tokenCount(output) ? { input_tokens: input, output_tokens: output } : undefined
}

// Short node text keeps its existing billing. The Agent's unmetered rounds and
// durable media jobs own different lifetimes and do not pass through this API.
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
        const requestId = randomUUID()
        const inputTokens = Math.max(1, Math.ceil((prepared.prompt.length + prepared.systemPrompt.length) / 4))
        const reservePoints = textCreditsReserve(prepared.model.id, inputTokens, prepared.maxTokens, settings.textPrices)
        let reserved = false, finalized = false, upstreamStatus = 0
        let providerRequestId = '', billingStatus = 'unreserved', transportError: any, usage: ReturnType<typeof completionUsage>
        const confirmedBilling = (row: any) => {
          if (!['settled', 'failed', 'billing_review'].includes(row?.status)) return false
          billingStatus = row.status
          return true
        }
        const review = (reason: string) => {
          billingStatus = 'billing_review_pending'
          const counters = usage ? `；输入token=${usage.input_tokens}；输出token=${usage.output_tokens}` : ''
          try {
            const row = management.reviewTextCharge(requestId, `${reason}${counters}；模型=${prepared.model.id}；上游编号=${providerRequestId || '未知'}；HTTP=${upstreamStatus || '未知'}`)
            if (!confirmedBilling(row)) console.error('[text] 用量核对记录待恢复', requestId, 'ACCOUNTING_STATE_UNCONFIRMED')
          }
          catch (error) { console.error('[text] 用量核对记录待恢复', requestId, error?.code || 'ACCOUNTING_WRITE_FAILED') }
        }
        const finishBilling = () => {
          if (!reserved || finalized) return
          finalized = true
          if (usage) {
            try {
              const row = management.settleText(requestId, { points: textCreditsForUsage(prepared.model.id, usage, settings.textPrices), inputTokens: usage.input_tokens, outputTokens: usage.output_tokens })
              if (row?.status === 'billing_review') { billingStatus = row.status; return }
              if (row?.status !== 'settled') { review('上游已报告实际用量，结算状态需要核对'); return }
              billingStatus = 'settled'
            } catch { review('上游已报告实际用量，结算写入未完成') }
            return
          }
          const code = transportError?.cause?.code || transportError?.code
          const unsubmitted = upstreamStatus === 0 && ['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)
            || upstreamStatus >= 400 && upstreamStatus < 500 && ![408, 409].includes(upstreamStatus)
          if (unsubmitted) {
            try {
              const row = management.failText(requestId, '请求未送达或已被上游明确拒绝')
              if (!confirmedBilling(row)) review('明确未送达或已拒绝，退款状态需要核对')
            }
            catch { review('明确未送达或已拒绝，退款写入未完成') }
          } else review('已派发请求未取得权威终态用量，保留原预扣待核对')
        }
        let result: any
        try {
          result = await createTextCompletion(prepared, { signal: operation.signal, fetchImpl: async (input, init) => {
            if (request.aborted || response.destroyed) disconnected()
            // Reserve only at the actual transport boundary. From here a
            // closed reader cannot cancel the provider's final usage receipt.
            operation.dispatch(() => {
              assertTextAccess({ management, session })
              management.reserveText({ session, model: prepared.model.id, requestId, points: reservePoints })
              reserved = true
              billingStatus = 'reserved'
            })
            try {
              const upstream = await fetch(input, init)
              upstreamStatus = upstream.status
              const id = upstream.headers.get('x-request-id') || upstream.headers.get('request-id')
              if (id && /^[A-Za-z0-9_-]{1,200}$/.test(id)) providerRequestId = id
              return upstream
            } catch (error) { transportError = error; throw error }
          } })
          usage = completionUsage(prepared.model.protocol, result.usage)
        } catch (error) {
          transportError ??= error
          usage = completionUsage(prepared.model.protocol, error?.usage)
          throw error
        } finally {
          finishBilling()
        }
        if (connected()) json(response, 200, { ok: true, ...result, billing: { requestId, status: billingStatus } })
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
