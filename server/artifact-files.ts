import { Buffer } from 'node:buffer'
import { statSync } from 'node:fs'
import { artifactDirectory, artifactPath, readArtifactFile, removeArtifactFile, writeArtifactFile } from './media-files.ts'
import { MEDIA_LAYOUT_BLOB, BlobStore, mediaLayout } from './blob-store.ts'

// 生成结果（artifacts 表）的字节层：和 workspace_files 同一套做法——
// 数据库只留瘦索引（id/request_id/mime/storage/size/blob + artifact_expiry 里的过期时间），
// 字节不在这里单独存一份。
//
// 内容寻址之后，生成结果的字节和「画布上那份素材」是**同一份**：
// 前端从 /api/imagine/result/<id> 取回字节写进工作区时，两边算出的是同一个 sha，
// 盘上只落一次。以前这里是两份一模一样的字节（_artifacts 一份、工作区一份），
// 用户的原话是「你这个地方存一份一模一样的东西，那个地方又存一模一样的东西，那就不合理」。
//
// 为什么放在 MEDIA_ROOT 里面而不是旁边的兄弟目录：
// 1. 媒体目录已经是持久化的 bind mount（/opt/miaoimg/media → /app/media），
//    兄弟目录 /app/artifacts 会落在容器可写层，重新部署就没；这些字节是用户花积分换来的图，不能丢。
// 2. 复用同一份权限档位（OIP_MEDIA_MODE）与同一套对账/回收逻辑，不新增挂载和环境变量。
// 3. 保留目录名用下划线开头，和 userId（UUID）不会撞名。
//
// 过期（artifact_expiry）= **删掉这条引用**，不等于删字节：
// 画布上那份素材还引用着同一份字节时，历史过期不该把用户的画布弄坏。
// 最后一个引用也没了，blob-store 的 release() 才真正回收。

export const artifactTableDdl = name => `CREATE TABLE ${name}(
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES generations(id),
  mime TEXT NOT NULL, bytes BLOB,
  storage TEXT NOT NULL DEFAULT 'disk', size INTEGER NOT NULL DEFAULT 0,
  blob TEXT)`

// 建表 / 从老结构升级。老库的 bytes 是 NOT NULL，迁移后要写成 NULL，SQLite 改不了列约束，只能重建表。
// 和 workspace_files 不同的是：artifact_expiry 是 artifacts 的子表且带 ON DELETE CASCADE，
// 外键开着时 DROP 父表会顺手把子表行（过期时间）一起删掉，所以必须按 SQLite 官方的流程，
// 先关外键、在事务里重建、用 foreign_key_check 验完再打开。
export async function ensureArtifactSchema(store) {
  const columns = (await store.all('PRAGMA table_info(artifacts)'))
  if (!columns.length) { await store.db.exec(artifactTableDdl('artifacts')); return }
  const names = new Set(columns.map(column => column.name))
  const bytesColumn = columns.find(column => column.name === 'bytes')
  if (names.has('storage') && names.has('size') && bytesColumn && !bytesColumn.notnull) {
    // 结构已经是磁盘版，只差内容寻址的 blob 列（可空 ADD COLUMN，不用重建表）。
    // 同上：多进程同时启动时两边都会走到这里，duplicate column name 说明列已经加好了。
    if (!names.has('blob')) {
      try { await store.db.exec('ALTER TABLE artifacts ADD COLUMN blob TEXT') } catch (error) {
        if (!/duplicate column name/i.test(error?.message || '')) throw error
      }
    }
    return
  }
  const storage = names.has('storage') ? "COALESCE(storage,'db')" : "'db'"
  const size = names.has('size') ? 'size' : 'COALESCE(length(bytes),0)'
  const blob = names.has('blob') ? 'blob' : 'NULL'
  await store.db.exec('PRAGMA foreign_keys=OFF')
  try {
    await store.transaction(async () => {
      await store.db.exec(artifactTableDdl('artifacts_upgrade'))
      await store.db.exec(`INSERT INTO artifacts_upgrade(id,request_id,mime,bytes,storage,size,blob)
        SELECT id,request_id,mime,bytes,${storage},${size},${blob} FROM artifacts`)
      await store.db.exec('DROP TABLE artifacts')
      await store.db.exec('ALTER TABLE artifacts_upgrade RENAME TO artifacts')
    })
    const broken = (await store.all('PRAGMA foreign_key_check'))
    if (broken.length) throw new Error(`artifacts 重建后外键校验失败：${JSON.stringify(broken.slice(0, 5))}`)
  } finally {
    await store.db.exec('PRAGMA foreign_keys=ON')
  }
  const after = (await store.get('SELECT COUNT(*) AS rows, COALESCE(SUM(length(bytes)),0) AS bytes FROM artifacts'))
  const expiry = (await store.get('SELECT COUNT(*) AS rows FROM artifact_expiry'))
  console.log(`[artifacts] artifacts 表已升级：bytes 允许为空，新增 storage/size/blob 列；${after.rows} 行 / ${after.bytes} 字节、${expiry.rows} 条过期时间原样保留`)
}

export class ArtifactFiles {
  declare store: any
  declare blobs: any
  declare layout: any

  async initialize(store) {
    this.store = store
    this.blobs = typeof store.blobStore === 'function' ? store.blobStore() : new BlobStore(store)
    this.layout = (await mediaLayout(store))
    await ensureArtifactSchema(store)
  }

  // 幂等：把 bytes 列里的历史数据搬到磁盘，索引改成 storage='disk'、bytes 置 NULL。
  // 逐行事务，单行失败只记日志继续处理其余行；中途崩溃后重跑即可（未搬的行仍是 storage='db'）。
  // 顺序永远是「先写文件、再清数据库」，任何时刻库里都有一份完整数据。
  async migrateToDisk() {
    const before = (await this.store.get('SELECT COUNT(*) AS rows, COALESCE(SUM(length(bytes)),0) AS bytes FROM artifacts'))
    const pending = (await this.store.all("SELECT id,mime,bytes,request_id FROM artifacts WHERE storage<>'disk' AND storage<>'blob' AND bytes IS NOT NULL"))
    if (!pending.length) return { migrated: 0, failed: 0, bytes: 0 }
    console.log(`[artifacts] 开始把生成结果搬到磁盘：索引 ${before.rows} 行 / ${before.bytes} 字节，本次待迁 ${pending.length} 个文件`)
    let migrated = 0
    let failed = 0
    let moved = 0
    for (const row of pending) {
      const content = Buffer.from(row.bytes)
      try {
        const placed = (await this.put((await this.ownerOf(row)), row.id, content))
        await this.store.transaction(async () => {
          await this.store.run("UPDATE artifacts SET bytes=NULL,storage=?,size=?,blob=? WHERE id=?", placed.blob ? 'blob' : 'disk', placed.size, placed.blob, row.id)
        })
        migrated += 1
        moved += content.length
      } catch (error) {
        failed += 1
        console.error(`[artifacts] 迁移失败，这一行保留在数据库里下次重试：id=${row.id} ${error?.message || error}`)
      }
    }
    const after = (await this.store.get('SELECT COUNT(*) AS rows, COALESCE(SUM(length(bytes)),0) AS bytes FROM artifacts'))
    console.log(`[artifacts] 迁移结束：成功 ${migrated} 个 / ${moved} 字节，失败 ${failed} 个；索引 ${after.rows} 行（迁移前 ${before.rows}），bytes 剩余 ${after.bytes} 字节（迁移前 ${before.bytes}）`)
    return { migrated, failed, bytes: moved }
  }

  // 生成结果的归属账号。artifacts 表本身没有 user_id，跟 generations 取——查不到就是
  // 没有账号归属的 guest 结果，落在媒体根下的保留桶里。
  async ownerOf(row) {
    try {
      const generation = (await this.store.get('SELECT user_id FROM generations WHERE id=?', row.request_id))
      return generation?.user_id || ''
    } catch { return '' }
  }

  // 只负责字节：调用方（finish()）在同一个事务里写 artifacts 与 artifact_expiry 两行索引。
  // 返回 { blob, size }，blob 由调用方写进索引行。
  async put(userId, id, bytes) {
    if (this.store.db?.isTransaction) await this.store.db.lock(`media:${userId || ""}`)
    const content = Buffer.from(bytes)
    // 现读布局标记，不用构造时缓存的那份：迁移可以在服务运行期间翻标记（同 workspace-files）。
    let layout = this.layout
    try { layout = (await mediaLayout(this.store)) } catch { /* 读不到就按启动时的判断走 */ }
    if (layout === MEDIA_LAYOUT_BLOB) return { blob: (await this.blobs.put(userId || '', content)), size: content.length }
    writeArtifactFile(id, content)
    return { blob: null, size: content.length }
  }

  // 结果接口需要先决定能否交给 nginx 直出，再决定是否把字节读进 Node。
  // 这里沿用工作区 locate() 的约定：磁盘文件只返回路径，数据库旧行才返回 bytes。
  async locate(row, userId = '') {
    if (row.blob) {
      const info = (await this.blobs.stat(userId || '', row.blob))
      return info ? { diskPath: info.full, size: info.size } : null
    }
    if (row.storage === 'disk') {
      const full = artifactPath(row.id)
      try {
        const info = statSync(full)
        return info.isFile() ? { diskPath: full, size: info.size } : null
      } catch { return null }
    }
    const bytes = row.bytes ? Buffer.from(row.bytes) : Buffer.alloc(0)
    return { bytes, size: bytes.length, diskPath: null }
  }

  // 优先读 blob；路径树布局读 _artifacts/<id>；未迁移的行（storage='db'）回退读 bytes 列。
  // 文件缺失返回 null，调用方按“这张图没了”处理（对外行为与过期一致：410）。
  async read(row, userId = '') {
    const located = (await this.locate(row, userId))
    if (!located) return null
    if (located.bytes) return located.bytes
    if (row.blob) {
      const bytes = (await this.blobs.read(userId || '', row.blob))
      if (!bytes) console.warn(`[artifacts] 索引存在但 blob 缺失（数据丢失，跑 node server/media-reconcile.ts 看完整清单）：id=${row.id} blob=${row.blob}`)
      return bytes
    }
    const bytes = readArtifactFile(row.id)
    if (!bytes) console.warn(`[artifacts] 索引存在但磁盘文件缺失：id=${row.id}`)
    return bytes
  }

  // 删掉一条引用之后处理字节：内容寻址的行交给 blob-store（活跃集合里还有人用就留着），
  // 路径树布局的行照老办法删文件。尽力而为，删不掉只记日志（交给 media-reconcile 回收）。
  async release(row, userId = '') {
    if (row.blob) return (await this.blobs.release(userId || '', row.blob))
    return removeArtifactFile(row.id)
  }

  static async open<T extends new (...args: any[]) => any>(this: T, ...args: any[]): Promise<InstanceType<T>> {
    const value = new this()
    try { await value.initialize(...args); return value }
    catch (error) { await value.db?.close?.().catch(() => {}); throw error }
  }
}

export { artifactDirectory }
