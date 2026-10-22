import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { closeSync, constants, existsSync, fchmodSync, fstatSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const localHeader = Buffer.from('miao-session-local-v1\n')
const ivLength = 12, tagLength = 16

// Mac 预览包明确使用本机文件密钥，不因系统授权失败而静默降级。
// 正式签名后可将打包配置 macCredentialProtection 改为 system。
export class SessionStorage {
  declare protection: any
  declare getSafeStorage: any
  declare keyFile: any

  constructor({ directory, protection, getSafeStorage }: Record<string, any>) {
    if (!['local-key', 'system'].includes(protection)) throw new Error('登录凭证保护方式无效')
    this.protection = protection
    this.getSafeStorage = getSafeStorage
    this.keyFile = join(directory, 'cloud-session.key')
  }
  localKey(create = false) {
    if (create && !existsSync(this.keyFile)) {
      try { writeFileSync(this.keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 }) }
      catch (error) { if (error.code !== 'EEXIST') throw error }
    }
    const fd = openSync(this.keyFile, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size !== 32 || (process.getuid && stat.uid !== process.getuid())) throw new Error('登录密钥文件无效')
      if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600)
      return readFileSync(fd)
    } finally { closeSync(fd) }
  }
  async decrypt(encrypted) {
    if (encrypted.subarray(0, localHeader.length).equals(localHeader)) {
      if (encrypted.length < localHeader.length + ivLength + tagLength) throw new Error('登录凭证文件无效')
      const offset = localHeader.length
      const decipher = createDecipheriv('aes-256-gcm', this.localKey(), encrypted.subarray(offset, offset + ivLength))
      decipher.setAAD(localHeader)
      decipher.setAuthTag(encrypted.subarray(offset + ivLength, offset + ivLength + tagLength))
      return { result: Buffer.concat([decipher.update(encrypted.subarray(offset + ivLength + tagLength)), decipher.final()]).toString('utf8'), shouldReEncrypt: this.protection !== 'local-key' }
    }
    // 旧钥匙串凭证在预览版不自动解密；重新登录后用新格式保存。
    if (this.protection === 'local-key') return null
    const safeStorage = this.getSafeStorage()
    if (!await safeStorage.isAsyncEncryptionAvailable()) return null
    return safeStorage.decryptStringAsync(encrypted)
  }
  async encrypt(value) {
    if (this.protection === 'local-key') {
      const iv = randomBytes(ivLength)
      const cipher = createCipheriv('aes-256-gcm', this.localKey(true), iv)
      cipher.setAAD(localHeader)
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([localHeader, iv, cipher.getAuthTag(), encrypted])
    }
    const safeStorage = this.getSafeStorage()
    if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('系统凭证保护暂不可用')
    return safeStorage.encryptStringAsync(value)
  }
  committed() {
    if (this.protection === 'system') rmSync(this.keyFile, { force: true })
  }
  clear() { rmSync(this.keyFile, { force: true }) }
}
