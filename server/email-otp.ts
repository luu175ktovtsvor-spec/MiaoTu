import { randomInt } from 'node:crypto'
import { connect as tlsConnect } from 'node:tls'
import { digest, failure, normalizeEmail, validEmail } from './management-store.ts'
import { runtimeSecret } from './runtime-secrets.ts'

const CODE_TTL_MS = 10 * 60 * 1000
const RESEND_COOLDOWN_MS = 60 * 1000
const MAX_ATTEMPTS = 5
const SMTP_TIMEOUT_MS = 15 * 1000

function cleanHeader(value, name) {
  const text = String(value || '').trim()
  if (!text || /[\r\n]/.test(text)) throw failure(`${name} 配置无效`, 500)
  return text
}

const SENDER_NAME = '妙图'

function mailboxAddress(value, fallback) {
  const text = String(value || '').trim()
  const wrapped = /^.*<([^<>]+)>$/.exec(text)
  const address = (wrapped ? wrapped[1] : text || fallback).trim()
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(address)) throw failure('SMTP 发件人配置无效', 500)
  return address
}

function headerText(value) {
  const text = String(value || '')
  if (/^[\t\x20-\x7E]*$/.test(text)) return text
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`
}

function smtpConfig(env = process.env) {
  const user = cleanHeader(runtimeSecret('SMTP_USER', env) || env.OIP_SMTP_USER, 'SMTP 用户名')
  const password = runtimeSecret('SMTP_PASSWORD', env) || env.OIP_SMTP_PASSWORD || env.OIP_SMTP_PASS || ''
  const host = cleanHeader(env.OIP_SMTP_HOST || 'smtp.qq.com', 'SMTP 主机')
  const port = Number(env.OIP_SMTP_PORT || 465)
  const from = mailboxAddress(env.OIP_SMTP_FROM || user, user)
  const pepper = runtimeSecret('OTP_PEPPER', env) || env.OIP_OTP_PEPPER || ''
  if (!user || !password || !pepper || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return { user, password, host, port, from, fromHeader: `${headerText(SENDER_NAME)} <${from}>`, pepper }
}

function codeHash(email, code, pepper) {
  return digest(`miaoimg-email-otp:v1:${pepper}:${email}:${code}`)
}

function smtpResponse(socket) {
  let buffer = ''
  return new Promise<any>((resolve, reject) => {
    const onData = chunk => {
      buffer += chunk.toString()
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      const complete = []
      for (const line of lines) {
        if (/^\d{3} /.test(line)) complete.push(line)
      }
      if (!complete.length) return
      cleanup()
      const last = complete.at(-1)
      const code = Number(last.slice(0, 3))
      if (code >= 400) reject(new Error(`SMTP ${code}`))
      else resolve({ code, lines: complete })
    }
    const onError = () => { cleanup(); reject(new Error('SMTP 连接失败')) }
    const onClose = () => { cleanup(); reject(new Error('SMTP 连接已关闭')) }
    const cleanup = () => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

async function smtpCommand(socket, command, expected = []) {
  socket.write(`${command}\r\n`)
  const response = await smtpResponse(socket)
  if (expected.length && !expected.includes(response.code)) throw new Error(`SMTP 响应异常: ${response.code}`)
  return response
}

async function sendSmtp({ to, subject, text }: Record<string, any>, config) {
  if (config.port !== 465) throw new Error('当前 SMTP 发信仅支持 SSL 465 端口')
  const socket = tlsConnect({ host: config.host, port: config.port, servername: config.host, timeout: SMTP_TIMEOUT_MS })
  socket.setEncoding('utf8')
  try {
    await smtpResponse(socket)
    await smtpCommand(socket, `EHLO miaoimg`, [250])
    await smtpCommand(socket, 'AUTH LOGIN', [334])
    await smtpCommand(socket, Buffer.from(config.user).toString('base64'), [334])
    await smtpCommand(socket, Buffer.from(config.password).toString('base64'), [235])
    await smtpCommand(socket, `MAIL FROM:<${config.from}>`, [250])
    await smtpCommand(socket, `RCPT TO:<${to}>`, [250, 251])
    await smtpCommand(socket, 'DATA', [354])
    const body = [
      `From: ${config.fromHeader}`,
      `To: ${to}`,
      `Subject: ${headerText(subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      text,
      '.',
    ].join('\r\n')
    await smtpCommand(socket, body, [250])
    await smtpCommand(socket, 'QUIT', [221, 250])
  } finally {
    socket.destroy()
  }
}

function publicConfig(env = process.env) {
  const config = smtpConfig(env)
  return { enabled: Boolean(config), host: config?.host || null, port: config?.port || null }
}

export function createEmailOtp({ management, env = process.env }: Record<string, any> = {}) {
  if (!management) throw new Error('email OTP requires management store')
  return {
    config: () => publicConfig(env),
    async request(email) {
      const normalized = normalizeEmail(email)
      if (!validEmail(normalized)) throw failure('请输入有效的邮箱地址')
      const config = smtpConfig(env)
      if (!config) throw failure('邮箱验证码服务暂未配置', 503)
      const now = Date.now()
      const code = String(randomInt(100000, 1000000))
      const stored = management.issueEmailOtp({ email: normalized, codeHash: codeHash(normalized, code, config.pepper), now, expiresAt: now + CODE_TTL_MS, cooldownMs: RESEND_COOLDOWN_MS })
      await sendSmtp({
        to: normalized,
        subject: '妙图登录验证码',
        text: `你的妙图登录验证码是：${code}\n\n验证码 10 分钟内有效。如非本人操作，请忽略此邮件。`,
      }, config)
      return { cooldown: Math.ceil((stored.nextAllowedAt - now) / 1000) }
    },
    verify(email, code, name = '', password = '') {
      const normalized = normalizeEmail(email)
      if (!validEmail(normalized) || !/^\d{6}$/.test(String(code || '').trim())) throw failure('验证码错误或已过期', 401)
      const config = smtpConfig(env)
      if (!config) throw failure('邮箱验证码服务暂未配置', 503)
      // 密码不对时不消耗验证码，避免一次手误就要重发邮件。
      management.assertEmailPassword(normalized, password)
      management.consumeEmailOtp({ email: normalized, codeHash: codeHash(normalized, String(code).trim(), config.pepper), now: Date.now(), maxAttempts: MAX_ATTEMPTS })
      return management.loginEmailOtp(normalized, name, password)
    },
  }
}

