import { randomUUID } from 'node:crypto'
import { failure } from './management-store.ts'

// 用户反馈：桌面端提交，管理后台处理，形式类似 issue——编号、标题、类型、状态，
// 下面是用户和管理员的往来回复。截图直接存进同一个数据库，单张 4MB、每次最多 4 张。

export const FEEDBACK_CATEGORIES = ['bug', 'feature', 'question'] as const
export const FEEDBACK_LABELS = ['已确认', '处理中', '已修复', '下个版本', '无法复现', '重复'] as const
const MAX_TITLE = 120
const MAX_BODY = 8000
const MAX_COMMENT = 4000
const MAX_ATTACHMENTS = 4
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024
const IMAGE_MIME = /^image\/(png|jpeg|webp|gif)$/

type Store = { run: (sql: string, ...args: any[]) => Promise<any>; get: (sql: string, ...args: any[]) => Promise<any>; all: (sql: string, ...args: any[]) => Promise<any[]>; transaction: <T>(fn: () => T | Promise<T>) => Promise<T>; db?: any; exec?: (sql: string) => Promise<void>; user: (id: string) => Promise<any>; audit: (actor: string, action: string, target: string, details?: Record<string, any>) => Promise<void> }

function text(value: unknown, max: number, label: string, required = true) {
  const result = String(value ?? '').replace(/\r\n/g, '\n').trim()
  if (required && !result) throw failure(`请填写${label}`, 422)
  if (result.length > max) throw failure(`${label}不能超过 ${max} 个字`, 422)
  return result
}

export async function createFeedbackStore(store: Store) {
  const exec = async (sql: string) => store.exec ? (await store.exec(sql)) : (await store.db.exec(sql))
  await exec(`
    CREATE TABLE IF NOT EXISTS feedback_issues(id TEXT PRIMARY KEY,number INTEGER NOT NULL UNIQUE,user_id TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,category TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',labels TEXT NOT NULL DEFAULT '[]',context TEXT NOT NULL DEFAULT '{}',user_unread INTEGER NOT NULL DEFAULT 0,admin_unread INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,closed_at TEXT);
    CREATE INDEX IF NOT EXISTS feedback_issues_user ON feedback_issues(user_id,updated_at DESC);
    CREATE INDEX IF NOT EXISTS feedback_issues_status ON feedback_issues(status,updated_at DESC);
    CREATE TABLE IF NOT EXISTS feedback_comments(id TEXT PRIMARY KEY,issue_id TEXT NOT NULL REFERENCES feedback_issues(id) ON DELETE CASCADE,author TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS feedback_comments_issue ON feedback_comments(issue_id,created_at);
    CREATE TABLE IF NOT EXISTS feedback_attachments(id TEXT PRIMARY KEY,issue_id TEXT NOT NULL REFERENCES feedback_issues(id) ON DELETE CASCADE,name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,bytes BLOB NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS feedback_number_sequence(id INTEGER PRIMARY KEY CHECK(id=1),value INTEGER NOT NULL);
    INSERT OR IGNORE INTO feedback_number_sequence(id,value) SELECT 1,COALESCE(MAX(number),0) FROM feedback_issues;
  `)

  const parse = (value: string, fallback: any) => { try { return JSON.parse(value) } catch { return fallback } }
  const summary = (row: any, forAdmin = false) => ({
    id: row.id, number: row.number, title: row.title, category: row.category, status: row.status,
    labels: parse(row.labels, []), comments: Number(row.comments || 0), attachments: Number(row.attachments || 0),
    unread: Number(forAdmin ? row.admin_unread : row.user_unread) > 0,
    createdAt: row.created_at, updatedAt: row.updated_at, closedAt: row.closed_at || null,
    ...(forAdmin ? { user: { id: row.user_id, name: row.user_name || '', email: row.user_email || '' } } : {}),
  })
  const counts = `(SELECT COUNT(*) FROM feedback_comments c WHERE c.issue_id=i.id) AS comments,(SELECT COUNT(*) FROM feedback_attachments a WHERE a.issue_id=i.id) AS attachments`

  async function issueFor(id: string, userId?: string) {
    const row = (await store.get('SELECT * FROM feedback_issues WHERE id=?', String(id || '')))
    if (!row || (userId !== undefined && row.user_id !== userId)) throw failure('没有找到这条反馈', 404)
    return row
  }
  async function detail(row: any, forAdmin: boolean) {
    const user = forAdmin ? (await store.user(row.user_id)) : null
    const comments = (await store.all('SELECT id,author,body,created_at FROM feedback_comments WHERE issue_id=? ORDER BY created_at,id', row.id))
      .map(c => ({ id: c.id, author: c.author, body: c.body, createdAt: c.created_at }))
    const attachments = (await store.all('SELECT id,name,mime,size FROM feedback_attachments WHERE issue_id=? ORDER BY created_at,id', row.id))
    return {
      ...summary({ ...row, comments: comments.length, attachments: attachments.length, user_name: user?.name, user_email: user?.email }, forAdmin),
      body: row.body, context: parse(row.context, {}), thread: comments, files: attachments,
    }
  }
  function decodeAttachments(list: unknown) {
    if (list == null) return []
    if (!Array.isArray(list)) throw failure('截图格式不正确', 422)
    if (list.length > MAX_ATTACHMENTS) throw failure(`最多附带 ${MAX_ATTACHMENTS} 张截图`, 422)
    return list.map((item: any, index) => {
      const mime = String(item?.mime || '')
      if (!IMAGE_MIME.test(mime)) throw failure('截图只支持 PNG、JPEG、WebP 或 GIF', 422)
      const bytes = Buffer.from(String(item?.data || ''), 'base64')
      if (!bytes.length) throw failure('截图内容为空', 422)
      if (bytes.length > MAX_ATTACHMENT_BYTES) throw failure('单张截图不能超过 4MB', 413)
      return { name: String(item?.name || `截图 ${index + 1}`).slice(0, 120), mime, bytes }
    })
  }

  return {
    // —— 用户 ——
    async listForUser(userId: string, status = 'all') {
      const filter = status === 'open' || status === 'closed' ? 'AND status=?' : ''
      const rows = (await store.all(`SELECT i.*,${counts} FROM feedback_issues i WHERE user_id=? ${filter} ORDER BY updated_at DESC LIMIT 200`, userId, ...(filter ? [status] : [])))
      return { items: rows.map(row => summary(row)), unread: rows.filter(row => row.user_unread > 0).length }
    },
    async unreadForUser(userId: string) {
      return Number((await store.get('SELECT COUNT(*) AS n FROM feedback_issues WHERE user_id=? AND user_unread>0', userId))?.n || 0)
    },
    async create(userId: string, payload: Record<string, any>) {
      const title = text(payload.title, MAX_TITLE, '标题')
      const body = text(payload.body, MAX_BODY, '问题描述')
      const category = FEEDBACK_CATEGORIES.includes(payload.category) ? payload.category : 'bug'
      const context = Object.fromEntries(['appVersion', 'platform', 'os', 'locale', 'project', 'canvas'].map(key => [key, String(payload.context?.[key] ?? '').slice(0, 200)]).filter(([, value]) => value))
      const files = decodeAttachments(payload.attachments)
      return (await store.transaction(async () => {
        await store.db.lockRow('users','id',userId)
        const recent = Number((await store.get("SELECT COUNT(*) AS n FROM feedback_issues WHERE user_id=? AND created_at>?", userId, new Date(Date.now() - 3600_000).toISOString()))?.n || 0)
        if (recent >= 10) throw failure('一小时内提交的反馈太多了，请稍后再试', 429)
        const id = randomUUID(), now = new Date().toISOString()
        // 删除最后一条反馈后也不复用已发出的编号；兼容旧进程仍按 MAX 分配的过渡期。
        await store.run('UPDATE feedback_number_sequence SET value=MAX(value,(SELECT COALESCE(MAX(number),0) FROM feedback_issues))+1 WHERE id=1')
        const number = Number((await store.get('SELECT value FROM feedback_number_sequence WHERE id=1')).value)
        await store.run('INSERT INTO feedback_issues(id,number,user_id,title,body,category,status,labels,context,user_unread,admin_unread,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', id, number, userId, title, body, category, 'open', '[]', JSON.stringify(context), 0, 1, now, now)
        for (const file of files) await store.run('INSERT INTO feedback_attachments VALUES(?,?,?,?,?,?,?)', randomUUID(), id, file.name, file.mime, file.bytes.length, file.bytes, now)
        await store.audit(userId, 'feedback.create', id, { number, category })
        return (await detail((await issueFor(id)), false))
      }))
    },
    async getForUser(userId: string, id: string) {
      const row = (await issueFor(id, userId))
      if (row.user_unread) await store.run('UPDATE feedback_issues SET user_unread=0 WHERE id=?', row.id)
      return (await detail({ ...row, user_unread: 0 }, false))
    },
    async deleteForUser(userId: string, id: string) {
      return (await store.transaction(async () => {
        const row = (await issueFor(id, userId))
        await store.run('UPDATE feedback_number_sequence SET value=MAX(value,?) WHERE id=1', row.number)
        // 显式删除子项，不依赖每个历史数据库连接均开启外键。
        await store.run('DELETE FROM feedback_attachments WHERE issue_id=?', row.id)
        await store.run('DELETE FROM feedback_comments WHERE issue_id=?', row.id)
        await store.run('DELETE FROM feedback_issues WHERE id=? AND user_id=?', row.id, userId)
        await store.audit(userId, 'feedback.delete', row.id, { number: row.number })
        return { ok: true }
      }))
    },
    async commentAsUser(userId: string, id: string, body: unknown) {
      const row = (await issueFor(id, userId)), content = text(body, MAX_COMMENT, '回复内容')
      const now = new Date().toISOString()
      await store.transaction(async () => {
        await store.run('INSERT INTO feedback_comments VALUES(?,?,?,?,?)', randomUUID(), row.id, 'user', content, now)
        await store.run('UPDATE feedback_issues SET admin_unread=admin_unread+1,updated_at=? WHERE id=?', now, row.id)
      })
      return (await detail((await issueFor(row.id)), false))
    },
    async setStatusAsUser(userId: string, id: string, status: unknown) {
      const row = (await issueFor(id, userId))
      if (status !== 'open' && status !== 'closed') throw failure('状态不正确', 422)
      const now = new Date().toISOString()
      await store.run('UPDATE feedback_issues SET status=?,closed_at=?,updated_at=?,admin_unread=admin_unread+? WHERE id=?', status, status === 'closed' ? now : null, now, status === 'open' && row.status === 'closed' ? 1 : 0, row.id)
      return (await detail((await issueFor(row.id)), false))
    },
    async attachment(id: string, attachmentId: string, userId?: string) {
      const row = (await issueFor(id, userId))
      const file = (await store.get('SELECT name,mime,size,bytes FROM feedback_attachments WHERE id=? AND issue_id=?', String(attachmentId || ''), row.id))
      if (!file) throw failure('没有找到这张截图', 404)
      return file
    },
    // —— 管理后台 ——
    async listForAdmin(query: Record<string, any> = {}) {
      const where: string[] = [], args: any[] = []
      if (query.status === 'open' || query.status === 'closed') { where.push('i.status=?'); args.push(query.status) }
      if (FEEDBACK_CATEGORIES.includes(query.category)) { where.push('i.category=?'); args.push(query.category) }
      if (query.unread === '1') where.push('i.admin_unread>0')
      const search = String(query.search || '').trim()
      if (search) {
        const number = /^#?(\d+)$/.exec(search)?.[1]
        where.push(`(i.title LIKE ? OR i.body LIKE ? OR u.email LIKE ? OR u.name LIKE ?${number ? ' OR i.number=?' : ''})`)
        args.push(...Array(4).fill(`%${search}%`), ...(number ? [Number(number)] : []))
      }
      const limit = Math.min(100, Math.max(1, Number(query.limit) || 30)), page = Math.max(1, Number(query.page) || 1)
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
      const total = Number((await store.get(`SELECT COUNT(*) AS n FROM feedback_issues i LEFT JOIN users u ON u.id=i.user_id ${clause}`, ...args))?.n || 0)
      const rows = (await store.all(`SELECT i.*,u.name AS user_name,u.email AS user_email,${counts} FROM feedback_issues i LEFT JOIN users u ON u.id=i.user_id ${clause} ORDER BY i.admin_unread>0 DESC,i.updated_at DESC LIMIT ? OFFSET ?`, ...args, limit, (page - 1) * limit))
      const stats = (await store.get("SELECT SUM(status='open') AS open,SUM(status='closed') AS closed,SUM(admin_unread>0) AS unread FROM feedback_issues")) || {}
      return { items: rows.map(row => summary(row, true)), total, page, limit, stats: { open: Number(stats.open || 0), closed: Number(stats.closed || 0), unread: Number(stats.unread || 0) } }
    },
    async getForAdmin(id: string) {
      const row = (await issueFor(id))
      if (row.admin_unread) await store.run('UPDATE feedback_issues SET admin_unread=0 WHERE id=?', row.id)
      return (await detail({ ...row, admin_unread: 0 }, true))
    },
    async commentAsAdmin(id: string, body: unknown, actor = '管理员') {
      const row = (await issueFor(id)), content = text(body, MAX_COMMENT, '回复内容')
      const now = new Date().toISOString()
      await store.transaction(async () => {
        await store.run('INSERT INTO feedback_comments VALUES(?,?,?,?,?)', randomUUID(), row.id, 'admin', content, now)
        await store.run('UPDATE feedback_issues SET user_unread=user_unread+1,admin_unread=0,updated_at=? WHERE id=?', now, row.id)
        await store.audit(actor, 'feedback.reply', row.id, { number: row.number })
      })
      return (await detail((await issueFor(row.id)), true))
    },
    async updateAsAdmin(id: string, patch: Record<string, any>, actor = '管理员') {
      const row = (await issueFor(id)), now = new Date().toISOString()
      const status = patch.status === 'open' || patch.status === 'closed' ? patch.status : row.status
      const labels = Array.isArray(patch.labels) ? [...new Set(patch.labels.filter((label: any) => FEEDBACK_LABELS.includes(label)))] : parse(row.labels, [])
      await store.run('UPDATE feedback_issues SET status=?,labels=?,closed_at=?,updated_at=?,user_unread=user_unread+? WHERE id=?', status, JSON.stringify(labels), status === 'closed' ? (row.closed_at || now) : null, now, status !== row.status ? 1 : 0, row.id)
      await store.audit(actor, 'feedback.update', row.id, { number: row.number, status, labels })
      return (await detail((await issueFor(row.id)), true))
    },
  }
}
