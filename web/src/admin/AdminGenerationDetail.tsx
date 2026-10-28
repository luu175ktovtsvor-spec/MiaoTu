import { ADMIN_API_BASE } from './api-base'
// @ts-nocheck
import { useEffect, useRef, useState } from 'react'
import { isDiscardedAdminRequest } from './useAdminSession'
import { mediaSizeLabel, sizeTier, videoSizeLabel } from '../../../server/media-size-label'
export default function AdminGenerationDetail({record:r,api,onRecord,lang}) {
 const [probe,setProbe]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const t=(zh,en)=>lang==='en'?en:zh
 const date=value=>value?new Date(value).toLocaleString(lang==='en'?'en-US':'zh-CN',{hour12:false}):'—'
 const statuses={queued:t('排队中','Queued'),running:t('生成中','Running'),succeeded:t('已完成','Completed'),failed:t('失败','Failed'),cancelled:t('已取消','Cancelled'),expired:t('已过期','Expired')}
 const requestId=r.requestId||r.request_id
 const base=`generations/${encodeURIComponent(requestId)}`
 const media=`${ADMIN_API_BASE}/${base}/media`
 const pending=useRef<AbortController | null>(null)
 useEffect(()=>()=>{pending.current?.abort()},[])
 async function action(kind){
  pending.current?.abort()
  const controller=new AbortController();pending.current=controller
  setBusy(true);setError('')
  try{
   const result=await api(`${base}/${kind}`,'POST',{},controller.signal)
   if(controller.signal.aborted)return
   if(kind==='probe')setProbe(result);else{setProbe(null);onRecord(result.record)}
  }catch(e){if(!controller.signal.aborted&&!isDiscardedAdminRequest(e))setError(e.message)}
  finally{if(!controller.signal.aborted)setBusy(false);if(pending.current===controller)pending.current=null}
 }
 const p=r.parameters||{},u=r.usage||{},d=r.upstreamCost?.detail||{}
 const modes={text:t('文生视频','Text to video'),image:t('混合参考','Mixed references'),singleImage:t('单图生视频','Image to video'),startFrameOptional:t('首帧','First frame'),endFrameOptional:t('首尾帧','First / last frame'),edit:t('编辑','Edit'),extend:t('延长','Extend')}
 const creativeModes={native:t('标准','Standard'),super_economy:t('节省模式','Economy mode')}
 const qualities={low:t('低画质','Low'),medium:t('标准画质','Medium'),high:t('高画质','High'),xhigh:t('超高画质','Extra high'),max:t('极致画质','Max'),auto:t('自动','Auto')}
 const isVideo=p.duration!=null||Boolean(p.resolution)
 const unknown=t('未留存','Not retained')
 const bool=value=>typeof value==='boolean'?(value?t('开启','On'):t('关闭','Off')):unknown
 const parameters=isVideo?[
  [t('生成模式','Mode'),modes[p.mode]||p.mode||unknown],
  ...(p.creativeMode?[[t('创作模式','Creative mode'),creativeModes[p.creativeMode]||p.creativeMode]]:[]),
  [t('清晰度 / 比例','Resolution / aspect ratio'),(p.resolution?sizeTier(p.resolution)||p.resolution:unknown)+' / '+(p.ratio||unknown)],
  [t('请求 / 计费时长','Requested / billable duration'),(p.duration??unknown)+' / '+(p.billableDuration??unknown)+' s'],
  [t('参考图片 / 视频 / 音频数量','Reference image / video / audio count'),(p.referenceImages??unknown)+' / '+(p.videos?.length??unknown)+' / '+(p.audios?.length??unknown)],
  [t('参考视频 / 音频时长','Reference video / audio duration'),(p.videoSeconds??unknown)+' / '+(p.audioSeconds??unknown)+' s'],
  [t('生成声音 / 返回尾帧 / 联网搜索','Audio / last frame / web search'),bool(p.generateAudio)+' / '+bool(p.returnLastFrame)+' / '+bool(p.webSearch)],
  [t('实际计费用量','Reported billing usage'),u.completion_tokens!=null?u.completion_tokens+' tokens':u.output_seconds!=null?u.output_seconds+' s':unknown],
 ]:[
  [t('尺寸 / 画质','Size / quality'),(p.size?mediaSizeLabel(p.size,'',t('自动','Auto')):unknown)+' / '+(p.quality?qualities[p.quality]||p.quality:t('不分档','No tier'))],
  [t('请求 / 返回张数','Requested / returned images'),(p.count??unknown)+' / '+(r.images?.length??unknown)],
  [t('参考图片数量','Reference images'),p.referenceCount??unknown],
  [t('格式 / 背景 / 输入保真度','Format / background / input fidelity'),(p.format||unknown)+' / '+(p.background||unknown)+' / '+(p.inputFidelity||t('不分档','No tier'))],
  [t('编辑 / 图层拆分','Edit / layer decomposition'),(p.editMode||t('无','None'))+' / '+bool(p.layerDecomposition)],
 ]
 const rate=d.perSecondRmb!=null?d.perSecondRmb+' '+t('元/秒','CNY/second'):d.rmbPerMillion!=null?d.rmbPerMillion+' '+t('元/百万 token','CNY/million tokens'):d.pricingSnapshot?.unitRmb!=null?d.pricingSnapshot.unitRmb+' '+t('元/张','CNY/image'):d.unit!=null?d.unit+' '+t('元/张','CNY/image'):d.usdPerImage!=null&&d.rmbPerUsd!=null?Math.round(d.usdPerImage*d.rmbPerUsd*10000)/10000+' '+t('元/张','CNY/image'):unknown
 const fields=[[t('用户','User'),r.user?`${r.user.name} · ${r.user.email}`:r.actor],[t('状态','Status'),statuses[r.status]||r.status],[t('模型 / 通道','Model / provider'),`${r.modelLabel||r.model} · ${r.provider||'—'}`],[t('妙图请求 ID','Request ID'),requestId],[t('上游任务 ID','Provider task ID'),r.upstreamRequestId||'—'],[t('创建 / 开始 / 结束','Created / started / finished'),`${date(r.createdAt||r.created_at)} / ${date(r.startedAt)} / ${date(r.finishedAt)}`],[t('执行心跳','Worker heartbeat'),date(r.execution?.heartbeatAt)],[t('上游 HTTP 状态','Provider HTTP status'),r.upstream_status??'—'],[t('提交阶段','Submission stage'),r.parameters?.submissionState==='not_started'?t('素材准备中，尚未提交','Preparing references; not dispatched'):r.parameters?.submissionState==='started'?t('已进入提交，返回不明不自动重试','Dispatch started; uncertain responses are not retried'):t('旧记录未留存','Not retained in older records')],[t('预扣 / 实扣 / 已退还积分','Reserved / charged / refunded credits'),`${r.reservedPoints} / ${r.chargedPoints} / ${Number(r.refundPoints||0).toFixed(2)}`],[t('留档推算成本（元）','Recorded estimated cost (CNY)'),r.upstreamCost?.rmb??t('未知','Unknown')],[t('成本证据','Cost evidence'),lang==='en' ? ({usage_estimate:'Reported usage estimate',parameter_estimate:'Parameter forecast',price_reference:'Price reference estimate',unknown:'Unknown'}[r.costEvidence?.level] || 'Unknown') : r.costEvidence?.label || '成本未知'],[t('供应商逐单账单','Provider per-request invoice'),t('尚未核对；不能当作实扣账单','Unverified; not an actual invoice')]]
 return <div className="admin-record">
  <p className="admin-footnote">{t('请求参数与上游报告值不等于产物实际尺寸；下方可读取留存文件核对。画布状态仅为读取时的观察，不会覆盖用户内容。','Requested parameters and provider metadata do not prove actual media dimensions. Probe the stored file below. Canvas observations never overwrite user content.')}</p>
  <dl>{fields.map(([key,value])=><div key={key}><dt>{key}</dt><dd>{value??'—'}</dd></div>)}</dl>
  <h3>{t('本次参数与计费依据','Request parameters and billing basis')}</h3>
  <dl>{[...parameters,[t('本次上游单价','Supplier unit rate'),rate],[t('成本计算依据','Cost calculation basis'),r.upstreamCost?.basis||unknown]].map(([key,value])=><div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
  {d.expenses?.serverAllocationMode==='all_media_requests'&&<p className="admin-footnote">{t('全站媒体共同分摊服务器','Shared server allocation across media')}：{t('本次分摊（元）','This request (CNY)')} {d.expenses.rmbPerRequest?.toFixed(4)??'—'} · {t('月服务器预算 / 月媒体请求预算','Monthly server / media request budget')} {d.expenses.monthlyServerRmb??'—'} / {d.expenses.monthlyMediaRequests??'—'} · {t('预算口径，不代表已实现净利','Budget allocation; not realized profit')}</p>}
  {r.upstreamCost?.detail?.pricing&&<p className={r.upstreamCost.detail.pricing.shortfallPoints>0?'admin-error':'admin-footnote'}>{t('视频定价对账','Video pricing settlement')}：{t('每秒净利目标','Net target / output second')} {r.upstreamCost.detail.pricing.markupPerSecond} · {t('按用量应收','Usage-based charge')} {r.upstreamCost.detail.pricing.requiredPoints} · {t('预扣不足差额','Reservation shortfall')} {r.upstreamCost.detail.pricing.shortfallPoints} {t('积分','credits')} · {t('支付费 / 分摊成本 / 估算净利（元）','Payment fee / allocated costs / estimated net (CNY)')} {r.upstreamCost.detail.expenses?.paymentFeeConfigured ? r.upstreamCost.detail.pricing.paymentFeeRmb?.toFixed(4)??'—' : t('未配置','Unconfigured')} / {r.upstreamCost.detail.expenses?.allocationConfigured ? r.upstreamCost.detail.pricing.allocatedExpenseRmb?.toFixed(4)??'—' : t('未配置','Unconfigured')} / {r.upstreamCost.detail.pricing.estimatedNetRmb??t('成本未配置','Costs unconfigured')}</p>}
  {r.execution?.submissionUncertain&&<p className="admin-error">{t('提交结果待确认：保持原请求，不自动重新生成。','Submission awaiting confirmation; keep the original request.')}</p>}
  {r.error&&<p className="admin-error">{r.error}</p>}
  <h3>{t('提示词','Prompt')}</h3><p className="record-prompt">{r.prompt}</p>
  <h3>{t('积分流水（本次请求）','Credit ledger for this request')}</h3>
  {r.ledger?.length?<div className="admin-table-wrap"><table><thead><tr><th>{t('时间','Time')}</th><th>{t('原因','Reason')}</th><th>{t('变化','Change')}</th></tr></thead><tbody>{r.ledger.map((item,i)=><tr key={i}><td>{date(item.created_at)}</td><td>{item.reason}</td><td>{item.delta}</td></tr>)}</tbody></table></div>:<p>{t('没有积分流水','No credit ledger entries')}</p>}
  {r.video&&<section className="admin-video-result"><h3>{t('视频结果与留存','Video result and persistence')}</h3>
   <p>{r.persisted?.exists?t('留存文件存在','Stored file exists'):t('留存文件未找到','Stored file missing')} · {r.persisted?.path||'—'} · {r.persisted?.size==null?'—':`${(r.persisted.size/1048576).toFixed(2)} MiB`}</p>
   {r.persisted?.exists&&<><video controls preload="metadata" src={media}/><a href={`${media}?download=1`}>{t('下载留存视频','Download stored video')}</a></>}
   {r.persisted?.reason&&<p className="admin-error">{r.persisted.reason}</p>}
   <p>{t('上游报告尺寸 / 时长','Provider dimensions / duration')}：{r.video.width&&r.video.height?`${videoSizeLabel(r.video.width,r.video.height)}（${r.video.width} × ${r.video.height}）`:'—'} / {r.video.duration??'—'} s</p>
   <div className="table-actions"><button disabled={busy||!r.persisted?.exists} onClick={()=>action('probe')}>{t('读取实际视频参数','Probe actual video parameters')}</button>{r.status==='succeeded'&&<button disabled={busy} onClick={()=>action('restore')}>{t('核对留存 / 按原请求取回','Check persistence / restore original result')}</button>}</div>
   {probe&&<p role="status">{t('实际留存视频','Actual stored video')}：{probe.width} × {probe.height} · {probe.duration} s · {probe.codec} · {probe.audio?t('含音轨','Audio track present'):t('无音轨','No audio track')}</p>}
   <h4>{t('画布读取观察','Canvas observations')}</h4>{r.canvas?.length?r.canvas.map(item=><p key={item.path}>{item.path} · {t('节点','Node')} {item.nodeId} · {item.containsVideoPath?t('节点包含视频路径','Node contains video path'):t('节点未包含该视频路径','Node does not contain this video path')} · {item.latestRequestMatches?t('记录关联原请求','Original request linked'):t('未找到原请求标识','Original request ID not found')}</p>):<p>{t('未在该项目根目录的可读取画布中找到对应节点；不能据此判定视频丢失。','No matching node was found in readable root canvases of this project; this does not establish media loss.')}</p>}
  </section>}
  {error&&<p role="alert" className="admin-error">{error}</p>}
  <div className="admin-result-grid">{r.images?.map((image,i)=><div key={image.url}><img src={image.url} alt={t(`生成结果 ${i+1}`,`Generated result ${i+1}`)}/><a href={image.url} download>{t('下载留存图片','Download stored image')}</a></div>)}</div>
  <details><summary>{t('请求参数、用量和成本依据（链接已脱敏）','Parameters, usage and cost basis (links redacted)')}</summary><pre>{JSON.stringify({parameters:r.parameters,usage:r.usage,upstreamCost:r.upstreamCost},null,2)}</pre></details>
 </div>
}
