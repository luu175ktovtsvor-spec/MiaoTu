import { randomUUID } from 'node:crypto'
import { ownTextModelById } from './text-model-registry.ts'

const valid = value => Number.isSafeInteger(value) && value >= 0
// Only actual provider receipts establish tokens. Cache counters are subsets
// of total input; reasoning is already included in output and is not added again.
export function textReceipt(protocol, raw) {
  if (!raw) return null
  let input = raw.input_tokens ?? raw.prompt_tokens
  const output = raw.output_tokens ?? raw.completion_tokens
  const cacheRead = raw.input_tokens_details?.cached_tokens ?? raw.prompt_tokens_details?.cached_tokens ?? raw.cache_read_input_tokens ?? raw.prompt_cache_hit_tokens ?? 0
  const cacheWrite = raw.cache_creation_input_tokens ?? 0
  if (protocol === 'anthropic-messages' && valid(input) && valid(cacheRead) && valid(cacheWrite)) input += cacheRead + cacheWrite
  if (![input,output,cacheRead,cacheWrite].every(valid) || cacheRead + cacheWrite > input) return null
  const reasoning = raw.output_tokens_details?.reasoning_tokens ?? raw.completion_tokens_details?.reasoning_tokens
  return { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, reasoningTokens: valid(reasoning) ? reasoning : null }
}

// A transparent reader observes a bounded frame at a time. It never buffers
// the whole conversation, changes bytes, retries inference or infers tokens.
export function createTextMeter({ management, session, source, operationId, fetchImpl = fetch }: Record<string, any>) {
  const operation = operationId || randomUUID()
  const requestFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    const payload = JSON.parse(await request.clone().text())
    const model = ownTextModelById(payload.model)
    if (!model) throw Object.assign(new Error('文本模型不可用'), { status: 422 })
    const id = randomUUID(), started = Date.now()
    // This is only a hold estimate. It does not set a model output limit.
    const estimateInput = Math.ceil(JSON.stringify(payload).length / 4)
    const output = payload.max_output_tokens || payload.max_completion_tokens || payload.max_tokens
    management.reserveText({ session, model:model.id, requestId:id, operationId:operation, source, inputTokens:estimateInput, outputTokens:output })
    let httpStatus = 0, upstreamRequestId = '', responseId = '', firstTokenMs: number = null
    let receipt = null, rejected = false, ended = false, invocationStatus = 'unknown', providerError = ''
    const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value) ? value : ''
    const finish = (error?: any) => {
      if (ended) return
      ended = true
      try { management.textBilling.metadata(id, { upstreamRequestId,responseId,httpStatus,durationMs:Date.now()-started,firstTokenMs }) }
      catch { console.error('[text] Request metadata write pending',id) }
      try {
      if (receipt) management.textBilling.settle(id,{ ...receipt,invocationStatus })
      else if (rejected) management.textBilling.fail(id,providerError || `上游拒绝 HTTP ${httpStatus}`)
      else {
        const unsubmitted = !httpStatus && ['UND_ERR_CONNECT_TIMEOUT','ECONNREFUSED','ENOTFOUND','EAI_AGAIN'].includes(error?.cause?.code || error?.code)
        if (unsubmitted) management.textBilling.fail(id,'连接建立前失败，已退还预扣')
        else management.textBilling.review(id, error?.name === 'AbortError' ? '调用取消，未取得最终用量，待核对' : providerError || '未取得可核对的最终用量，待核对')
      }
      } catch {
        // Preserve delivered model bytes and the original hold on a DB failure.
        // Never turn an accounting failure into an implicit refund or retry.
        console.error('[text] Settlement write pending',id)
        try { management.textBilling.review(id,'用量结算写入未完成，保留预扣待核对') } catch {}
      }
    }
    let anthropic: Record<string,any> = {}
    const observe = event => {
      if (!event || typeof event !== 'object') return
      responseId = safeId(event.response?.id || event.id || event.message?.id) || responseId
      if (firstTokenMs === null && (event.type?.endsWith('delta') && event.delta || event.choices?.some(c=>c.delta?.content || c.delta?.reasoning_content))) firstTokenMs=Date.now()-started
      let usage = null
      if (model.protocol === 'openai-responses' && ['response.completed','response.incomplete','response.failed'].includes(event.type)) {
        usage = event.response?.usage
        invocationStatus = event.type === 'response.completed' ? 'succeeded' : event.type === 'response.incomplete' ? 'limited' : 'failed'
        if (event.type === 'response.failed') providerError = '模型返回失败终态'
      } else if (model.protocol === 'openai-completions' && event.usage && (!event.choices?.length || event.choices.some(c=>c.finish_reason))) {
        usage = event.usage
        invocationStatus = event.choices?.some(c=>c.finish_reason==='length') ? 'limited' : 'succeeded'
      } else if (model.protocol === 'anthropic-messages') {
        if (event.type === 'message_start') anthropic = { ...event.message?.usage }
        if (event.type === 'message_delta') { anthropic = { ...anthropic,...event.usage }; if (event.delta?.stop_reason) { usage=anthropic;invocationStatus=event.delta.stop_reason==='max_tokens'?'limited':'succeeded' } }
      }
      if (usage) receipt = textReceipt(model.protocol,usage)
      if (event.type === 'error' || event.error) { providerError = '模型返回错误';invocationStatus='failed' }
      // Synchronous endpoints have the same authoritative usage object.
      if ((!event.type || event.type==='message' && event.stop_reason) && event.usage) { receipt=textReceipt(model.protocol,event.usage);invocationStatus=httpStatus>=400 || event.status==='failed' || event.error?'failed':event.status==='incomplete' || event.stop_reason==='max_tokens'?'limited':'succeeded' }
    }
    try {
      request.headers.set('X-Client-Request-ID',id)
      // This explicit identifier can be matched by gateway usage, without
      // passing a user's email or the full local conversation to the gateway.
      request.headers.set('X-Session-ID',id)
      management.textBilling.dispatched(id)
      const upstream = await fetchImpl(request)
      httpStatus=upstream.status
      upstreamRequestId=safeId(upstream.headers.get('x-request-id') || upstream.headers.get('request-id'))
      rejected=httpStatus>=400 && httpStatus<500 && ![408,409].includes(httpStatus)
      if (!upstream.body) { finish(); return upstream }
      const isSse = /text\/event-stream/i.test(upstream.headers.get('content-type') || '')
      const reader=upstream.body.getReader(),decoder=new TextDecoder()
      let buffer='', overflow=false
      const consume = (chunk?: Uint8Array, final=false) => {
        buffer+=decoder.decode(chunk,{stream:!final})
        if (isSse) {
          let split
          while ((split=/\r?\n\r?\n/.exec(buffer))) {
            const frame=buffer.slice(0,split.index);buffer=buffer.slice(split.index+split[0].length)
            if (!overflow) { const data=frame.split(/\r?\n/).filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n');if(data && data!=='[DONE]')try{observe(JSON.parse(data))}catch{} }
            overflow=false
          }
          if (buffer.length>2*1024*1024) { buffer='';overflow=true }
          if (final && buffer.trim() && !overflow) { const data=buffer.split(/\r?\n/).filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n');try{observe(JSON.parse(data))}catch{} }
        } else if (buffer.length>5*1024*1024) { buffer='';overflow=true }
        else if (final && !overflow) try{observe(JSON.parse(buffer))}catch{}
      }
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next=await reader.read()
            if(next.done){consume(undefined,true);finish();controller.close();reader.releaseLock()}
            else {consume(next.value);controller.enqueue(next.value)}
          } catch(error){try{finish(error)}finally{controller.error(error);reader.releaseLock()}}
        },
        async cancel(reason){try{finish(reason)}finally{await reader.cancel(reason);reader.releaseLock()}},
      })
      const headers=new Headers(upstream.headers)
      headers.set('x-miao-text-request-id',id)
      return new Response(body,{status:upstream.status,statusText:upstream.statusText,headers})
    } catch(error){finish(error);throw error}
  }
  return { fetch:requestFetch,operationId:operation,summary:()=>management.textBilling.operation(operation) }
}
