// Release acceptance with the existing authorized account and an isolated profile.
// Credentials come from the runner environment and never enter reports or packages.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, createWriteStream } from 'node:fs'
import { join, resolve } from 'node:path'
const [exe, outputArg, ...appArgs] = process.argv.slice(2)
if (!exe || !outputArg) throw new Error('Usage: node accept-login.ts <app executable> <isolated output directory> [app arguments]')
const output = resolve(outputArg); mkdirSync(output, { recursive: true })
const account = { email: process.env.MIAO_ACCEPT_EMAIL || '', password: process.env.MIAO_ACCEPT_PASSWORD || '' }
if (!account.email || !account.password) throw new Error('Existing authorized acceptance credentials are required')
const report: Record<string, any> = { platform: process.platform, startedAt: new Date().toISOString(), checks: [] }
const save = () => writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2))
save()
const delay = ms => new Promise <void>(r => setTimeout(r, ms))
let child, ws, pending = new Map(), serial = 0
async function wait(check, label, timeout = 45000) { const until = Date.now() + timeout; while (Date.now() < until) { if (await check()) return; await delay(150) } throw new Error('Timed out: ' + label) }
function command(method, params: Record<string, any> = {}, timeout = 20000) { const id = ++serial; return new Promise<any>((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, timeout); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params })) }) }
async function evaluate(expression, timeout = 20000) { const r = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeout); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value }
async function start(extra = []) {
  const log = createWriteStream(join(output, 'app.log'), { flags: 'a', mode: 0o600 })
  child = spawn(exe, [...appArgs, '--remote-debugging-port=9337', '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + join(output, 'profile'), ...extra], { env: { ...process.env, MIAO_DESKTOP_USER_DATA_DIR: join(output, 'profile'), MIAO_DESKTOP_DATA_DIR: join(output, 'workspace'), MIAO_DESKTOP_DISABLE_UPDATES: '1', MIAO_DESKTOP_DISABLE_SYNC: '1', MIAO_DESKTOP_NO_GENERATION: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(log); child.stderr.pipe(log)
  let target
  await wait(async () => { try { const list = await (await fetch('http://127.0.0.1:9337/json/list')).json(); target = list.find(t => t.type === 'page' && /^http:\/\/127.0.0.1:/.test(t.url)); return !!target } catch { return false } }, 'app window')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise <void>((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }) })
  ws.addEventListener('message', event => { const data = JSON.parse(event.data); const job = pending.get(data.id); if (!job) return; pending.delete(data.id); clearTimeout(job.timer); data.error ? job.reject(new Error(data.error.message)) : job.resolve(data.result) })
  ws.addEventListener('close', event => { if (event.target !== ws) return; for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new Error('Application closed')) } pending.clear() })
  await command('Page.enable'); await command('Runtime.enable')
  await command('Page.bringToFront')
  // The target advertises its destination before the initial document commits,
  // especially on Windows. Wait for the real document before using relative URLs.
  await wait(() => evaluate(`location.protocol === 'http:' && document.readyState !== 'loading' && !!window.miaoDesktop`), 'committed desktop document', 90000)
  if (!report.desktopEntry) {
    const html = await evaluate(`fetch('/').then(r => r.text())`)
    if (html.includes('landing-shell') || !html.includes('desktop-boot')) throw new Error('Desktop entry contains the website landing shell')
    // Hold scripts to observe the actual first paint on a slow startup.
    await command('Network.enable')
    await command('Network.setBlockedURLs', { urls: ['*.js'] })
    await reloadPage()
    await wait(() => exists('.desktop-boot'), 'desktop startup screen')
    await capture('startup')
    await command('Network.setBlockedURLs', { urls: [] })
    await reloadPage()
    report.desktopEntry = 'Dedicated loading screen; no landing-page HTML'
    save()
  }
}
async function reloadPage() {
  // A blocked-JS reload can take longer than the default CDP command timeout on
  // Windows. The following wait observes the real document state, so a timed-out
  // reload command is not fatal by itself.
  try { await command('Page.reload', { ignoreCache: true }, 60000) }
  catch (error) { if (!String(error?.message).includes('CDP timeout: Page.reload')) throw error }
}
async function click(selector) { let point; await wait(async () => { point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return null;const r=e.getBoundingClientRect();if(!r.width||!r.height||getComputedStyle(e).visibility==='hidden')return null;return {x:r.x+r.width/2,y:r.y+r.height/2}})()`); return !!point }, 'enabled control: ' + selector); await command('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }); await command('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }) }
async function fill(selector, value) { await click(selector); await evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`); await command('Input.insertText', { text: value }) }
const exists = selector => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)
async function canvas() { await wait(async () => !(await exists('#desktop-account-email')) && await evaluate(`[...document.querySelectorAll('.studio-top button')].some(b => (b.innerText||'').trim() === '账号')`), 'authenticated canvas', 60000); if (await exists('.release-notes-close')) { await evaluate(`document.querySelector('.release-notes-close')?.click()`); await wait(() => !exists('.release-notes-close'), 'release notes closed', 15000) } }
async function signout() {
  await evaluate(`window.dispatchEvent(new Event('miao-desktop-account'))`)
  await wait(() => exists('.desktop-account-signout'), 'account panel', 30000)
  await evaluate(`document.querySelector('.desktop-account-signout')?.click()`)
  const until = Date.now() + 45000
  let diagnostic
  while (Date.now() < until) {
    diagnostic = await evaluate(`({
      signout: !!document.querySelector('.desktop-account-signout'),
      busy: document.querySelector('.desktop-account-signout')?.disabled || false,
      error: document.querySelector('.desktop-account-error')?.textContent || '',
      login: !!document.querySelector('#desktop-account-email')
    })`)
    if (!diagnostic.signout) return await openAccountPanel()
    if (diagnostic.error) throw new Error('Sign out failed: ' + diagnostic.error)
    await delay(250)
  }
  throw new Error('Timed out: signed out ' + JSON.stringify(diagnostic))
}
async function openAccountPanel() {
  if (await exists('#desktop-account-email')) return
  // The release-notes mask can still cover the shell for a moment during its
  // leave transition, so use the DOM click for the entry itself.
  if (await exists('.release-notes-close')) { await evaluate(`document.querySelector('.release-notes-close')?.click()`); await wait(() => !exists('.release-notes-close'), 'release notes closed', 15000) }
  await wait(() => exists('.studio-top button'), 'app top bar', 60000)
  await wait(async () => await evaluate(`(()=>{const b=[...document.querySelectorAll('.studio-top button')].find(x=>/登录/.test((x.innerText||'').trim()));if(!b)return false;b.click();return true})()`), 'sign-in entry', 30000)
  await wait(() => exists('#desktop-account-email'), 'email field')
}
async function assertLoginForm() {
  await wait(() => exists('#desktop-account-email'), 'email field')
  if (!(await exists('#desktop-account-code'))) {
    await wait(() => evaluate(`!![...document.querySelectorAll('.desktop-login-methods button')].find(b => /验证码登录/.test(b.textContent || ''))`), 'email-code sign-in mode')
    await evaluate(`[...document.querySelectorAll('.desktop-login-methods button')].find(b => /验证码登录/.test(b.textContent || ''))?.click()`)
  }
  await wait(() => exists('#desktop-account-code'), 'code field')
  await wait(() => exists('.desktop-account-send'), 'code request button')
  await wait(() => evaluate(`!![...document.querySelectorAll('.desktop-login-methods button')].find(b => /密码登录/.test(b.textContent || ''))`), 'password sign-in mode')
  await evaluate(`[...document.querySelectorAll('.desktop-login-methods button')].find(b => /密码登录/.test(b.textContent || ''))?.click()`)
  await wait(() => exists('#desktop-account-password'), 'password field')
  await evaluate(`[...document.querySelectorAll('.desktop-login-methods button')].find(b => /验证码登录/.test(b.textContent || ''))?.click()`)
  await wait(() => exists('#desktop-account-code'), 'code field after mode switch')
  const modeCheck = 'sign-in exposes separate password and email-code modes'
  if (!report.checks.includes(modeCheck)) report.checks.push(modeCheck)
  save()
}
function acceptanceCode() {
  return String(process.env.MIAO_ACCEPT_CODE || '').trim()
}
async function signIn() {
  await openAccountPanel()
  await assertLoginForm()
  const code = acceptanceCode()
  await fill('#desktop-account-email', account.email)
  if (/^\d{6}$/.test(code)) {
    await fill('#desktop-account-code', code)
  } else {
    await evaluate(`[...document.querySelectorAll('.desktop-login-methods button')].find(b => /密码登录/.test(b.textContent || ''))?.click()`)
    await wait(() => exists('#desktop-account-password'), 'password field for sign-in')
    await fill('#desktop-account-password', account.password)
  }
  await click('.desktop-account-submit')
}
async function capture(name) { const { data } = await command('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(output, name + '.png'), Buffer.from(data, 'base64')) }
async function canvasReview() {
  return evaluate(`(${(async function () {
    performance.setResourceTimingBufferSize(2000);
    const status = await (await fetch('/api/desktop/status')).json();
    if (status.sync.enabled !== false) throw new Error('Isolated package must have synchronization disabled');
    const session = await (await fetch('/api/imagine/session')).json();
    const headers = { 'content-type': 'application/json', 'x-csrf-token': session.session?.csrf || session.csrf };
    const access = await (await fetch('/api/imagine/mcp', { method: 'PUT', headers, body: JSON.stringify({ enabled: true }) })).json();
    let transport, serial = 0;
    const parse = text => { try { return JSON.parse(text) } catch { return text.split('\n').filter(x => x.startsWith('data:')).map(x => JSON.parse(x.slice(5))).at(-1) } };
    const rpc = async (method, params) => {
      const response = await fetch('/mcp', { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + access.token, ...(transport ? { 'mcp-session-id': transport } : {}), 'mcp-protocol-version': '2025-11-25' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++serial, method, params }) });
      transport = response.headers.get('mcp-session-id') || transport;
      const data = parse(await response.text());
      if (!response.ok || data.error) throw new Error('MCP transport failed: ' + response.status);
      return data.result;
    };
    await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'miaoimg-release-review', version: '1' } });
    const completed = new Set();
    const call = async (name, args = {}) => {
      const result = await rpc('tools/call', { name, arguments: args });
      const text = result.content?.filter(x => x.type === 'text').map(x => x.text).join('\n');
      if (result.isError) throw new Error(name + ': ' + text);
      completed.add(name); return JSON.parse(text);
    };
    // The application has to reconnect its real browser control channel after the switch.
    const until = Date.now() + 20000;
    let connection;
    do {
      const app = await call('getAppState');
      connection = app.connections.find(page => page.ready && page.canvasId && Array.isArray(page.tools) && page.tools.length);
      if (connection) break;
      await new Promise(r => setTimeout(r, 100));
    } while (Date.now() < until);
    if (!connection) throw new Error('MCP canvas connection did not become ready');
    const expected = connection.tools;
    const originalCanvasId = connection.canvasId;
    let canvas = await call('addCanvas', { name: 'Release review' });
    const overview = await call('getCanvas', { include: ['canvases', 'nodeTypes', 'folders'] });
    const discovered = {};
    for (const [i, type] of overview.availableNodeTypes.filter(x => x.type !== 'canvasGroup').entries()) {
      const { node } = await call('addNode', { type: type.type, label: 'Discover ' + type.type, position: { x: i * 400, y: 1800 } });
      const directory = await call('getNodeTools', { nodeIds: [node.id], limit: 50 });
      if (!directory.nodeTools.length) throw new Error('Fresh node has no discoverable functions: ' + type.type);
      if (type.type.includes('GenerationNode') && !directory.nodeTools.some(tool => tool.name === 'node:getOutputHistory')) throw new Error('Unselected generation node is missing history operations');
      discovered[type.type] = directory.nodeTools.map(tool => tool.name);
    }
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const { node } = await call('addNode', { type: 'remote-textNode', label: 'Review ' + i, position: { x: 100 + i * 350, y: 120 } });
      ids.push(node.id);
      await call('nodeTools', { nodeId: node.id, name: 'node:setText', args: { text: 'Release review ' + i } });
    }
    const [A, B, C, D] = ids;
    await call('getNodeTools', { nodeIds: [A], limit: 50 });
    await call('getCanvasNodes', { nodeIds: ids, fields: ['ports', 'outputs', 'geometry'] });
    await call('connectNodes', { connections: [{ source: A, sourceHandle: 'text', target: B, targetHandle: 'in' }] });
    const edges = await call('getCanvasEdges');
    await call('deleteEdges', { edgeIds: [edges.edges[0].id] }); await call('undoCanvas');
    await call('selectNodes', { nodeIds: [A, B] });
    const g1 = await call('groupNodes', { nodeIds: [A, B], label: 'Review group A' });
    const g2 = await call('groupNodes', { nodeIds: [C, D], label: 'Review group B' });
    await call('moveNodes', { moves: [{ nodeId: A, position: { x: 220, y: 260 } }] });
    await call('resizeGroups', { sizes: [{ nodeId: g1.groupId, width: 800, height: 400, position: { x: 50, y: 60 } }] });
    const before = await call('getCanvasNodes', { nodeIds: [B], fields: ['position'] });
    await call('reparentNodes', { nodeIds: [B], parentId: g2.groupId });
    const after = await call('getCanvasNodes', { nodeIds: [B], fields: ['position'] });
    if (JSON.stringify(before.nodes[0].position) !== JSON.stringify(after.nodes[0].position)) throw new Error('Reparent changed absolute position');
    const merged = await call('mergeGroups', { nodeIds: [g1.groupId, g2.groupId], label: 'Merged review' });
    await call('ungroupNodes', { nodeIds: [merged.groupId] });
    const copies = await call('duplicateNodes', { nodeIds: [A, B], withEdges: true });
    await call('deleteNodes', { nodeIds: copies.rootIds }); await call('undoCanvas'); await call('redoCanvas');
    await call('renameNodes', { renames: [{ nodeId: A, label: 'Reviewed A' }] });
    await call('arrangeNodes', { nodeIds: ids, mode: 'grid' }); await call('arrangeCanvas'); await call('fitCanvas');
    await call('setCanvasView', { snapToGrid: true, showMap: true, showEdges: false });
    await call('setCanvasView', { snapToGrid: false, showMap: false, showEdges: true });
    const copied = await call('copyNodes', { nodeIds: [A, B], writeSystemClipboard: false });
    const pasted = await call('pasteNodes', { command: copied.command, position: { x: 100, y: 800 } });
    if (pasted.nodeCount !== 2) throw new Error('Clipboard transfer lost nodes');
    await call('findCanvasNodes', { query: 'Review', limit: 2 });
    await call('createCanvasFolder', { folder: 'Release review folder' });
    canvas = await call('moveCanvas', { folder: 'Release review folder' });
    canvas = await call('renameCanvas', { name: 'Reviewed canvas' });
    await call('switchCanvas', { canvasId: originalCanvasId });
    await call('switchCanvas', { canvasId: canvas.canvasId });
    const discarded = await call('addCanvas', { name: 'Disposable review canvas' });
    await call('switchCanvas', { canvasId: canvas.canvasId }); await call('deleteCanvas', { canvasId: discarded.canvasId });
    await call('createAssetFolder', { folder: 'Release review assets' });
    await call('workspaceFiles', { action: 'writeText', path: 'Release review.md', content: 'Before review' });
    await call('switchPanel', { panel: 'document' }); await call('openDocument', { path: 'Release review.md' });
    const document = await call('getDocument');
    await call('writeDocument', { documentId: document.documentId, expectedText: document.text, text: 'After review' });
    const saved = await call('getDocument');
    if (saved.text !== 'After review') throw new Error('Document was not saved');
    const movedDocumentPath = 'Moved release review.md';
    const moved = await call('moveDocument', { path: 'Release review.md', target: movedDocumentPath });
    const movedDocument = await call('getDocument');
    if (moved.path !== movedDocumentPath || moved.previousPath !== 'Release review.md'
      || movedDocument.selection?.filePath !== movedDocumentPath || movedDocument.text !== saved.text) throw new Error('Moved document did not preserve its content and selection');
    const finalDocumentText = 'After move and close';
    await call('writeDocument', { documentId: movedDocument.documentId, expectedText: movedDocument.text, text: finalDocumentText });
    const closed = await call('closeDocument', { path: movedDocumentPath });
    if (closed.selection?.filePath !== movedDocumentPath || closed.closedViews < 1 || closed.remainingViews !== 0) throw new Error('Document views did not close');
    const closedBytes = await call('workspaceFiles', { action: 'readText', path: movedDocumentPath });
    if (closedBytes.truncated || closedBytes.text !== finalDocumentText) throw new Error('Closed document was not saved');
    const reopened = await call('openDocument', { path: movedDocumentPath });
    if (reopened.selection?.filePath !== movedDocumentPath || reopened.text !== finalDocumentText) throw new Error('Closed document did not reopen with its saved content');
    await call('closeDocument', { path: movedDocumentPath });
    await call('switchPanel', { panel: 'canvas' });
    await call('importCanvasAssets', { paths: [movedDocumentPath], position: { x: 100, y: 1100 } });
    const text = await call('nodeTools', { nodeId: A, name: 'node:getText', args: {} });
    if (text.text !== 'Release review 0') throw new Error('Node content did not survive canvas switching');
    const independentLabel = 'Independent review source';
    await call('renameNodes', { renames: [{ nodeId: A, label: independentLabel }] });
    const independentCanvasPath = 'Independent review copy.json';
    const independent = await call('duplicateCanvas', { canvasId: canvas.canvasId, target: independentCanvasPath });
    if (independent.canvasId !== independentCanvasPath) throw new Error('Independent canvas copy was not confirmed');
    await call('switchCanvas', { canvasId: independent.canvasId });
    const copyNodes = await call('findCanvasNodes', { query: independentLabel, types: ['remote-textNode'] });
    const copiedTextNodes = copyNodes.nodes.filter(node => node.label === independentLabel);
    if (copyNodes.hasMore || copiedTextNodes.length !== 1 || copiedTextNodes[0].id === A) throw new Error('Copied text node does not have an independent identity');
    const copiedTextId = copiedTextNodes[0].id;
    const copiedText = await call('nodeTools', { nodeId: copiedTextId, name: 'node:getText', args: {} });
    if (copiedText.text !== text.text || !text.path || !copiedText.path || copiedText.path === text.path) throw new Error('Canvas copy shares the original text file');
    const independentText = 'Independent copy edit';
    await call('nodeTools', { nodeId: copiedTextId, name: 'node:setText', args: { text: independentText, expectedText: copiedText.text } });
    const copiedBytes = await call('workspaceFiles', { action: 'readText', path: copiedText.path });
    if (copiedBytes.truncated || copiedBytes.text !== independentText) throw new Error('Copied text edit was not saved independently');
    await call('switchCanvas', { canvasId: canvas.canvasId });
    const originalText = await call('nodeTools', { nodeId: A, name: 'node:getText', args: {} });
    const originalBytes = await call('workspaceFiles', { action: 'readText', path: text.path });
    if (originalText.text !== text.text || originalBytes.truncated || originalBytes.text !== text.text) throw new Error('Editing a canvas copy changed the original text');
    const stored = await call('workspaceFiles', { action: 'readText', path: canvas.canvasId, maxBytes: 200000 });
    if (stored.truncated) throw new Error('Canvas receipt is incomplete');
    const documentBytes = JSON.parse(stored.text);
    if (documentBytes.miaoimgCanvas !== true || documentBytes.schemaVersion !== 1
      || Object.keys(documentBytes).some(key => key !== 'miaoimgCanvas' && /canvas$/i.test(key) && documentBytes[key] === true)) throw new Error('Saved canvas contains a retired marker');
    const missing = expected.filter(name => !completed.has(name));
    if (missing.length) throw new Error('Canvas operations not exercised: ' + missing.join(', '));
    await fetch('/api/imagine/mcp', { method: 'PUT', headers, body: JSON.stringify({ enabled: false }) });
    // A disabled channel may discover revocation once, then must stop reconnecting.
    const attempts = () => performance.getEntriesByType('resource').filter(entry => entry.name.includes('/api/mcp/control/events?')).length;
    await new Promise(r => setTimeout(r, 4000));
    const closedAttempts = attempts();
    await new Promise(r => setTimeout(r, 3500));
    if (attempts() !== closedAttempts) throw new Error('Disabled MCP channel kept reconnecting');
    return { synchronizationDisabled: true, externalConnectionStopped: true, installedReaderCompatibility: true, canvasId: canvas.canvasId, canvasOperations: expected, contentPreserved: true, independentCanvasCopy: true, movedDocumentSaved: true, closedDocumentSaved: true, copiedNodes: pasted.nodeCount, nodeTypes: overview.availableNodeTypes.map(x => x.type), discovered };
  }).toString()})()`, 180000);
}

async function stop() {
  if (ws?.readyState === 1) { try { await command('Browser.close') } catch {} ws.close() }
  if (child && child.exitCode == null) { await Promise.race([new Promise <void>(r => child.once('exit', r)), delay(5000)]); if (child.exitCode == null) child.kill() }
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Application closed')) } pending.clear()
}
try {
  await start(); await openAccountPanel(); await assertLoginForm()
  const navigation = await evaluate('performance.timeOrigin')
  await signIn(); await canvas()
  report.checks.push('existing authorized account opens canvas'); await capture('signed-in'); save()
  await signout(); await signIn(); await canvas()
  if (await evaluate('performance.timeOrigin') !== navigation) throw new Error('Login or logout reloaded the page')
  report.checks.push('logout and password login work without reloading'); save()
  const beforeReload = await evaluate('performance.timeOrigin');
  await evaluate(`(async()=>{const s=await(await fetch('/api/imagine/session')).json();await fetch('/api/imagine/mcp',{method:'PUT',headers:{'content-type':'application/json','x-csrf-token':s.session?.csrf||s.csrf},body:JSON.stringify({enabled:true})});location.reload()})()`);
  await wait(async () => await evaluate('performance.timeOrigin') !== beforeReload && await exists('.studio-app'), 'canvas reload');
  report.canvasReview = await canvasReview(); report.checks.push('installed package executes every exposed canvas operation through MCP'); await capture('canvas-reviewed'); save()
  report.version = (await evaluate('window.miaoDesktop.updateStatus()')).currentVersion
  await stop(); await start(); await canvas()
  const restored = await evaluate(`fetch('/api/desktop/status').then(r=>r.json()).then(v=>v.cloud.account?.email)`)
  if (restored !== account.email) throw new Error('Saved account was not restored')
  report.checks.push('restart restores the same account'); await capture('restored'); save()
  await signout(); await stop(); await start(['--proxy-server=http://127.0.0.1:9'])
  await openAccountPanel(); await assertLoginForm(); await signIn()
  await wait(() => evaluate(`document.querySelector('[role="alert"]')?.textContent.includes('暂时连接不上妙图')`), 'network error message', 35000)
  report.checks.push('unreachable proxy shows a login connection error'); await capture('connection-error'); save()
  await stop(); await start(); await signIn(); await canvas()
  report.checks.push('login succeeds after connection is restored'); await signout(); report.ok = true
} catch (error) { report.ok = false; report.error = error.message; try { await capture('failure') } catch {} process.exitCode = 1 }
finally {
  try { if (ws?.readyState === 1 && await evaluate(`[...document.querySelectorAll('.studio-top button')].some(b => (b.innerText||'').trim() === '账号')`)) await signout() }
  catch { report.logoutCleanupError = 'Could not confirm logout before stopping the isolated app' }
  await stop(); report.finishedAt = new Date().toISOString(); save(); console.log(JSON.stringify(report))
}
