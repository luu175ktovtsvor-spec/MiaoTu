import { readFileSync } from 'node:fs'
import { runtimeSecret } from './runtime-secrets.ts'

export function parsePaymentCredentials(text) {
  const pid = /^\s*商户号[（(]PID[）)]\s*[:：]\s*(\S+)\s*$/mi.exec(text)?.[1] || ''
  const key = /^\s*商户密钥[（(]KEY[）)]\s*[:：]\s*(\S+)\s*$/mi.exec(text)?.[1] || ''
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(pid) || !/^[A-Za-z0-9_-]{16,256}$/.test(key)) throw new Error('支付功能暂时不可用，请稍后再试')
  return { pid, key }
}

// Legacy Markdown compatibility only. Mounted credential files take precedence
// and do not need to be copied into the process environment.
export function loadPaymentEnvironment(filePath, env = process.env) {
  if (String(env.OIP_MOCK_PROVIDERS || '').trim() === '1') return false
  if (runtimeSecret('ZPAY_PID', env) && runtimeSecret('ZPAY_KEY', env)) return false
  let text
  try { text = readFileSync(filePath, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return false
    throw new Error('支付功能暂时不可用，请稍后再试')
  }
  const credentials = parsePaymentCredentials(text)
  env.ZPAY_PID ||= credentials.pid
  env.ZPAY_KEY ||= credentials.key
  env.ZPAY_BASE_URL ||= 'https://zpayz.cn'
  return true
}
