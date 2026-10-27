import { failure } from './management-store.ts'
import { publicAddresses } from './network/public-host.ts'
import { fetchPinnedResponse } from './network/pinned-fetch.ts'
import { assertProviderRequestAllowed, isMockProviderMode } from './provider-safety.ts'

// A creation POST may have been accepted before its redirect was returned.
// Keep that evidence distinct from a local 422 configuration rejection.
export class ProviderRedirectError extends Error {
  status = 502
  code = 'UPSTREAM_REDIRECT'
  submissionUncertain = true
  upstreamStatus: number
  constructor(status: number) {
    super('生成服务地址发生变化，请联系妙图团队核对原任务，避免重复提交')
    this.upstreamStatus = status
  }
}

// This policy is selected by the host, never by a saved provider or request
// payload. Cloud users cannot turn their own API URL into a server LAN proxy;
// Native desktop providers and host-configured built-in APIs may intentionally
// use a local relay or LAN service. That trust never comes from request JSON.
export function createCustomProviderFetch({ allowPrivate = false, env = process.env, fetchImpl = fetch, lookupImpl,
  beforeDispatch,
  redirectMessage = '供应商 API 返回跳转，请在配置中填写最终 API 地址', redirectFailure }: Record<string, any> = {}): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    try {
      const target = new URL(request.url)
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw failure('供应商 API 地址无效', 422)
      request.signal.throwIfAborted()
      // SDKs may append their own protocol query parameters (e.g. beta flags).
      // The mock boundary concerns the origin/path, not those parameters.
      assertProviderRequestAllowed('custom-text', target.origin + target.pathname, env)
      let response: Response
      if (allowPrivate || isMockProviderMode(env)) {
        // This hook is synchronous: no setup/DNS await may separate the last
        // eligibility read from starting the actual transport.
        beforeDispatch?.(request.signal)
        request.signal.throwIfAborted()
        response = await fetchImpl(request, { redirect: 'manual' })
      } else {
        const addresses = await publicAddresses(target.hostname.replace(/^\[|\]$/g, ''), {
          signal: request.signal, ...(lookupImpl ? { lookupImpl } : {}),
          denied: '云端自定义供应商只支持公网地址；本机或局域网模型请在桌面版配置',
          unresolved: '供应商地址无法解析，请检查 API 地址',
        })
        request.signal.throwIfAborted()
        beforeDispatch?.(request.signal)
        request.signal.throwIfAborted()
        response = await fetchPinnedResponse(target, addresses, {
          signal: request.signal, headers: Object.fromEntries(request.headers), method: request.method, body: request.body, fetchImpl,
        })
      }
      // Never replay a model request or forward the user's credentials to a
      // Location supplied by an upstream service. Ask for its canonical API URL.
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {})
        throw redirectFailure ? redirectFailure(response.status) : failure(redirectMessage, 422)
      }
      return response
    } catch (error) {
      await request.body?.cancel().catch(() => {})
      // SDKs wrap a thrown fetch error as a connection failure and retry it.
      // A rejected address/configuration is a final HTTP error, not an outage.
      if (error?.status !== 422) throw error
      return Response.json({ error: { message: error.message } }, { status: 422, headers: { 'x-should-retry': 'false' } })
    }
  }
}

// Media API origins come from server configuration, never a user's API URL.
// Downloads of completed files own their separate, per-hop address checks.
export function createMediaProviderFetch({ env = process.env, fetchImpl = fetch }: Record<string, any> = {}): typeof fetch {
  return createCustomProviderFetch({ allowPrivate: true, env, fetchImpl, redirectFailure: status => new ProviderRedirectError(status) })
}
