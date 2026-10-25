import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Provider credentials live outside the image and are mounted read-only at
// /app/secrets in production. Environment variables remain a migration
// fallback for an older container, but new deployments do not need them.
const SECRET_FILES = Object.freeze({
  SUIHE_API_KEY: ['suihe-api-key', 'suihe-api-key.txt'],
  ARK_API_KEY: ['ark-api-key', 'ark-api-key.txt'],
  YUNSHU_API_KEY: ['yunshu-api-key', 'yunshu-api-key.txt'],
  GROK_API_KEY: ['grok-api-key', 'grok-api-key.txt'],
  DEEPSEEK_API_KEY: ['deepseek-api-key', 'deepseek-api-key.txt'],
  SUB2API_API_KEY: ['sub2api-api-key', 'sub2api-api-key.txt'],
  EXA_API_KEY: ['exa-api-key', 'exa-api-key.txt'],
  METASO_API_KEY: ['metaso-api-key', 'metaso-api-key.txt', 'metaso-api-keys.txt'],
  OIP_ADMIN_EMAIL: ['admin-email', 'admin-email.txt'],
  OIP_ADMIN_PASSWORD: ['admin-password', 'admin-password.txt'],
  OIP_ADMIN_TOKEN: ['admin-token', 'admin-token.txt'],
  ZPAY_PID: ['zpay-pid', 'zpay-pid.txt'],
  ZPAY_KEY: ['zpay-key', 'zpay-key.txt'],
  GOOGLE_OAUTH_CLIENT_ID: ['google-client-id', 'google-client-id.txt'],
  GOOGLE_OAUTH_CLIENT_SECRET: ['google-client-secret', 'google-client-secret.txt'],
  QQ_OAUTH_APP_ID: ['qq-app-id', 'qq-app-id.txt'],
  QQ_OAUTH_APP_KEY: ['qq-app-key', 'qq-app-key.txt'],
  GITHUB_OAUTH_CLIENT_ID: ['github-client-id', 'github-client-id.txt'],
  GITHUB_OAUTH_CLIENT_SECRET: ['github-client-secret', 'github-client-secret.txt'],
  WECHAT_OAUTH_APP_ID: ['wechat-app-id', 'wechat-app-id.txt'],
  WECHAT_OAUTH_APP_SECRET: ['wechat-app-secret', 'wechat-app-secret.txt'],
  DINGTALK_OAUTH_CLIENT_ID: ['dingtalk-client-id', 'dingtalk-client-id.txt'],
  DINGTALK_OAUTH_CLIENT_SECRET: ['dingtalk-client-secret', 'dingtalk-client-secret.txt'],
  LINUXDO_OAUTH_CLIENT_ID: ['linuxdo-client-id', 'linuxdo-client-id.txt'],
  LINUXDO_OAUTH_CLIENT_SECRET: ['linuxdo-client-secret', 'linuxdo-client-secret.txt'],
  OIDC_OAUTH_CLIENT_ID: ['oidc-client-id', 'oidc-client-id.txt'],
  OIDC_OAUTH_CLIENT_SECRET: ['oidc-client-secret', 'oidc-client-secret.txt'],
  SMTP_USER: ['smtp-user', 'smtp-user.txt'],
  SMTP_PASSWORD: ['smtp-password', 'smtp-password.txt'],
  OTP_PEPPER: ['otp-pepper', 'otp-pepper.txt'],
})

function secretDirectories(env = process.env) {
  const configured = String(env.OIP_SECRETS_DIR || '').trim()
  return [...new Set([
    configured ? resolve(configured) : '',
    '/app/secrets',
    '/opt/miaoimg/secrets',
    resolve(process.cwd(), 'secrets'),
  ].filter(Boolean))]
}

function valueFromText(text, name) {
  const source = String(text || '').trim()
  if (!source) return ''
  const lines = source.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
  const named = lines.find(line => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*[:=]\s*(.*?)\s*$/.exec(line)
    return match && match[1] === name
  })
  if (named) return /^([A-Za-z_][A-Za-z0-9_]*)\s*[:=]\s*(.*?)\s*$/.exec(named)[2].trim()
  if (lines.length === 1) return lines[0]
  if (name === 'METASO_API_KEY') return source.match(/\bmk-[A-Za-z0-9_-]{8,}\b/)?.[0] || ''
  return ''
}

function fileValueWithSource(name, env = process.env) {
  for (const directory of secretDirectories(env)) {
    for (const filename of SECRET_FILES[name] || []) {
      const path = join(directory, filename)
      if (!existsSync(path)) continue
      try {
        const value = valueFromText(readFileSync(path, 'utf8'), name)
        if (value) return { value, path }
      } catch {
        // A missing/unreadable optional secret behaves like an unconfigured one.
      }
    }
  }
  return { value: '', path: '' }
}

export function runtimeSecretSource(name, env = process.env, { allowEnv = true }: Record<string, any> = {}) {
  const key = String(name || '').trim()
  // Mock mode must never inspect mounted production credentials.  A missing
  // environment value remains missing and is reported by the provider policy.
  if (String(env.OIP_MOCK_PROVIDERS || '').trim() === '1') {
    return { value: allowEnv ? String(env[key] || '').trim() : '', path: '' }
  }
  const file = fileValueWithSource(key, env)
  if (file.value) return file
  return { value: allowEnv ? String(env[key] || '').trim() : '', path: '' }
}

export function runtimeSecret(name, env = process.env) {
  return runtimeSecretSource(name, env).value
}

export function runtimeSecretConfigured(name, env = process.env) {
  return Boolean(runtimeSecret(name, env))
}

export function secretFileNames() {
  return Object.fromEntries(Object.entries(SECRET_FILES).map(([name, files]) => [name, [...files]]))
}
