import electron from 'electron'
import { createDesktopFetch } from './network.ts'
import { createSaveBarrier } from './save-barrier.ts'
import { createWindowActions } from './window-actions.ts'
import { createSessionView } from './session-view.ts'
import { LocalMediaHost } from './local-media/host.ts'
import { LOCAL_MEDIA_SITES } from './local-media/catalog.ts'
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, mkdtempSync, createWriteStream, rmSync, chmodSync, accessSync, constants as fsConstants } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const root = dirname(fileURLToPath(import.meta.url))
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, session, clipboard } = electron
const packageConfig = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const credentialProtection = process.platform === 'darwin' ? packageConfig.macCredentialProtection : 'system'
// 更新源根地址：默认是官网的静态更新目录。MIAO_DESKTOP_UPDATE_FEED 只给本地验证用，
// 指向临时静态目录（例如 http://127.0.0.1:8000/），正式构建不设置它。
const updateFeedRoot = (process.env.MIAO_DESKTOP_UPDATE_FEED || 'https://miaoimg.cn/desktop-downloads/updates/').replace(/\/?$/, '/')
// 登录表单是内嵌网页，Chromium 会把它当普通登录页（自动填充候选、是否保存密码、
// macOS 上还会去读写系统钥匙串）。应用自己管会话与凭据（见 session-storage.ts，
// macOS 走 local-key、不碰钥匙串），所以这里按惯例关掉这套机制。
//
// ACT: 实测在当前 Electron 版本里这些特性名在 framework 二进制里根本不存在，这两行
// 大概率是空操作——用户看到的那个「输入时浮出的框」是原生校验气泡，真正的修复是
// DesktopBar 表单上的 noValidate 与启动时清掉分区里的自动填充数据。保留这两行是因为
// 换 Electron 版本后可能重新有意义，别把它们当成那个弹框的修复。
app.commandLine.appendSwitch('disable-features', 'PasswordManager,PasswordLeakDetection,AutofillServerCommunication,AutofillEnableAccountWalletStorage')
app.commandLine.appendSwitch('disable-save-password-bubble')
app.setName(app.isPackaged ? '妙图' : 'miaoimg-desktop-dev')
// Independent development profiles allow a preview beside the installed app.
// Set this before the instance lock or any persistent Electron session opens.
if (!app.isPackaged && process.env.MIAO_DESKTOP_USER_DATA_DIR) {
  const profile = resolve(process.env.MIAO_DESKTOP_USER_DATA_DIR)
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  app.setPath('userData', profile)
}
if (!app.requestSingleInstanceLock()) app.quit()
else {
  // 上面的开关只管新行为；Chromium 已经把自动填充/密码库写在这个持久化分区里了
  // （Web Data / Login Data），不删掉的话下次输入仍会拿旧数据弹候选框。
  // 只删自动填充与密码库这几项：Cookie、Local Storage、Session Storage 一概不动，
  // 本机会话也不在这里（在 workspace/cloud-session.enc + .key），不会把用户踢下线。
  function clearAutofillProfile() {
    const directory = join(app.getPath('userData'), 'Partitions', 'miao-desktop') // 对应 session.fromPartition('persist:miao-desktop')
    const stores = ['Web Data', 'Web Data-journal', 'Login Data', 'Login Data-journal', 'Login Data For Account', 'Login Data For Account-journal', 'AutofillStrikeDatabase']
    const removed = []
    for (const name of stores) {
      const target = join(directory, name)
      if (!existsSync(target)) continue
      try { rmSync(target, { recursive: true, force: true }); removed.push(name) } catch (error) { console.warn('桌面临时数据清理失败：' + name + '（' + error.message + '）') }
    }
    if (removed.length) console.log('已清理桌面分区内的自动填充与密码库：' + removed.join('、'))
    return removed
  }
  clearAutofillProfile()
  let window, runtime
  let saveBarrier: ReturnType<typeof createSaveBarrier> | undefined
  let windowActions: ReturnType<typeof createWindowActions> | undefined
  let sessionView: ReturnType<typeof createSessionView> | undefined
  const requestQuit = (quit = () => app.quit()): Promise<void> => windowActions ? windowActions.quit(quit) : Promise.resolve().then(quit)
  let updater = null
  let updatesDisabled = process.env.MIAO_DESKTOP_DISABLE_UPDATES === '1'
  const isMac = process.platform === 'darwin'
  const isWindows = process.platform === 'win32'
  // 渲染进程只拿状态和版本；错误原文、地址与路径留在主进程日志里。
  let updateStatus = { state: 'idle', version: null, percent: null }
  let updateUrl = isWindows ? new URL('miaoimg-desktop-windows.exe', updateFeedRoot).href : updateFeedRoot
  // macOS 自更新的目标与安装计划只在主进程里保存，页面拿不到地址和路径。
  let macUpdate = null
  let macInstallable = false
  function updateSnapshot() {
    // canInstall 只在“确实能自己装上”时为真：macOS 只有更新源带 zip 且应用目录可写才算。
    return { canCheck: !updatesDisabled, canInstall: isWindows || macInstallable, currentVersion: app.getVersion(), state: updateStatus.state, version: updateStatus.version, percent: updateStatus.percent }
  }
  function publishUpdateStatus(patch) {
    updateStatus = { ...updateStatus, ...patch }
    if (window && !window.isDestroyed()) window.webContents.send('desktop:update-status', updateSnapshot())
  }
  // 自动更新走不通时的兜底入口：只取当前架构的 dmg 或 zip，没有就给更新目录。
  function downloadPageUrl(files) {
    const matches = (file, extension) => typeof file.url === 'string' && file.url.split('?')[0].endsWith(`-${process.arch}.${extension}`)
    const candidate = files?.find(file => matches(file, 'dmg')) || files?.find(file => matches(file, 'zip'))
    return candidate?.url ? new URL(candidate.url, updateFeedRoot).href : updateFeedRoot
  }
  // ---- macOS 应用内自更新 ----
  // macOS 端没有 Apple Developer 签名，Squirrel.Mac（electron-updater 的 mac 路径）换不了应用，
  // 所以这里自己做一遍：读 latest-mac.yml → 下载 zip → 校验 sha512 → 退出后由脚本替换 .app 再启动。
  // 下载用 Node 网络栈落在用户临时目录，文件不带 com.apple.quarantine，替换也不需要管理员授权。
  function macFeedUrl() { return new URL('latest-mac.yml', updateFeedRoot).href }
  function scalar(value) { return String(value ?? '').trim().replace(/^['"]|['"]$/g, '') }
  // 只解析 latest-mac.yml 里真正用到的字段，不引入 YAML 依赖。
  function parseMacFeed(text) {
    const feed = { version: null, files: [] }
    let file = null
    for (const raw of String(text).split(/\r?\n/)) {
      if (!raw.trim() || raw.trim().startsWith('#')) continue
      const entry = raw.match(/^\s*-\s*url\s*:\s*(.+)$/)
      if (entry) { file = { url: scalar(entry[1]) }; feed.files.push(file); continue }
      const pair = raw.match(/^(\s*)([A-Za-z][\w-]*)\s*:\s*(.*)$/)
      if (!pair) { file = null; continue }
      const [, indent, key, value] = pair
      if (!indent) { if (key === 'version') feed.version = scalar(value); file = null; continue }
      if (!file) continue
      if (key === 'sha512') file.sha512 = scalar(value)
      else if (key === 'size') file.size = Number(scalar(value)) || null
    }
    return feed
  }
  function newerVersion(candidate, current) {
    const parts = value => String(value || '').split(/[-+]/)[0].split('.').map(part => parseInt(part, 10) || 0)
    const next = parts(candidate), now = parts(current)
    for (let index = 0; index < Math.max(next.length, now.length); index += 1) {
      const diff = (next[index] || 0) - (now[index] || 0)
      if (diff !== 0) return diff > 0
    }
    return false
  }
  // 自更新用 zip：替换 .app 最干净，dmg 只用于首次安装。没有 sha512 的条目一律不用。
  function pickMacAsset(feed) {
    const zips = (feed.files || []).filter(file => file.url && file.sha512 && /\.zip$/i.test(file.url.split('?')[0]))
    return zips.find(file => file.url.split('?')[0].endsWith(`-${process.arch}.zip`)) || null
  }
  // 只有“打包后的 .app、且应用本体可写”才能自我替换；dmg 里运行、开发态或只读位置一律回落下载页。
  // 当前替换脚本在父目录同卷暂存及改名；父目录不可写时只能使用下载页。
  function macInstallPlan() {
    if (!isMac || !app.isPackaged) return null
    const executable = app.getPath('exe')
    const boundary = executable.lastIndexOf('.app/Contents/MacOS/')
    if (boundary < 0) return null
    const bundle = executable.slice(0, boundary + '.app'.length)
    if (!existsSync(bundle) || bundle.includes('/AppTranslocation/') || bundle.startsWith('/Volumes/')) return null
    try {
      accessSync(bundle, fsConstants.W_OK)
      accessSync(join(bundle, 'Contents'), fsConstants.W_OK)
      accessSync(dirname(bundle), fsConstants.W_OK)
    } catch { return null }
    return { bundle, executable }
  }
  function fetchStream(url, redirectsLeft = 5) {
    return new Promise<any>((resolve, reject) => {
      const target = new URL(url)
      const request = (target.protocol === 'http:' ? httpGet : httpsGet)(target, { timeout: 30000 }, response => {
        const status = response.statusCode || 0
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume()
          if (redirectsLeft <= 0) return reject(new Error('更新源重定向过多'))
          return resolve(fetchStream(new URL(response.headers.location, target).href, redirectsLeft - 1))
        }
        if (status !== 200) { response.resume(); return reject(new Error('更新源返回状态 ' + status)) }
        resolve(response)
      })
      request.on('timeout', () => request.destroy(new Error('更新源连接超时')))
      request.on('error', reject)
    })
  }
  async function fetchText(url) {
    const response = await fetchStream(url)
    response.setTimeout(30000, () => response.destroy(new Error('更新源读取超时')))
    const chunks = []
    for await (const chunk of response) chunks.push(chunk)
    return Buffer.concat(chunks).toString('utf8')
  }
  async function checkMacUpdate() {
    publishUpdateStatus({ state: 'checking', version: null, percent: null })
    const feed = parseMacFeed(await fetchText(macFeedUrl()))
    if (!feed.version) throw new Error('更新源缺少版本号')
    updateUrl = downloadPageUrl(feed.files)
    if (!newerVersion(feed.version, app.getVersion())) {
      macUpdate = null; macInstallable = false
      publishUpdateStatus({ state: 'latest', version: null, percent: null })
      return
    }
    const asset = macInstallPlan() ? pickMacAsset(feed) : null
    macUpdate = asset ? { version: feed.version, url: new URL(asset.url, updateFeedRoot).href, sha512: asset.sha512, size: asset.size || null, file: null, directory: null } : null
    // 更新源只有 dmg、或应用目录不可写时仍然报“发现新版本”，只是把操作落到下载页，
    // 界面上不会出现点了没反应的按钮。
    macInstallable = !!macUpdate
    publishUpdateStatus({ state: 'available', version: feed.version, percent: null })
  }
  async function downloadMacUpdate() {
    if (!macUpdate) { publishUpdateStatus({ state: 'failed', percent: null }); return }
    const directory = mkdtempSync(join(app.getPath('temp'), 'miaoimg-update-'))
    const file = join(directory, 'update.zip')
    publishUpdateStatus({ state: 'downloading', percent: 0 })
    const hash = createHash('sha512')
    let received = 0, percent = 0
    try {
      const response = await fetchStream(macUpdate.url)
      response.setTimeout(60000, () => response.destroy(new Error('更新包下载超时')))
      const total = Number(response.headers['content-length']) || macUpdate.size || 0
      const meter = new Transform({
        transform(chunk, _encoding, done) {
          hash.update(chunk)
          received += chunk.length
          const next = total ? Math.max(0, Math.min(100, Math.round(received / total * 100))) : 0
          if (next !== percent) { percent = next; publishUpdateStatus({ state: 'downloading', percent: next }) }
          done(null, chunk)
        },
      })
      await pipeline(response, meter, createWriteStream(file, { mode: 0o600 }))
      // 用 yml 里的 base64 sha512 校验；对不上就删掉，绝不拿它替换应用。
      if (hash.digest('base64') !== macUpdate.sha512) throw new Error('更新包校验不通过')
      macUpdate.file = file
      macUpdate.directory = directory
      publishUpdateStatus({ state: 'ready', version: macUpdate.version, percent: 100 })
    } catch (error) {
      rmSync(directory, { recursive: true, force: true })
      macUpdate.file = null; macUpdate.directory = null
      throw error
    }
  }
  // 一次性替换脚本：等本进程退出 → ditto 解压 → 换掉 .app → 确认新版本真的起来了 → 重启。
  // 换包失败或新版本起不来时把上一版换回去：宁可退回旧版，也不能让用户新版打不开、旧版也没了。
  // 路径含空格与中文，一律单引号；保持 /bin/sh 兼容（macOS 上是 bash 3.2），不用花哨语法。
  function macReplaceScript({ pid, bundle, previous, zip, work, log }: Record<string, any>) {
    const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`
    const target = quote(bundle)
    return `#!/bin/sh
# 妙图应用内自更新（应用生成，用完连同临时目录一起丢弃）
exec >> ${quote(log)} 2>&1
echo "[miaoimg-update] $(date) waiting for pid ${pid}"
while kill -0 ${pid} 2>/dev/null; do sleep 1; done

WORK=${quote(work)}
TARGET=${target}
STAGED=${target}.new
BACKUP=${target}.previous-${previous}
# 无论从哪条分支退出，都不在临时目录里留解压残留。
trap 'rm -rf "$WORK"' 0

restore_previous() {
  echo "[miaoimg-update] rolling back to the previous app"
  rm -rf "$TARGET"
  if mv "$BACKUP" "$TARGET"; then
    xattr -cr "$TARGET"
    if open "$TARGET"; then
      echo "[miaoimg-update] previous app restored and started"
    else
      echo "[miaoimg-update] opening the previous app failed"
    fi
  else
    echo "[miaoimg-update] rollback failed, previous app kept at $BACKUP"
  fi
  exit 1
}

rm -rf "$WORK"
mkdir -p "$WORK"
if ! ditto -x -k ${quote(zip)} "$WORK"; then
  echo "[miaoimg-update] unzip failed"
  exit 1
fi
SOURCE=""
for candidate in "$WORK"/*.app; do
  if [ -d "$candidate" ]; then SOURCE="$candidate"; break; fi
done
if [ -z "$SOURCE" ]; then
  echo "[miaoimg-update] no .app inside archive"
  exit 1
fi

# 先把新版本挪到目标目录里（同卷改名），再动旧的，中间不留跨卷半成品。
rm -rf "$STAGED"
if ! mv "$SOURCE" "$STAGED"; then
  echo "[miaoimg-update] cannot stage the new app"
  rm -rf "$STAGED"
  exit 1
fi
xattr -cr "$STAGED"

rm -rf "$BACKUP"
if ! mv "$TARGET" "$BACKUP"; then
  echo "[miaoimg-update] cannot move the current app aside"
  rm -rf "$STAGED"
  exit 1
fi
if ! mv "$STAGED" "$TARGET"; then
  echo "[miaoimg-update] cannot put the new app in place"
  rm -rf "$STAGED"
  mv "$BACKUP" "$TARGET"
  exit 1
fi
xattr -cr "$TARGET"

if ! open "$TARGET"; then
  echo "[miaoimg-update] open failed"
  restore_previous
fi
# open 是异步的：先等一会儿再看，新版本那时还在运行才算真的起来了。
# 起不来的应用会立刻退出，所以必须等过这段窗口再判断，不能 open 完就查。
sleep 6
if ! pgrep -f "$TARGET/Contents/MacOS/" >/dev/null 2>&1; then
  sleep 3
fi
if pgrep -f "$TARGET/Contents/MacOS/" >/dev/null 2>&1; then
  echo "[miaoimg-update] new version is running, removing the backup"
  rm -rf "$BACKUP"
  echo "[miaoimg-update] done"
  exit 0
fi
echo "[miaoimg-update] the new version did not start"
restore_previous
`
  }
  function installMacUpdate() {
    const plan = macInstallPlan()
    if (!macUpdate?.file || !plan) {
      // 目录不再可写（或根本不是可替换的 .app）时退回下载页，不静默失败。
      macInstallable = false
      publishUpdateStatus({ state: macUpdate ? 'available' : 'failed', version: macUpdate?.version || null, percent: null })
      if (macUpdate) openUpdatePage()
      return
    }
    const script = join(macUpdate.directory, 'replace.sh')
    // 备份名带上上一版版本号，回滚后也能看出这份是哪个版本。
    const previous = app.getVersion().replace(/[^0-9A-Za-z._-]/g, '') || 'previous'
    writeFileSync(script, macReplaceScript({ pid: process.pid, bundle: plan.bundle, previous, zip: macUpdate.file, work: join(macUpdate.directory, 'unpacked'), log: join(macUpdate.directory, 'replace.log') }), { mode: 0o700 })
    chmodSync(script, 0o700)
    // 脱离父进程：主进程马上退出，脚本继续等它结束、替换、重启。
    return requestQuit(() => {
      spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }).unref()
      app.quit()
    })
  }
  async function ensureUpdater() {
    if (updater) return updater
    const module = await import('electron-updater')
    const instance = module.autoUpdater || module.default?.autoUpdater
    if (!instance) return null
    // Windows 启动即自动下载，下载完成后由用户决定何时重启。
    instance.autoDownload = true
    instance.autoInstallOnAppQuit = false
    instance.on('checking-for-update', () => publishUpdateStatus({ state: 'checking', version: null, percent: null }))
    instance.on('update-not-available', () => publishUpdateStatus({ state: 'latest', version: null, percent: null }))
    instance.on('update-available', info => publishUpdateStatus({ state: 'available', version: info?.version || null, percent: null }))
    instance.on('download-progress', progress => {
      const percent = Math.round(progress?.percent || 0)
      publishUpdateStatus({ state: 'downloading', percent: Math.max(0, Math.min(100, percent)) })
    })
    instance.on('update-downloaded', info => {
      publishUpdateStatus({ state: 'ready', version: info?.version || null, percent: 100 })
      if (!isWindows || !window || window.isDestroyed()) return
      dialog.showMessageBox(window, {
        type: 'info',
        buttons: ['立即重启更新', '稍后'],
        defaultId: 0,
        cancelId: 1,
        title: '更新已下载',
        message: `妙图 ${info.version} 已下载完成`,
        detail: '重启应用后完成更新。',
      }).then(result => { if (result.response === 0) return requestQuit(() => instance.quitAndInstall()) }).catch(() => {})
    })
    instance.on('error', error => {
      console.warn('妙图更新检查失败：' + (error?.message || error))
      publishUpdateStatus({ state: 'failed', percent: null })
    })
    updater = instance
    return updater
  }
  // 更新模块本身不可用时才关掉入口；检查失败只算一次失败，用户仍可重试。
  // 只给 Windows 用：macOS 的自更新不依赖 electron-updater。
  async function usableUpdater() {
    try { return await ensureUpdater() }
    catch (error) { console.warn('妙图更新模块不可用：' + (error?.message || error)); return null }
  }
  async function setupAutoUpdates() {
    if (!app.isPackaged || updatesDisabled) return
    if (isMac) {
      try { await checkMacUpdate() }
      catch (error) { console.warn('妙图更新检查失败：' + (error?.message || error)); publishUpdateStatus({ state: 'failed', percent: null }) }
      return
    }
    const instance = await usableUpdater()
    if (!instance) { updatesDisabled = true; publishUpdateStatus({ state: 'idle' }); return }
    try { await instance.checkForUpdates() }
    catch (error) { console.warn('妙图更新检查失败：' + (error?.message || error)); publishUpdateStatus({ state: 'failed', percent: null }) }
  }
  // 设置里的手动检查：开发态直接给出可操作提示，不抛内部异常。
  async function checkForUpdates() {
    if (!app.isPackaged) { publishUpdateStatus({ state: 'dev', version: null, percent: null }); return updateSnapshot() }
    if (updatesDisabled) return updateSnapshot()
    if (isMac) {
      try { await checkMacUpdate() }
      catch (error) { console.warn('妙图更新检查失败：' + (error?.message || error)); publishUpdateStatus({ state: 'failed', percent: null }) }
      return updateSnapshot()
    }
    const instance = await usableUpdater()
    if (!instance) { updatesDisabled = true; publishUpdateStatus({ state: 'idle' }); return updateSnapshot() }
    try {
      publishUpdateStatus({ state: 'checking', version: null, percent: null })
      await instance.checkForUpdates()
    } catch (error) {
      console.warn('妙图更新检查失败：' + (error?.message || error))
      publishUpdateStatus({ state: 'failed', percent: null })
    }
    return updateSnapshot()
  }
  async function downloadUpdate() {
    if (!app.isPackaged) return updateSnapshot()
    if (isMac) {
      try { await downloadMacUpdate() }
      catch (error) { console.warn('妙图更新下载失败：' + (error?.message || error)); publishUpdateStatus({ state: 'failed', percent: null }) }
      return updateSnapshot()
    }
    const instance = await usableUpdater()
    if (!instance) { publishUpdateStatus({ state: 'failed', percent: null }); return updateSnapshot() }
    try {
      publishUpdateStatus({ state: 'downloading', percent: 0 })
      // 已经在自动下载时复用同一次下载，不会重复下载同一个安装包。
      await instance.downloadUpdate()
    } catch (error) {
      console.warn('妙图更新下载失败：' + (error?.message || error))
      publishUpdateStatus({ state: 'failed', percent: null })
    }
    return updateSnapshot()
  }
  function quitAndInstall() {
    if (isMac) return installMacUpdate()
    if (!updater || !isWindows) return
    return requestQuit(() => updater.quitAndInstall())
  }
  function openUpdatePage() { shell.openExternal(updateUrl).catch(() => {}) }
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus() } })
  app.whenReady().then(async () => {
  app.on('child-process-gone', (_event, details) => console.error('应用子进程退出：' + JSON.stringify({ name: details.name, reason: details.reason, exitCode: details.exitCode })))
  const standardWorkspace = join(app.getPath('userData'), 'workspace')
  const directory = resolve(process.env.MIAO_DESKTOP_DATA_DIR || standardWorkspace)
  const isolatedProfile = Boolean(app.commandLine.getSwitchValue('user-data-dir') || (!app.isPackaged && process.env.MIAO_DESKTOP_USER_DATA_DIR))
  const isolatedWorkspace = Boolean(process.env.MIAO_DESKTOP_DATA_DIR && directory !== resolve(standardWorkspace))
  const toolsRoot = join(directory, 'tools', process.platform + '-' + process.arch, 'b6.1.1')
  const ffmpegPath = join(toolsRoot, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  const ffprobePath = join(toolsRoot, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  process.env.PI_OFFLINE = '1'
  process.env.PI_CODING_AGENT_DIR = join(directory, 'agent-runtime')
  process.env.OIP_DATA_DIR = directory
  process.env.OIP_MEDIA_ROOT = join(directory, 'projects')
  process.env.OIP_FFMPEG_PATH = ffmpegPath
  process.env.OIP_FFPROBE_PATH = ffprobePath
  process.env.PATH = toolsRoot + (process.platform === 'win32' ? ';' : ':') + process.env.PATH
  // 数据目录在用户空间，更新/重装应用不会替换它。
  const boundsFile = join(directory, 'window.json')
  let bounds = { width: 1440, height: 960 }
  if (existsSync(boundsFile)) try { bounds = { ...bounds, ...JSON.parse(readFileSync(boundsFile, 'utf8')) } } catch {}
  try {
    const { startDesktopRuntime } = await import('./runtime.ts')
    const previewArchiveOrigin = !app.isPackaged && /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.MIAO_DESKTOP_PREVIEW_ARCHIVE_ORIGIN || '') ? process.env.MIAO_DESKTOP_PREVIEW_ARCHIVE_ORIGIN : ''
    runtime = await startDesktopRuntime({ directory, credentialProtection, getSafeStorage: () => electron.safeStorage, webRoot: join(root, '../web'), origin: process.env.MIAO_CLOUD_ORIGIN || 'https://miaoimg.cn', previewArchiveOrigin, requestFetch: createDesktopFetch(session.fromPartition('miao-cloud'), electron.net.request), native: {
      localMediaHosts: Object.fromEntries(LOCAL_MEDIA_SITES.map(site => [site.id, new LocalMediaHost(electron, site)])),
      changeSession: async (commit: () => void) => {
        if (windowActions && sessionView) return windowActions.changeSession(commit, () => sessionView.wait())
        commit()
      },
      reveal: path => shell.showItemInFolder(path),
      save: async (path, name) => { const result = await dialog.showSaveDialog(window, { defaultPath: join(app.getPath('downloads'), name) }); if (result.canceled || !result.filePath) return false; await copyFile(path, result.filePath, fsConstants.COPYFILE_FICLONE); return true },
    } })
    const profile = session.fromPartition('persist:miao-desktop')
    // 本机会话只存在于这个应用的网络层，不必等磁盘 Cookie 服务初始化。
    profile.webRequest.onBeforeSendHeaders({ urls: [runtime.address + '/*'] }, (details, done) => {
      done({ requestHeaders: { ...details.requestHeaders, Cookie: 'miao_desktop=' + runtime.token } })
    })
    // 仅主工作台可锁定鼠标；取景不需要摄像头或系统文件权限。
    const allowPointerLock = (web, permission, url, isMainFrame) => {
      if (permission !== 'pointerLock' || !window || window.isDestroyed() || web !== window.webContents || isMainFrame === false) return false
      try { return new URL(url).origin === runtime.address && new URL(web.getURL()).origin === runtime.address } catch { return false }
    }
    profile.setPermissionCheckHandler((web, permission, origin, details) => allowPointerLock(web, permission, details.requestingUrl || origin, details.isMainFrame))
    profile.setPermissionRequestHandler((web, permission, done, details) => done(allowPointerLock(web, permission, details.requestingUrl, details.isMainFrame)))
    const icon = join(root, '../web/miaoimg-logo.png')
    window = new BrowserWindow({ ...bounds, minWidth: 900, minHeight: 600, title: '妙图', icon, backgroundColor: '#111114', titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 20 }, show: false,
      webPreferences: { preload: join(root, 'preload.cjs'), partition: 'persist:miao-desktop', nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
    })
    saveBarrier = createSaveBarrier(window.webContents)
    sessionView = createSessionView(window.webContents)
    window.webContents.once('destroyed', () => sessionView?.dispose())
    windowActions = createWindowActions({ window, save: saveBarrier, stop: () => runtime.stop(), quit: () => app.quit(),
      onSaveError: error => {
        console.warn('妙图页面保存未完成：' + ((error as any)?.code || (error as any)?.status || 'unknown'))
        dialog.showErrorBox('工作区尚未保存，已取消操作', (error as any)?.code === 'WORKSPACE_UNRESPONSIVE'
          ? '工作区页面暂无响应，请等待恢复后再保存。'
          : (error as any)?.code === 'WORKSPACE_SAVE_TIMEOUT'
            ? '保存等待超时，已取消退出。当前窗口仍可继续使用，请确认画布保存状态后重试。'
          : '请查看当前画布或文档的保存状态，保存完成后重试。')
      },
      onReloadError: () => dialog.showErrorBox('工作区重新加载未完成', '请检查当前工作区的状态后重试。'),
      onStopError: error => console.error('妙图退出清理失败：' + String((error as any)?.message || error)),
    })
    window.webContents.on('did-frame-navigate', (_event, _url, _code, _status, isMainFrame) => { if (isMainFrame) runtime.renderer.committed() })
    window.webContents.on('render-process-gone', () => runtime.renderer.retire())
    window.webContents.on('destroyed', () => runtime.renderer.retire())
    if (previewArchiveOrigin) window.on('page-title-updated', (event, title) => { event.preventDefault(); window.setTitle(`妙图预览 · ${title}`) })
    function openExternal(url) {
      const parsed = new URL(url)
      if (!['https:', 'http:'].includes(parsed.protocol)) return
      void shell.openExternal(parsed.href)
    }
    window.webContents.setWindowOpenHandler(({ url }: Record<string, any>) => {
      if (new URL(url).origin === runtime.address) {
        const media = new BrowserWindow({ parent: window, title: '妙图 · 预览', width: 1080, height: 760, backgroundColor: '#111114', webPreferences: { partition: 'persist:miao-desktop', nodeIntegration: false, contextIsolation: true, sandbox: true } })
        media.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        media.webContents.on('will-navigate', (event, target) => { if (new URL(target).origin !== runtime.address) event.preventDefault() })
        media.loadURL(url); return { action: 'deny' }
      }
      openExternal(url); return { action: 'deny' }
    })
    window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== runtime.address) { event.preventDefault(); openExternal(url) } })
    // 只接受本机工作台页面发来的调用，其它来源一律拒绝。
    const fromWorkbench = fn => (event, ...args) => { if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || new URL(event.senderFrame.url).origin !== runtime.address) throw new Error('调用来源无效'); return fn(...args) }
    ipcMain.handle('desktop:document-epoch', fromWorkbench(() => runtime.renderer.epoch()))
    ipcMain.handle('desktop:save-ready', fromWorkbench(() => saveBarrier.ready()))
    ipcMain.handle('desktop:save-complete', fromWorkbench((id, ok, error) => saveBarrier.complete(id, ok, error)))
    ipcMain.handle('desktop:session-complete', fromWorkbench(id => sessionView.complete(id)))
    ipcMain.handle('desktop:reload', fromWorkbench(() => windowActions.reload()))
    for (const [name, fn] of Object.entries({ minimize: () => window.minimize(), maximize: () => window.isMaximized() ? window.unmaximize() : window.maximize(), close: () => window.close(), 'open-data': () => shell.openPath(directory) })) ipcMain.handle('desktop:' + name, fromWorkbench(fn))
    ipcMain.handle('desktop:computer-permissions', fromWorkbench(async () => {
      if (process.platform === 'darwin') await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles')
    }))
    for (const [name, fn] of Object.entries({ 'update-status': updateSnapshot, 'update-check': checkForUpdates, 'update-download': downloadUpdate, 'update-install': quitAndInstall, 'update-page': openUpdatePage })) ipcMain.handle('desktop:' + name, fromWorkbench(fn))
    ipcMain.handle('desktop:clipboard-text', fromWorkbench(() => clipboard.readText()))
    ipcMain.handle('desktop:clipboard-write-text', fromWorkbench(text => { if (typeof text !== 'string' || text.length > 10 * 1024 * 1024) throw new Error('剪贴板内容过大'); return clipboard.writeText(text) }))
    ipcMain.handle('desktop:clipboard-media', fromWorkbench(async () => {
      for (const item of await clipboard.read()) {
        const type = item.types.includes('image/png') ? 'image/png' : item.types.find(type => ['image/jpeg', 'image/webp', 'image/gif'].includes(type))
        if (!type) continue
        const blob = await item.getType(type)
        if (!('arrayBuffer' in blob)) continue
        if (blob.size > 100 * 1024 * 1024) throw new Error('图片过大')
        const bytes = Buffer.from(await blob.arrayBuffer())
        return [{ name: 'pasted-image.' + type.split('/')[1], type, data: bytes.toString('base64') }]
      }
      return []
    }))
    let computerConsent = null
    ipcMain.handle('desktop:computer-status', fromWorkbench(() => runtime.computer.status(true)))
    ipcMain.handle('desktop:computer-disable', fromWorkbench(() => runtime.computer.revoke()))
    ipcMain.handle('desktop:computer-enable', fromWorkbench(async () => {
      if (computerConsent) return computerConsent
      computerConsent = (async () => {
        const account = runtime.cloud.account
        if (!account) throw new Error('请先登录。')
        if (runtime.computer.status().enabled) return runtime.computer.status()
        const result = await dialog.showMessageBox(window, { type: 'question', title: '开启本机操作', message: '允许 Agent 帮你操作这台电脑？', detail: '开启后，当前账号的 Agent 可以按你的要求读取、创建和修改这台电脑上的文件，运行命令，并使用已安装的软件。任务需要的文件内容会发送给模型处理。授权持续有效，可随时在“设置 → 本机操作”关闭。访问范围受系统权限限制。', buttons: ['暂不开启', '允许并开启'], defaultId: 0, cancelId: 0, noLink: true })
        return result.response === 1 ? runtime.computer.grant(account) : runtime.computer.status()
      })()
      try { return await computerConsent } finally { computerConsent = null }
    }))
    ipcMain.handle('desktop:computer-directory', fromWorkbench(async () => {
      const account = runtime.cloud.account
      if (!account) throw new Error('请先登录。')
      const result = await dialog.showOpenDialog(window, { title: '选择默认工作文件夹', defaultPath: runtime.computer.status().directory, properties: ['openDirectory'] })
      return result.canceled ? runtime.computer.status() : runtime.computer.setDirectory(result.filePaths[0], account)
    }))
    // Keep Electron's current label/accelerator, replacing only the direct
    // reload action. Passing click alongside a role would be ignored.
    const reloadDefaults = new electron.MenuItem({ role: 'reload' })
    const reloadItem = { label: reloadDefaults.label, accelerator: reloadDefaults.accelerator,
      click: (_item, focused) => {
        const target = focused ? BrowserWindow.fromId(focused.id) : undefined
        if (target === window) void windowActions.reload()
        else target?.webContents.reload()
      },
    } satisfies Electron.MenuItemConstructorOptions
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ label: '妙图', submenu: [{ role: 'about' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'quit' }] } satisfies Electron.MenuItemConstructorOptions] : []),
      { label: '文件', submenu: [{ label: '打开项目文件夹', click: () => shell.openPath(directory) }] },
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '视图', submenu: [reloadItem, { role: 'togglefullscreen' }] },
    ]))
    window.on('close', event => {
      writeFileSync(boundsFile, JSON.stringify(window.getNormalBounds()), { mode: 0o600 })
      if (!windowActions.quitting) { event.preventDefault(); void requestQuit() }
    })
    window.once('ready-to-show', () => window.show())
    await window.loadURL(runtime.address + (!app.isPackaged && process.env.MIAO_DESKTOP_PREVIEW_LIBRARY === '1' ? '/?library=1' : ''))
    window.show()
    setupAutoUpdates()
    if (process.env.MIAO_DESKTOP_CAPTURE) {
      setTimeout(async () => { try { writeFileSync(process.env.MIAO_DESKTOP_CAPTURE, (await window.webContents.capturePage()).toPNG()) } catch {} }, 10000)
    }
    // 开发验收只输出本机地址；认证值与云端凭据不写日志。
    console.log('妙图：' + runtime.address)
  } catch (error) {
    console.error('妙图启动失败：' + error.message)
    dialog.showErrorBox('妙图启动失败', error.message)
    try { await runtime?.stop() } catch { console.error('妙图启动清理未能完成') }
    app.quit()
    return
  }
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', event => {
    if (!windowActions || windowActions.quitting || !runtime) return
    event.preventDefault()
    void requestQuit()
  })
  })
}
