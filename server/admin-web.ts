import { createServer, request as proxyRequest } from 'node:http'
import { spawn } from 'node:child_process'
import { createReadStream, statSync } from 'node:fs'
import { pipeline } from 'node:stream'
import { resolve, extname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
const root=resolve(process.env.OIP_ADMIN_WEB_ROOT||fileURLToPath(new URL('../admin-web',import.meta.url)))
const port=Number(process.env.OIP_ADMIN_WEB_PORT||4173)
const apiPort=Number(process.env.OIP_ADMIN_PORT||4184)
// Validate before spawning the API: listen() throws synchronously for a bad
// port, before the server's error event can own child-process cleanup.
if(!Number.isInteger(port)||port<0||port>65535||!Number.isInteger(apiPort)||apiPort<1||apiPort>65535)throw new Error('Admin service port is invalid')
const child=spawn(process.execPath,[fileURLToPath(new URL('./admin_server.ts',import.meta.url))],{stdio:'inherit'})
const childClosed=new Promise<number>(resolve=>child.once('close',code=>resolve(code??1)))
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2','.json':'application/json'}
function file(response,path,immutable=false){
 try{const info=statSync(path);if(!info.isFile())throw Error();response.writeHead(200,{'content-type':types[extname(path)]||'application/octet-stream','content-length':info.size,'cache-control':immutable?'public, max-age=31536000, immutable':'no-store','x-content-type-options':'nosniff'});pipeline(createReadStream(path),response,()=>{})}catch{response.writeHead(404,{'cache-control':'no-store'});response.end('Not found')}
}
const server=createServer(async(req,res)=>{
 try{
  if(stopping){res.writeHead(503,{'cache-control':'no-store'});res.end('Admin unavailable');return}
  const url=new URL(req.url,'http://localhost')
  if(url.pathname==='/health'){const check=await fetch(`http://127.0.0.1:${apiPort}/health`,{signal:AbortSignal.timeout(3000)});res.writeHead(check.status,{'content-type':'application/json','cache-control':'no-store'});res.end(await check.text());return}
  if(url.pathname.startsWith('/admin-api/')||url.pathname.startsWith('/api/admin/')){
   const upstream=proxyRequest({hostname:'127.0.0.1',port:apiPort,path:req.url.replace(/^\/admin-api\//,'/api/admin/'),method:req.method,headers:{...req.headers}},reply=>{res.writeHead(reply.statusCode,reply.headers);pipeline(reply,res,()=>{})})
   upstream.on('error',()=>{if(res.destroyed||res.writableEnded)return;if(res.headersSent){res.destroy();return}res.writeHead(502,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({error:'后台连接失败，请刷新重试'}))});req.on('aborted',()=>upstream.destroy());res.once('close',()=>upstream.destroy());req.pipe(upstream);return
  }
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return}
  if(['/','/manage','/manage/'].includes(url.pathname)){file(res,resolve(root,'admin.html'));return}
  if(url.pathname==='/miaoimg-logo.png'){file(res,resolve(root,'miaoimg-logo.png'));return}
  if(url.pathname.startsWith('/admin-assets/')){
   const path=resolve(root,decodeURIComponent(url.pathname.slice('/admin-assets/'.length)))
   if(!path.startsWith(root+sep)){res.writeHead(403);res.end();return}
   file(res,path,path.includes(sep+'assets'+sep));return
  }
  res.writeHead(404);res.end('Not found')
 }catch{if(!res.headersSent)res.writeHead(503,{'cache-control':'no-store'});res.end('Admin unavailable')}
})
let stopping=false
function stop(exitCode=0){
 if(stopping)return
 stopping=true
 child.kill('SIGTERM')
 const serverClosed=new Promise<void>(resolve=>server.close(()=>resolve()))
 server.closeAllConnections()
 // The API owns accepted recovery/accounting work after its reader leaves.
 // Wait for its real process close; a closed proxy is not an API receipt.
 void Promise.all([serverClosed,childClosed]).then(([,childExitCode])=>process.exit(exitCode||childExitCode))
}
child.on('error',()=>{console.error('Admin API failed to start; stopping console');stop(1)})
child.on('exit',()=>{if(!stopping){console.error('Admin API exited; stopping console');stop(1)}})
server.on('error',()=>{console.error('Admin console failed to listen; stopping API');stop(1)})
server.listen(port,'0.0.0.0',()=>console.log(`Admin console listening on ${port}`))
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>stop())
