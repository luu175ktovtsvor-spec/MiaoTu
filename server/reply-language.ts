/** Every system prompt sent to a text model ends with this, so replies follow the user's language. */
export const REPLY_LANGUAGE_RULE = '使用和用户相同的语言进行回复。'

/** Append the rule once; an empty prompt becomes just the rule. */
export function withReplyLanguage(systemPrompt?: string) {
  const text = String(systemPrompt || '').trim()
  return text.includes(REPLY_LANGUAGE_RULE) ? text : [text, REPLY_LANGUAGE_RULE].filter(Boolean).join('\n\n')
}
