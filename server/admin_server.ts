import { createServer } from 'node:http'
import { ManagementStore, failure, normalizeEmail, secretMatches, validEmail } from './management-store.ts'
import { adminModelCatalog, modelCatalog, publicModelCatalog, publicVideoCatalog, providerCatalog, providerConfigured, upstreamCostCatalog } from './image-models.ts'
import { paymentConfig, publicPaymentConfig } from './payment-contract.ts'
import { runtimeSecret } from './runtime-secrets.ts'
import { bodyJson, cookieToken, json, sessionCookie, mutation, sameOrigin, loginRate } from './http-auth.ts'
import { redactReferencePayload } from './reference-assets.ts'
import { WorkspaceFiles } from './workspace-files.ts'
import { publicTextCatalog, textChannelReady } from './text-models.ts'
import { generationDetail, probeGeneration, restoreGeneration, serveGenerationVideo } from './admin-generation.ts'
import { HttpIncomingRequests } from './http-request-lifetime.ts'
import { createFeedbackStore } from './feedback-store.ts'
import { refreshSuiheModels } from './suihe.ts'
const configuredHost=process.env.OIP_ADMIN_HOST||'127.0.0.1'
// The production image sets this guard because the admin API is meant to be
// reached through the same-origin Vite server (or an SSH tunnel). Binding to
// the configured external host is an explicit opt-out, never the default of a
// container setting that happens to be present.
const HOST=process.env.OIP_ADMIN_LOCAL_ONLY === 'true' ? '127.0.0.1' : configuredHost
const PORT=Number(process.env.OIP_ADMIN_PORT||4184)
const store=new ManagementStore()
const workspaceFiles=new WorkspaceFiles(store,{migrate:false})

// The existing admin table keeps the upstream response behind a <details>
// disclosure.  Keep the raw provider payload intact, but add the durable
// audit fields to that disclosed object so a rejected call is explainable
// without opening SQLite or SSH.  The request id is parsed only from the
// already-redacted error text written by ManagementStore.
function upstreamCallForAdmin(row) {
  const error = String(row?.error || '').trim()
  const requestId = String(row?.upstream_request_id || '').trim() || /(?:request[ _-]*id|请求\s*id)\s*[:：=]\s*([A-Za-z0-9_-]+)/i.exec(error)?.[1] || null
  const response = row?.response && typeof row.response === 'object' && !Array.isArray(row.response)
    ? { ...row.response }
    : {}
  response._miaoimgAudit = {
    status: String(row?.status || 'unknown'),
    requestId,
    error: error || null,
    costRmb: row?.cost_rmb == null ? null : Number(row.cost_rmb),
  }
  return { ...row, request: redactReferencePayload(row.request || {}), requestId, response: redactReferencePayload(response) }
}

function upstreamCallsForAdmin(query) {
  const result = store.upstreamCalls(query)
  return { ...result, items: result.items.map(upstreamCallForAdmin) }
}

function upstreamAuditModels() {
  const providers = Object.fromEntries(providerCatalog().map(provider => [provider.id, provider]))
  return modelCatalog().map(model => {
    const publicId = model.publicId || model.id
    const lastCall = store.get('SELECT created_at FROM upstream_calls WHERE model=? OR model=? ORDER BY created_at DESC LIMIT 1', model.id, publicId)
    const snapshot = store.get('SELECT balance,observed_at FROM upstream_balance_snapshots WHERE provider=? ORDER BY observed_at DESC LIMIT 1', model.provider)
    return {
      model: publicId,
      label: model.label,
      provider: model.provider,
      providerLabel: providers[model.provider]?.label || model.provider,
      automaticReconciliation: model.provider === 'metaso',
      manualReviewRequired: model.provider === 'ark',
      billingCheck: model.provider === 'metaso' ? 'balance_snapshots' : 'manual_request_id',
      latestCallAt: lastCall?.created_at || null,
      balance: snapshot?.balance == null ? null : Number(snapshot.balance),
      balanceAt: snapshot?.observed_at || null,
    }
  })
}

const feedback=createFeedbackStore(store)
const incomingRequests = new HttpIncomingRequests('管理服务正在关闭，请稍后重试', true)
const server=createServer(async(request,response)=>{
 let incoming
 try {
  incoming = incomingRequests.begin(request,response)
  const url=new URL(request.url||'/',`http://${HOST}:${PORT}`),path=url.pathname
  if(path==='/health'){json(response,200,{ok:true,protected:true});return}
  const token=cookieToken(request,'miao_admin'),session=store.session(token)
  if(path==='/api/admin/login' && request.method==='POST'){
   sameOrigin(request);loginRate(request)
   const body=await bodyJson(request)
   const email = normalizeEmail(body.email)
   const passwordLogin = validEmail(email)
     && email === normalizeEmail(runtimeSecret('OIP_ADMIN_EMAIL'))
     && secretMatches(body.password, runtimeSecret('OIP_ADMIN_PASSWORD'))
   const tokenLogin = secretMatches(body.token, runtimeSecret('OIP_ADMIN_TOKEN'))
   if(!passwordLogin && !tokenLogin)throw failure('管理员邮箱或密码不正确',401)
   const s=store.createSession('admin');store.audit('管理员','session.login','admin');json(response,200,{ok:true,csrf:s.csrf,role:'admin'},{'set-cookie':sessionCookie(request,s.token,false,'miao_admin')});return
  }
  if(!session || session.role!=='admin')throw failure('请先登录管理员账号',401)
  if(request.method!=='GET' && request.method!=='HEAD')mutation(request,session)
  // The initial check admits the upload; it cannot authorize a mutation after
  // the same cookie has expired or been revoked while its body was arriving.
  const mutateBody = async (commit: (body: any) => any) => {
    const body = await bodyJson(request)
    const current = store.session(token)
    if(!current || current.role!=='admin')throw failure('管理员登录已失效，请重新登录',401)
    mutation(request,current)
    return commit(body)
  }
  const actor='管理员'
  if(path==='/api/admin/session'){json(response,200,{role:'admin',csrf:session.csrf});return}
  if(path==='/api/admin/logout' && request.method==='POST'){store.logout(token);json(response,200,{ok:true},{'set-cookie':sessionCookie(request,'',true,'miao_admin')});return}
  // 上游留档与推算单价：用户真实跑过的每一单都在这里，包括上游没公开价的档位。
  if(path==='/api/admin/upstream-calls' && request.method==='GET'){json(response,200,upstreamCallsForAdmin(Object.fromEntries(url.searchParams)));return}
  if(path==='/api/admin/upstream-reconciliation' && request.method==='GET'){await refreshSuiheModels({env:process.env}).catch(()=>[]);json(response,200,{...store.upstreamReconciliation(Object.fromEntries(url.searchParams)),models:upstreamAuditModels()});return}
  if(path==='/api/admin/derived-prices' && request.method==='GET'){json(response,200,{items:store.derivedUpstreamPrices(Object.fromEntries(url.searchParams))});return}
  if(path==='/api/admin/overview' && request.method==='GET'){await refreshSuiheModels({env:process.env}).catch(()=>[]);const payments=paymentConfig(process.env);const settings=store.settings();const adminModels=adminModelCatalog();const textModels=(await publicTextCatalog(process.env)).map(model=>({...model,configured:textChannelReady(process.env,model.id),paused:settings.models[model.id]===false}));json(response,200,{stats:store.overview(),settings,models:adminModels.filter(model=>!model.video),videoModels:adminModels.filter(model=>model.video),textModels,upstreamCosts:upstreamCostCatalog(),providers:providerCatalog().map(p=>({...p,configured:providerConfigured(p.id,process.env),latestCall:store.get('SELECT status,created_at,error FROM upstream_calls WHERE provider=? ORDER BY created_at DESC,id DESC LIMIT 1',p.id)||null})),costPolicy:store.costPolicy(),payments:{...publicPaymentConfig(payments),summary:store.paymentSummary()}});return}
  if(path==='/api/admin/operations' && request.method==='GET'){
   const lifetime=new AbortController()
   const close=()=>lifetime.abort()
   response.once('close',close)
   try {const result=await store.operations({signal:lifetime.signal});if(!response.destroyed)json(response,200,result)}
   finally {response.removeListener('close',close)}
   return
  }
  if(path==='/api/admin/text-calls' && request.method==='GET'){json(response,200,store.textBilling.list(Object.fromEntries(url.searchParams)));return}
  const textPolicyMatch=/^\/api\/admin\/users\/([a-z0-9-]+)\/(text-policy|gift)$/.exec(path)
  if(textPolicyMatch){const [,userId,action]=textPolicyMatch
    if(!store.user(userId))throw failure('用户不存在',404)
    if(action==='text-policy' && request.method==='GET'){json(response,200,store.textBilling.userPolicy(userId));return}
    if(action==='text-policy' && request.method==='PATCH'){json(response,200,await mutateBody(body=>store.textBilling.saveUserPolicy(userId,body,actor)));return}
    if(action==='gift' && request.method==='POST'){json(response,200,await mutateBody(body=>store.textBilling.gift(userId,body,actor)));return}
  }
  if(path==='/api/admin/users'){
   if(request.method==='GET'){json(response,200,(()=>{const result=store.users(Object.fromEntries(url.searchParams));return {...result,items:result.items.map(user=>({...user,textPolicy:store.textBilling.userPolicy(user.id)}))}})());return}
   if(request.method==='POST'){json(response,201,await mutateBody(body=>store.createUser(body,actor)));return}
  }
  const match=/^\/api\/admin\/users\/([a-z0-9-]+)(?:\/(points|code|ledger|password|stats))?$/.exec(path)
  if(match){const [,id,action]=match
   if(action==='ledger' && request.method==='GET'){const ledger=store.ledgers(id,{limit:30,...Object.fromEntries(url.searchParams),includeTextCharges:true});json(response,200,{...ledger,items:ledger.rows,rows:undefined});return}
   if(action==='points' && request.method==='POST'){json(response,200,await mutateBody(body=>store.adjustPoints(id,body.delta,body.reason,actor)));return}
   if(action==='code' && request.method==='POST'){json(response,200,store.rotateCode(id,actor));return}
   if(action==='password' && request.method==='POST'){json(response,200,await mutateBody(body=>store.resetPassword(id,body.password,actor)));return}
   if(action==='stats' && request.method==='GET'){json(response,200,store.userStats(id,Object.fromEntries(url.searchParams)));return}
   if(!action && request.method==='PATCH'){json(response,200,await mutateBody(body=>store.updateUser(id,body,actor)));return}
  }
  if(path==='/api/admin/settings' && request.method==='PATCH'){json(response,200,await mutateBody(body=>store.saveSettings(body,actor)));return}
  const resultMatch=/^\/api\/admin\/generations\/([a-zA-Z0-9_-]{20,100})(?:\/(media|probe|restore))?$/.exec(path)
  if(resultMatch){const [,requestId,action]=resultMatch
    if(!action && request.method==='GET'){json(response,200,generationDetail(store,workspaceFiles,requestId));return}
    if(action==='media' && ['GET','HEAD'].includes(request.method)){serveGenerationVideo(request,response,store,workspaceFiles,requestId,url.searchParams.get('download')==='1');return}
    if(action==='probe' && request.method==='POST'){json(response,200,await probeGeneration(store,workspaceFiles,requestId));return}
    if(action==='restore' && request.method==='POST'){json(response,200,await restoreGeneration(store,workspaceFiles,requestId));return}
  }
  if(path==='/api/admin/generations' && request.method==='GET'){json(response,200,store.records(Object.fromEntries(url.searchParams)));return}
  if(path==='/api/admin/payment-orders' && request.method==='GET'){json(response,200,store.paymentOrders(Object.fromEntries(url.searchParams)));return}
  if(path==='/api/admin/reconciliation' && request.method==='GET'){json(response,200,store.reconciliation(Object.fromEntries(url.searchParams)));return}
  if(path==='/api/admin/audit' && request.method==='GET'){json(response,200,store.audits(Object.fromEntries(url.searchParams)));return}
  // 用户反馈：列表、详情、回复、改状态和标签。
  if(path==='/api/admin/feedback' && request.method==='GET'){json(response,200,feedback.listForAdmin(Object.fromEntries(url.searchParams)));return}
  const feedbackMatch=/^\/api\/admin\/feedback\/([a-f0-9-]{36})(?:\/(comments|attachments))?(?:\/([a-f0-9-]{36}))?$/.exec(path)
  if(feedbackMatch){const [,id,action,attachmentId]=feedbackMatch
   if(!action && request.method==='GET'){json(response,200,feedback.getForAdmin(id));return}
   if(!action && request.method==='PATCH'){json(response,200,await mutateBody(body=>feedback.updateAsAdmin(id,body,actor)));return}
   if(action==='comments' && request.method==='POST'){json(response,200,await mutateBody(body=>feedback.commentAsAdmin(id,body.body,actor)));return}
   if(action==='attachments' && attachmentId && request.method==='GET'){const file=feedback.attachment(id,attachmentId);response.writeHead(200,{'content-type':file.mime,'content-length':file.size,'cache-control':'private, max-age=86400','x-content-type-options':'nosniff'});response.end(Buffer.from(file.bytes));return}
  }
  json(response,404,{error:'未找到这个管理功能'})
 } catch(error){
  if(!response.destroyed && !response.writableEnded){
   if(response.headersSent)response.destroy()
   else json(response,error.status||500,{error:error.status?error.message:'后台暂时无法完成操作，请重试'})
  }
 } finally { incoming?.finish() }
})
server.listen(PORT,HOST,()=>console.log(`Admin API listening on http://${HOST}:${PORT}`))
let stopping = false
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{
 if(stopping)return
 stopping = true
 const handlersStopped = incomingRequests.stop()
 server.close(async()=>{await handlersStopped;store.close();process.exit(0)})
 server.closeAllConnections()
})
