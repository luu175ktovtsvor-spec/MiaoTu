import { costEvidence } from './cost-evidence.ts'
import { createReadStream } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { failure } from './management-store.ts'
import { DEFAULT_PROJECT_ID } from './projects.ts'
import { restoreVideoResult } from './video-api.ts'
const execFileAsync = promisify(execFile)

// The router authenticates an administrator before entering any of these helpers.
// Paths are taken from an exact generation row, never from a caller-supplied path.
async function generation(store, requestId) {
  const row = (await store.get('SELECT * FROM generations WHERE request_id=?', requestId))
  if (!row) throw failure('生成记录不存在', 404)
  return row
}
async function storedVideo(store, workspaceFiles, row) {
  const video = (await store.videoResult(row.id))
  const parameters = JSON.parse(row.parameters || '{}')
  if (parameters.desktopDeliveredAt) throw failure('文件已交付桌面，请在生成时使用的电脑上打开', 410)
  if (parameters.desktopMediaExpiredAt) throw failure('服务器暂存已过期；如已保存，请在原电脑查看', 410)
  const path = video?.metadata?.workspacePath
  if (!row.user_id || !path) throw failure('尚未记录账号工作区的视频留存路径', 404)
  return { ...(await workspaceFiles.locate(row.user_id, path, parameters.workspaceProject || DEFAULT_PROJECT_ID)), video }
}
export async function generationDetail(store, workspaceFiles, requestId) {
  const row = (await generation(store, requestId))
  const record = (await store.records({requestId, limit:1})).items[0]
  const user = row.user_id ? (await store.get('SELECT name,email,status FROM users WHERE id=?', row.user_id)) : null
  const ledger = (await store.all('SELECT delta,reason,created_at FROM ledger WHERE request_id=? ORDER BY created_at,id', row.id))
  let persisted: Record<string, any> = { exists: false, path: record.video?.metadata?.workspacePath || null, reason: null }
  if (record.video && (!record.delivery || record.delivery.status === 'pending')) {
    try { const file = (await storedVideo(store, workspaceFiles, row)); persisted = {exists:true,path:file.path,size:file.size,mime:file.mime,revision:file.revision,updatedAt:file.updated_at} }
    catch(error) { persisted.reason = error.status ? error.message : '无法读取视频留存文件' }
  }
  const parameters = JSON.parse(row.parameters || '{}')
  const canvas = []
  // Only inspect bounded root canvas documents in this generation's own project.
  // Read observations do not repair or overwrite any user's canvas.
  if (row.user_id && parameters.outputDirectory && parameters.desktopDelivery !== 1) {
    const nodeId = parameters.outputDirectory.split('/').filter(Boolean).at(-1)
    const project = parameters.workspaceProject || DEFAULT_PROJECT_ID
    const clauses = workspaceFiles.scoped ? 'user_id=? AND project_id=?' : 'user_id=?'
    const args = workspaceFiles.scoped ? [row.user_id,project] : [row.user_id]
    const candidates = (await store.all(`SELECT path,size FROM workspace_files WHERE ${clauses} AND path NOT LIKE '%/%' AND path LIKE '%.json' LIMIT 100`, ...args))
    for (const candidate of candidates) {
      if (Number(candidate.size) > 1024 * 1024) continue
      try {
        const value = JSON.parse((await workspaceFiles.read(row.user_id,candidate.path,project)).bytes.toString('utf8'))
        const nodes = value.nodes || value.data?.nodes
        if (!Array.isArray(nodes)) continue
        const node = nodes.find(node => node.id === nodeId)
        if (!node) continue
        canvas.push({ path:candidate.path, nodeId, containsVideoPath: persisted.path ? JSON.stringify(node).includes(persisted.path) : null, latestRequestMatches: JSON.stringify(node).includes(row.request_id) })
      } catch { /* non-canvas and missing files are not evidence of canvas failure */ }
    }
  }
  return {...record,costEvidence:costEvidence(record.upstreamCost),user,ledger,refundPoints:ledger.filter(item=>Number(item.delta)>0).reduce((sum,item)=>sum+Number(item.delta),0), execution:{heartbeatAt:row.lease_at ? row.lease_at : null,upstreamStatus:row.upstream_status,submissionUncertain:record.submissionUncertain},persisted,canvas,observedAt:new Date().toISOString()}
}
export async function probeGeneration(store, workspaceFiles, requestId) {
  const file = (await storedVideo(store,workspaceFiles,(await generation(store,requestId))))
  if (!file.diskPath) throw failure('该视频没有可探测的磁盘文件',409)
  const {stdout} = await execFileAsync('ffprobe',['-v','error','-show_format','-show_streams','-of','json',file.diskPath],{timeout:30000,maxBuffer:1024*1024})
  const metadata = JSON.parse(stdout)
  const stream = metadata.streams?.find(item=>item.codec_type==='video')
  if (!stream) throw failure('留存文件没有有效视频轨道',422)
  return {width:stream.width,height:stream.height,duration:Number(metadata.format?.duration) || null,codec:stream.codec_name,audio:metadata.streams?.some(item=>item.codec_type==='audio'),size:file.size,observedAt:new Date().toISOString()}
}
export async function restoreGeneration(store, workspaceFiles, requestId) {
  const row = (await generation(store,requestId))
  if (!row.user_id) throw failure('这条记录没有所属用户工作区',409)
  // Admin authorization has already been checked. Preserve the same request and
  // owner scope for the existing restoration flow; this never submits a model.
  const result = await restoreVideoResult({requestId},{role:'user',userId:row.user_id},{management:store,workspaceFiles})
  await store.audit('管理员','generation.restore',row.request_id,{already:result.already,path:result.path})
  return {result,record:(await generationDetail(store,workspaceFiles,requestId))}
}
export async function serveGenerationVideo(request,response,store,workspaceFiles,requestId,download=false) {
  const file = (await storedVideo(store,workspaceFiles,(await generation(store,requestId))))
  const headers = {'content-type':file.mime,'cache-control':'private, no-store','accept-ranges':'bytes','x-content-type-options':'nosniff'}
  if(download)headers['content-disposition']='attachment; filename="miaoimg-video.mp4"'
  let start=0,end=file.size-1,status=200
  if(request.headers.range) {
    const match=/^bytes=(\d*)-(\d*)$/.exec(request.headers.range)
    if(!match || (!match[1] && !match[2])) {response.writeHead(416,{'content-range':`bytes */${file.size}`});response.end();return}
    if(!match[1])start=Math.max(0,file.size-Number(match[2]))
    else {start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]))}
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=file.size){response.writeHead(416,{'content-range':`bytes */${file.size}`});response.end();return}
    status=206;headers['content-range']=`bytes ${start}-${end}/${file.size}`
  }
  headers['content-length']=end-start+1
  response.writeHead(status,headers)
  if(request.method==='HEAD'){response.end();return}
  if(file.bytes){response.end(file.bytes.subarray(start,end+1));return}
  const stream=createReadStream(file.diskPath,{start,end})
  stream.on('error',()=>response.destroy())
  response.on('close',()=>stream.destroy())
  stream.pipe(response)
}
