import { filterAsync, flatMapAsync, mapAsync } from '../server/async-collections.ts'
import { CloudDatabase } from '../server/cloud-database.ts'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { TrashBackups, type TrashBackupSource } from './trash-backups.ts'
const hash = value => createHash('sha256').update(value).digest('hex')
export class LocalStore {
  declare directory: any
  declare db: any
  declare projectScoped: boolean
  declare stateScoped: boolean
  declare activeAccount: string
  private trashBackups: TrashBackups

  async initialize(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.directory = directory
    this.trashBackups = new TrashBackups(directory)
    this.db = await CloudDatabase.open(join(directory, 'desktop.sqlite'), '')
    await this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY);
      INSERT OR IGNORE INTO users VALUES('local');
      CREATE TABLE IF NOT EXISTS projects(user_id TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,created_at TEXT NOT NULL,last_opened_at TEXT,PRIMARY KEY(user_id,id),UNIQUE(user_id,name));
      INSERT OR IGNORE INTO projects VALUES('local','default','项目',datetime('now'),NULL);
      CREATE TABLE IF NOT EXISTS workspace_files(user_id TEXT NOT NULL,project_id TEXT NOT NULL,path TEXT NOT NULL,mime TEXT NOT NULL,bytes BLOB,revision TEXT NOT NULL,updated_at TEXT NOT NULL,storage TEXT NOT NULL DEFAULT 'disk',size INTEGER NOT NULL DEFAULT 0,blob TEXT,PRIMARY KEY(user_id,project_id,path));
      CREATE TABLE IF NOT EXISTS workspace_state(user_id TEXT NOT NULL,project_id TEXT NOT NULL,workspace TEXT NOT NULL DEFAULT '{}',assets TEXT NOT NULL DEFAULT '[]',canvas_files TEXT NOT NULL DEFAULT '{}',updated_at TEXT,PRIMARY KEY(user_id,project_id));
      CREATE TABLE IF NOT EXISTS desktop_tasks(request_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,directory TEXT NOT NULL,kind TEXT NOT NULL,account TEXT NOT NULL,status TEXT NOT NULL,result TEXT,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS desktop_tasks_history ON desktop_tasks(project_id,account,created_at DESC);
      CREATE TABLE IF NOT EXISTS desktop_sync(project_id TEXT NOT NULL,account TEXT NOT NULL,sync_id TEXT NOT NULL,base TEXT NOT NULL DEFAULT '{}',PRIMARY KEY(project_id,account),UNIQUE(account,sync_id));
      CREATE TABLE IF NOT EXISTS desktop_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS desktop_trash(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,path TEXT NOT NULL,mime TEXT NOT NULL,bytes BLOB NOT NULL,deleted_at TEXT NOT NULL,account TEXT NOT NULL DEFAULT '');`)
    if (!(await this.all('PRAGMA table_info(desktop_trash)')).some(column => column.name === 'account')) await this.db.exec("ALTER TABLE desktop_trash ADD COLUMN account TEXT NOT NULL DEFAULT ''")
    if (!(await this.all('PRAGMA table_info(desktop_trash)')).some(column => column.name === 'disk_path')) await this.db.exec("ALTER TABLE desktop_trash ADD COLUMN disk_path TEXT")
    await this.db.exec('CREATE INDEX IF NOT EXISTS desktop_trash_disk_path ON desktop_trash(disk_path)')
    this.projectScoped = true
    this.stateScoped = true
    this.activeAccount = ''
    await this.run("UPDATE projects SET name='项目' WHERE user_id='local' AND id='default' AND name='本机项目' AND NOT EXISTS(SELECT 1 FROM projects WHERE user_id='local' AND id<>'default' AND name='项目')")
    if (!(await this.get("SELECT value FROM desktop_meta WHERE key='device'"))) await this.run('INSERT INTO desktop_meta VALUES(?,?)', 'device', randomUUID())
  }
  async get(sql, ...args) { return (await this.db.get(sql, ...args)) }
  async all(sql, ...args): Promise<any[]> { return (await this.db.all(sql, ...args)) }
  async run(sql, ...args) { return (await this.db.run(sql, ...args)) }
  async addTrash(project, path, mime, file: TrashBackupSource) {
    const id = randomUUID(), diskPath = this.trashBackups.path(id)
    try {
      return (await this.transaction(async () => {
        this.trashBackups.create(id, file)
        await this.run('INSERT INTO desktop_trash(id,project_id,path,mime,bytes,deleted_at,account,disk_path) VALUES(?,?,?,?,?,?,?,?)', id, project, path, mime, Buffer.alloc(0), new Date().toISOString(), (await this.get('SELECT account FROM desktop_sync WHERE project_id=?', project))?.account || '', diskPath)
        return diskPath
      }))
    } catch (error) { await this.cleanupTrashBackups([diskPath]); throw error }
  }
  // 老版本把删掉的文件悄悄备份在应用目录里，界面上看不到也不会清理。启动时把它们交给系统废纸篓，再删掉这些记录。
  async legacyTrash() { return (await this.all('SELECT id,project_id,path,mime,bytes,disk_path FROM desktop_trash ORDER BY deleted_at')) }
  async dropLegacyTrash(ids: readonly string[]) {
    const paths = (await this.transaction(async () => (await flatMapAsync(ids, async id => {
      const row = (await this.get('SELECT disk_path FROM desktop_trash WHERE id=?', id))
      await this.run('DELETE FROM desktop_trash WHERE id=?', id)
      return row?.disk_path ? [row.disk_path] : []
    }))))
    return paths.length ? (await this.cleanupTrashBackups(paths)) : { removed: 0, pending: 0, failed: 0 }
  }
  // 放进废纸篓的文件夹用项目名命名；账号项目的显示名在 desktop_sync 里，项目已删时退回到编号。
  async projectLabel(id: string) {
    const binding = (await this.get('SELECT base FROM desktop_sync WHERE project_id=?', id))
    const row = (await this.get("SELECT name FROM projects WHERE user_id='local' AND id=?", id))
    return (binding && JSON.parse(binding.base).name) || row?.name || '项目-' + String(id).slice(0, 8)
  }
  retainTrashBackup(id: string, diskPath: string) { return this.trashBackups.retain(id, diskPath) }
  async cleanupTrashBackups(paths?: readonly string[]) {
    return (await this.trashBackups.sweep({
      // Every account's live trash row protects its bytes, independently of the
      // account/project currently selected by the renderer.
      referenced: async path => Boolean((await this.get('SELECT 1 FROM desktop_trash WHERE disk_path=? LIMIT 1', path))),
      locked: async operation => (await this.transaction(operation)),
    }, paths))
  }

  async transaction(fn) { return (await this.db.transaction(fn)) }
  async project(id = 'default') {
    const binding = (await this.get('SELECT account,base FROM desktop_sync WHERE project_id=?', id))
    if (binding && (binding.account !== this.activeAccount || JSON.parse(binding.base).removed)) throw Object.assign(new Error('账号项目不存在'), { status: 404 })
    const row = (await this.get("SELECT * FROM projects WHERE user_id='local' AND id=?", id))
    if (!row) throw Object.assign(new Error('这个项目已经不在了，请回到首页重新选择项目'), { status: 404 })
    return { id: row.id, name: binding ? JSON.parse(binding.base).name || row.name : row.id === 'default' && row.name === '本机项目' ? '项目' : row.name, source: binding ? 'account' : 'local', createdAt: row.created_at, lastOpenedAt: row.last_opened_at }
  }
  async projects() {
    return (await filterAsync((await mapAsync((await this.all("SELECT id FROM projects WHERE user_id='local' AND (id NOT IN (SELECT project_id FROM desktop_sync) OR id IN (SELECT project_id FROM desktop_sync WHERE account=? AND COALESCE(json_extract(base,'$.removed'),0)=0)) ORDER BY created_at", this.activeAccount)), async row => (await this.project(row.id)))), async project => project.id !== 'default' || Boolean(
        (await this.get("SELECT 1 FROM workspace_files WHERE user_id='local' AND project_id='default' AND mime<>'inode/directory' AND lower(path)<>'settings/providers.json' LIMIT 1"))
        || (await this.get("SELECT 1 FROM workspace_state WHERE user_id='local' AND project_id='default' AND (workspace<>'{}' OR assets<>'[]' OR canvas_files<>'{}') LIMIT 1"))
      )))
  }
  async createProject(name, id: string = randomUUID()) {
    if (typeof name !== 'string' || !name.trim() || name.length > 40 || /[\x00-\x1f]/.test(name)) throw new Error('项目名称无效')
    await this.run('INSERT INTO projects VALUES(?,?,?,?,NULL)', 'local', id, name.trim(), new Date().toISOString())
    return (await this.project(id))
  }
  async ensureTrashProject(id: string, account: string) {
    return (await this.transaction(async () => {
      if (account && account !== this.activeAccount) throw Object.assign(new Error('账号已切换，回收站恢复已停止'), { status: 409 })
      const binding = (await this.get('SELECT account,base FROM desktop_sync WHERE project_id=?', id))
      const existing = (await this.get("SELECT id FROM projects WHERE user_id='local' AND id=?", id))
      if (binding && binding.account !== account || existing && account && !binding) {
        throw Object.assign(new Error('恢复项目的归属已变化，原文件和回收站记录已保留'), { status: 409 })
      }
      if (binding && JSON.parse(binding.base).removed) throw Object.assign(new Error('原账号项目已移除，回收站记录已保留'), { status: 409 })
      if (existing) return (await this.project(id))
      const prefix = '恢复项目-' + id.slice(0, 8)
      let name = prefix, suffix = 2
      while ((await this.get("SELECT 1 FROM projects p LEFT JOIN desktop_sync d ON d.project_id=p.id WHERE p.user_id='local' AND (p.name=? OR (d.account=? AND json_extract(d.base,'$.name')=?)) LIMIT 1", name, this.activeAccount, name))) name = `${prefix}-${suffix++}`
      // desktop_sync now carries only local ownership/display metadata. This
      // binding and the project must commit together; no cloud sync is started.
      if (account && !binding) await this.run('INSERT INTO desktop_sync(project_id,account,sync_id,base) VALUES(?,?,?,?)', id, account, randomUUID(), JSON.stringify({ name }))
      else if (binding) await this.run("UPDATE desktop_sync SET base=json_set(base,'$.name',?) WHERE project_id=? AND account=?", name, id, account)
      return (await this.createProject(name, id))
    }))
  }
  async renameProject(id, name) {
    await this.project(id)
    const duplicate = (await this.projects()).some(project => project.id !== id && project.name === name)
    if (duplicate) throw Object.assign(new Error('已有同名项目'), { status: 409 })
    // The legacy binding retains account ownership and the local display name.
    // Renaming this computer's copy must no longer rename the website project.
    const binding = (await this.get('SELECT account FROM desktop_sync WHERE project_id=?', id))
    if (binding) await this.run("UPDATE desktop_sync SET base=json_set(base,'$.name',?) WHERE project_id=? AND account=?", name, id, binding.account)
    else await this.run("UPDATE projects SET name=? WHERE user_id='local' AND id=?", name, id)
    return (await this.project(id))
  }
  async workspaceForUser(_user, project = 'default') {
    const row = (await this.get("SELECT * FROM workspace_state WHERE user_id='local' AND project_id=?", project))
    const workspace = row ? JSON.parse(row.workspace) : null
    return { workspace, assets: row ? JSON.parse(row.assets) : [], canvasFiles: {}, updatedAt: row?.updated_at || null, workspaceRevision: hash(JSON.stringify(workspace)) }
  }
  async close() { await this.db.close() }

  static async open<T extends new (...args: any[]) => any>(this: T, ...args: any[]): Promise<InstanceType<T>> {
    const value = new this()
    try { await value.initialize(...args); return value }
    catch (error) { await value.db?.close?.().catch(() => {}); throw error }
  }
}
