// Provider egress policy.  Mock mode is deliberately strict: every channel
// must be explicitly pointed at a loopback mock and every credential must be
// supplied through the environment.  There is no fallback to production URLs
// or mounted secret files in that mode.

const MOCK_FLAG = 'OIP_MOCK_PROVIDERS'

export const PROVIDER_CHANNELS = Object.freeze([
  { id: 'suihe', baseEnv: 'SUIHE_BASE_URL', keyEnvs: ['SUIHE_API_KEY'] },
  { id: 'ark', baseEnv: 'ARK_BASE_URL', keyEnvs: ['ARK_API_KEY'] },
  { id: 'yunshu', baseEnv: 'YUNSHU_BASE_URL', keyEnvs: ['YUNSHU_API_KEY'] },
  { id: 'grok', baseEnv: 'GROK_BASE_URL', keyEnvs: ['GROK_API_KEY'] },
  { id: 'metaso', baseEnv: 'METASO_BASE_URL', keyEnvs: ['METASO_API_KEY'] },
  { id: 'sub2api', baseEnv: 'SUB2API_BASE_URL', keyEnvs: ['SUB2API_API_KEY'] },
  { id: 'deepseek', baseEnv: 'DEEPSEEK_BASE_URL', keyEnvs: ['DEEPSEEK_API_KEY'] },
  { id: 'zpay', baseEnv: 'ZPAY_BASE_URL', keyEnvs: ['ZPAY_PID', 'ZPAY_KEY'] },
])

export function isMockProviderMode(env = process.env) {
  return String(env?.[MOCK_FLAG] || '').trim() === '1'
}

function loopbackUrl(value) {
  let url
  try { url = new URL(String(value || '').trim()) } catch { return null }
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(host)) return null
  if (url.username || url.password || url.search || url.hash) return null
  return url
}

function mockError(message) {
  return new Error(`测试模式下不允许访问真实上游：${message}`)
}

export function assertMockProviderConfiguration(env = process.env) {
  if (!isMockProviderMode(env)) return
  for (const channel of PROVIDER_CHANNELS) {
    const base = String(env?.[channel.baseEnv] || '').trim()
    if (!base) throw mockError(`${channel.id} 缺少显式 mock 地址 ${channel.baseEnv}`)
    if (!loopbackUrl(base)) throw mockError(`${channel.id} 的 ${channel.baseEnv}=${base || '(空)'} 不是本地 mock 地址`)
    for (const keyEnv of channel.keyEnvs) {
      if (!Object.prototype.hasOwnProperty.call(env, keyEnv) || !String(env?.[keyEnv] || '').trim()) {
        throw new Error(`测试模式下必须显式提供假凭据 ${keyEnv}；不会读取钥匙串或 secrets/`)
      }
    }
  }
}

export function assertProviderRequestAllowed(channel, target, env = process.env) {
  if (!isMockProviderMode(env)) return
  const url = loopbackUrl(target)
  if (!url) throw mockError(`${channel} 请求目标 ${String(target || '(空)')} 不是显式本地 mock 地址`)
}

export function mockProviderAudit(env = process.env) {
  return isMockProviderMode(env) ? { mock: true } : {}
}

