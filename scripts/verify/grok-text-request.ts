#!/usr/bin/env node

import { createTextCompletion, textModelById, textSettings, validateTextRequest } from '../../server/text-models.ts'

const modelId = String(process.argv[2] || 'grok-4.5').trim()
const prompt = String(process.argv.slice(3).join(' ') || 'Reply with exactly: grok probe ok').trim()
const startedAt = Date.now()
let observed = null

function print(value) {
  process.stdout.write(`${value}\n`)
}

try {
  const model = await textModelById(modelId)
  if (!model) throw new Error(`不支持的文本模型：${modelId}`)
  const config = textSettings(process.env, modelId)
  print(`[grok-probe] model=${model.id}`)
  print(`[grok-probe] protocol=${model.protocol} maxTokensField=${model.fields.output} reasoning=${model.reasoningEffort || '(none)'}`)
  print(`[grok-probe] key file=${config.keyFile || '(not found)'}`)
  print(`[grok-probe] base URL=${config.baseUrl}`)

  const request = await validateTextRequest({ model: modelId, prompt, maxTokens: 64 }, process.env)
  const result = await createTextCompletion(request, {
    fetchImpl: async (url, options) => {
      const body = JSON.parse(String(options.body || '{}'))
      print(`[grok-probe] request body=${JSON.stringify(body, null, 2)}`)
      const response = await fetch(url, options)
      const raw = await response.text()
      observed = { status: response.status, raw: raw.slice(0, 800) }
      return { ok: response.ok, status: response.status, text: async () => raw }
    },
  })
  print(`[grok-probe] HTTP status=${observed?.status || 200}`)
  print(`[grok-probe] response prefix=${JSON.stringify(observed?.raw || JSON.stringify(result).slice(0, 800))}`)
  print(`[grok-probe] elapsed_ms=${Date.now() - startedAt}`)
  print('[grok-probe] conclusion=请求已被网关接受；若状态为 200，response 应含 choices[0].message.content 与 usage。')
} catch (error) {
  const status = observed?.status || error?.upstreamStatus || error?.status || 0
  print(`[grok-probe] HTTP status=${status || '(no request)'}`)
  if (observed?.raw) print(`[grok-probe] response prefix=${JSON.stringify(observed.raw)}`)
  print(`[grok-probe] elapsed_ms=${Date.now() - startedAt}`)
  print(`[grok-probe] error=${String(error?.message || error)}`)
  if (status === 503 && /service temporarily unavailable|account_select_failed|额度|账号/i.test(`${observed?.raw || ''} ${error?.message || ''}`)) {
    print('[grok-probe] conclusion=503 来自 Grok 账号额度/账号选择失败，不是请求格式；同一 body 若格式错会由网关返回 400，错模型名会返回 404 model_not_found。')
  } else if (status === 503) {
    print('[grok-probe] conclusion=503；请检查响应体是否为 Service temporarily unavailable/account_select_failed，以确认是额度而非格式。')
  }
  process.exitCode = 1
}
