// Compatible providers may return a string or several text blocks. Choose one
// protocol representation so convenience fields cannot duplicate its content.
function completionResult(data: any, protocol: string) {
  const blocks = (value: unknown) => Array.isArray(value)
    ? value.map(piece => typeof piece?.text === 'string' ? piece.text : '').join('') : ''
  const message = data?.choices?.[0]?.message?.content
  const chat = typeof message === 'string' ? message : blocks(message)
  const responses = typeof data?.output_text === 'string' && data.output_text.trim() ? data.output_text
    : Array.isArray(data?.output) ? data.output.map(item => blocks(item?.content)).join('') : ''
  const anthropic = blocks(data?.content)
  const values: Record<string, string> = { 'openai-completions': chat, 'openai-responses': responses, 'anthropic-messages': anthropic }
  const order = protocol === 'openai-responses' ? ['openai-responses', 'openai-completions', 'anthropic-messages']
    : protocol === 'anthropic-messages' ? ['anthropic-messages', 'openai-responses', 'openai-completions']
    : ['openai-completions', 'openai-responses', 'anthropic-messages']
  return order.map(protocol => ({ protocol, text: values[protocol] })).find(value => value.text.trim())
}

export function completionText(data: any, protocol = 'openai-completions') {
  return completionResult(data, protocol)?.text.trim() || ''
}

// A 2xx body can contain partial text alongside a failed generation. Mirror
// the installed Pi adapters' explicit stop semantics without discarding the
// provider's real usage or presenting that partial answer as a success.
export function assertCompletionTerminal(data: any, protocol = 'openai-completions', upstreamStatus = 200) {
  const result = completionResult(data, protocol)
  const actualProtocol = result?.protocol || protocol
  const status = typeof data?.status === 'string' ? data.status.toLowerCase() : ''
  const chatStop = data?.choices?.[0]?.finish_reason
  const anthropicStop = data?.stop_reason
  const failedStops = ['content_filter', 'network_error', 'refusal', 'sensitive', 'failed', 'error', 'cancelled', 'canceled']
  let reason = '', incomplete = false
  if (data?.error || data?.type === 'error' || ['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
    reason = 'provider_error'
  } else if (failedStops.includes(chatStop) || failedStops.includes(anthropicStop)) {
    reason = failedStops.includes(chatStop) ? chatStop : anthropicStop
  } else if (status === 'incomplete' && data?.incomplete_details?.reason !== 'max_output_tokens') {
    reason = data?.incomplete_details?.reason === 'content_filter' ? 'content_filter' : 'incomplete_response'
    incomplete = reason !== 'content_filter'
  } else if (actualProtocol === 'openai-responses') {
    if (status && !['completed', 'incomplete'].includes(status)) {
      reason = 'nonterminal_response'; incomplete = true
    }
  } else {
    const stop = actualProtocol === 'anthropic-messages' ? anthropicStop : chatStop
    const success = actualProtocol === 'anthropic-messages'
      ? ['end_turn', 'max_tokens', 'tool_use', 'pause_turn', 'stop_sequence']
      : ['stop', 'end', 'length', 'function_call', 'tool_calls']
    if (stop !== undefined && stop !== null && stop !== '' && !success.includes(stop)) {
      reason = 'unknown_stop_reason'; incomplete = true
    }
  }
  if (!reason) return
  // Diagnostics use controlled labels only. Upstream error messages and
  // unknown stop strings can echo prompts, URLs or credentials.
  throw Object.assign(new Error(incomplete ? '文本响应尚未确认完整结束，未作为成功结果提交' : '文本模型报告生成未完成，未作为成功结果提交'), {
    status: 502, code: incomplete ? 'TEXT_COMPLETION_INCOMPLETE' : 'TEXT_COMPLETION_FAILED',
    upstreamStatus, usage: data?.usage ?? null, partialText: result?.text.trim() || '',
    completionState: incomplete ? 'incomplete' : 'failed', completionReason: reason, completionProtocol: actualProtocol,
  })
}
