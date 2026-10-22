// Release acceptance using the installed application's real update bridge.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, createWriteStream } from 'node:fs'
import { resolve, join } from 'node:path'
const [exe, outputArg, expected] = process.argv.slice(2)
if (!exe || !outputArg || !expected) throw new Error('Usage: accept-update.ts <installed executable> <isolated output> <expected version>')
const output = resolve(outputArg); mkdirSync(output, { recursive: true })
const report: Record<string, any> = { platform: process.platform, expected, startedAt: new Date().toISOString() }
const save = () => writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2))
const delay = ms => new Promise <void>(resolve => setTimeout(resolve, ms))
const log = createWriteStream(join(output, 'app.log'))
const child = spawn(exe, ['--remote-debugging-port=9337', '--user-data-dir=' + join(output, 'profile')], { env: { ...process.env, MIAO_DESKTOP_DATA_DIR: join(output, 'workspace'), MIAO_DESKTOP_DISABLE_UPDATES: '0', MIAO_DESKTOP_NO_GENERATION: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.pipe(log); child.stderr.pipe(log)
let ws, serial = 0; const pending = new Map()
function command(method, params: Record<string, any> = {}) { return new Promise<any>((resolve, reject) => { const id = ++serial; const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, 180000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params })) }) }
async function evaluate(expression) { const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result?.value }
try {
  let target
  for (let i = 0; i < 180; i++) { try { target = (await (await fetch('http://127.0.0.1:9337/json/list', { signal: AbortSignal.timeout(1500) })).json()).find(t => t.type === 'page' && /^http:\/\/127.0.0.1:/.test(t.url)); if (target) break } catch {} await delay(500) }
  if (!target) throw new Error('Installed application did not open')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise <void>((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }) })
  ws.addEventListener('message', event => { const value = JSON.parse(event.data), job = pending.get(value.id); if (!job) return; clearTimeout(job.timer); pending.delete(value.id); value.error ? job.reject(new Error(value.error.message)) : job.resolve(value.result) })
  for (let i = 0; i < 180; i++) {
    if (await evaluate(`location.protocol === 'http:' && document.readyState !== 'loading' && !!window.miaoDesktop`)) break
    if (i === 179) throw new Error('Installed document did not finish loading')
    await delay(500)
  }
  report.before = await evaluate('window.miaoDesktop.updateStatus()'); save()
  if (report.before.currentVersion === expected) throw new Error('Acceptance must start from an older installed version')
  await evaluate('window.miaoDesktop.checkForUpdates()')
  const until = Date.now() + 180000
  while (Date.now() < until) {
    report.after = await evaluate('window.miaoDesktop.updateStatus()'); save()
    if (report.after.state === 'failed') throw new Error('Installed updater reported failure')
    if (report.after.version === expected && ['available', 'downloading', 'ready'].includes(report.after.state)) break
    await delay(500)
  }
  if (report.after.version !== expected || !report.after.canCheck || !report.after.canInstall) throw new Error('Expected installable update was not discovered')
  report.ok = true
} catch (error) { report.ok = false; report.error = error.message; process.exitCode = 1 }
finally {
  if (ws?.readyState === 1) { ws.close() }
  for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new Error('Acceptance ended')) } pending.clear()
  if (child.exitCode === null) child.kill()
  report.finishedAt = new Date().toISOString(); save(); console.log(JSON.stringify(report))
}
