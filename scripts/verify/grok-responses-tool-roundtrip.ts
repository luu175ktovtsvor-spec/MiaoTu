#!/usr/bin/env node

import { runtimeSecretSource } from '../../server/runtime-secrets.ts'
import { ownTextModelById } from '../../server/text-model-registry.ts'

const model = ownTextModelById('grok-4.5')
if (!model || model.protocol !== 'openai-responses') throw new Error('grok-4.5 未登记为 openai-responses')
const secret = runtimeSecretSource('GROK_API_KEY', process.env, { allowEnv: false })
if (!secret.value) throw new Error('找不到 GROK_API_KEY；期望服务器 secrets/grok-api-key')
const baseUrl = String(process.env.YUNSHU_BASE_URL || 'https://api.zzyppz.cn/v1').replace(/\/$/, '')
const tool = {
  type: 'function',
  name: 'get_value',
  description: '读取一个值',
  parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
}

async function call(body, label) {
  console.log(`[grok-responses] ${label} URL=${baseUrl}/responses`)
  console.log(`[grok-responses] ${label} body=${JSON.stringify(body)}`)
  const response = await fetch(`${baseUrl}/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret.value}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const raw = await response.text()
  console.log(`[grok-responses] ${label} HTTP=${response.status}`)
  console.log(`[grok-responses] ${label} response=${raw.slice(0, 2000)}`)
  if (!response.ok) throw Object.assign(new Error(`上游 HTTP ${response.status}`), { status: response.status })
  return JSON.parse(raw)
}

try {
  const first = await call({
    model: model.id,
    input: [{ role: 'user', content: '请调用 get_value，读取 probe。' }],
    max_output_tokens: 512,
    reasoning: { effort: model.reasoningEffort },
    tools: [tool],
    parallel_tool_calls: true,
    tool_choice: 'auto',
  }, 'first')
  const callItem = (first.output || []).find(item => item?.type === 'function_call')
  if (!callItem) throw new Error('第一轮没有返回 function_call')
  const args = JSON.parse(callItem.arguments || '{}')
  const result = { key: args.key, value: 42 }
  const second = await call({
    model: model.id,
    input: [{ type: 'function_call_output', call_id: callItem.call_id, output: JSON.stringify(result) }],
    previous_response_id: first.id,
    max_output_tokens: 512,
    reasoning: { effort: model.reasoningEffort },
    tools: [tool],
    parallel_tool_calls: true,
    tool_choice: 'auto',
  }, 'second')
  const text = (second.output || []).flatMap(item => item?.content || []).find(item => item?.type === 'output_text')?.text || second.output_text || ''
  console.log(`[grok-responses] tool result=${JSON.stringify(result)}`)
  console.log(`[grok-responses] final text=${JSON.stringify(text)}`)
} catch (error) {
  console.error(`[grok-responses] conclusion=上游拒绝或协议失败：${error.message}`)
  process.exitCode = 1
}
