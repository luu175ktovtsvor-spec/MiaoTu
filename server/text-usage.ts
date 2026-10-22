export type TextUsage = { input_tokens: number; output_tokens: number }
const tokenCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0

// SDK messages start with zero counters. Only a provider event carrying the
// required fields can prove usage; received text or an SDK default cannot.
export class TextUsageReceipt {
  value: TextUsage | undefined
  private anthropicInput: number | undefined
  private anthropicCacheRead: number | undefined = 0
  private anthropicCacheWrite: number | undefined = 0
  private protocol: string

  constructor(protocol: string) { this.protocol = protocol }
  observe(event: any) {
    if (!event || typeof event !== 'object') return
    if (this.protocol === 'openai-responses') {
      if (!['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) return
      const usage = event.response?.usage
      if (tokenCount(usage?.input_tokens) && tokenCount(usage?.output_tokens)) {
        this.value = { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens }
      }
      return
    }
    if (this.protocol === 'openai-completions') {
      // The final Chat usage chunk normally has no choices. Also accept the
      // compatible shape carrying usage on a choice with its finish_reason.
      const terminal = Array.isArray(event.choices) && (!event.choices.length || event.choices.some(choice => choice?.finish_reason))
      const usage = terminal ? event.usage || event.choices.find(choice => choice?.finish_reason)?.usage : null
      if (tokenCount(usage?.prompt_tokens) && tokenCount(usage?.completion_tokens)) {
        this.value = { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens }
      }
      return
    }
    if (this.protocol !== 'anthropic-messages') return
    const usage = event.type === 'message_start' ? event.message?.usage : event.type === 'message_delta' ? event.usage : null
    if (usage?.input_tokens !== undefined) this.anthropicInput = tokenCount(usage.input_tokens) ? usage.input_tokens : undefined
    if (usage?.cache_read_input_tokens !== undefined) this.anthropicCacheRead = tokenCount(usage.cache_read_input_tokens) ? usage.cache_read_input_tokens : undefined
    if (usage?.cache_creation_input_tokens !== undefined) this.anthropicCacheWrite = tokenCount(usage.cache_creation_input_tokens) ? usage.cache_creation_input_tokens : undefined
    if (event.type === 'message_delta' && event.delta?.stop_reason && this.anthropicInput !== undefined
      && this.anthropicCacheRead !== undefined && this.anthropicCacheWrite !== undefined && tokenCount(usage?.output_tokens)) {
      const input = this.anthropicInput + this.anthropicCacheRead + this.anthropicCacheWrite
      if (tokenCount(input)) this.value = { input_tokens: input, output_tokens: usage.output_tokens }
    }
  }
}
