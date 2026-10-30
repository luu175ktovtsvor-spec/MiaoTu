import { userFacingError } from '../../../../server/user-errors.ts'
import { getLocale, isKnownTranslation, translate, type Locale } from '../studio/canvas/i18n'

const GENERIC = '当前操作未能完成，请稍后重试或联系妙图团队'

// userFacingError keeps actionable Chinese copy and redacts everything else.
// Copy the UI already translated into another language is ours too: keep it
// only when it matches an application dictionary entry with controlled numeric parameters. Unknown diagnostics
// still pass through redaction, then the safe summary follows the interface language.
export function publicError(message: unknown, options?: Record<string, unknown>, language: Locale = getLocale()) {
  const text = String((message as { message?: unknown })?.message || message || '').trim()
  const safe = userFacingError(text, options)
  if (safe === GENERIC && text && language !== 'zh-CN' && isKnownTranslation(text, language)) return text
  return translate(safe, undefined, language)
}
