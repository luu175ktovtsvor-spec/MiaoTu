#!/usr/bin/env node
// 只回收无工作区/历史引用且过宽限期的 blob，不删除节点、历史或账本。
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { BlobStore } from './blob-store.ts'

const apply = process.argv.includes('--apply')
const db = new DatabaseSync(process.env.OIP_MANAGEMENT_DB || join(process.env.OIP_DATA_DIR || 'data', 'management.sqlite'), { readOnly: !apply })
db.exec('PRAGMA busy_timeout=5000')
const store = {
  get: (sql, ...args) => db.prepare(sql).get(...args),
  all: (sql, ...args) => db.prepare(sql).all(...args),
  transaction(fn) {
    db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); db.exec('COMMIT'); return result }
    catch (error) { db.exec('ROLLBACK'); throw error }
  },
}
try {
  // 快照候选，再取得与上传/结果写入共用的写锁重新确认引用和 mtime。
  const result = new BlobStore(store).sweep({ apply })
  console.log(JSON.stringify({ apply, candidates: result.candidates.length, reclaimable: result.reclaimable.length, fresh: result.fresh.length, removed: result.removed, removedBytes: result.removedBytes }))
} finally { db.close() }
