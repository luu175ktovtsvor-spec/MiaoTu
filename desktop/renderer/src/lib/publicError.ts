import { normalizeUserErrorCopy, userFacingError } from '../../../../server/user-errors.ts'
import { getLocale, isKnownTranslation, translate, type Locale } from '../studio/canvas/i18n'

const GENERIC = '操作失败，请重试'

// Keep obsolete localized cloud errors compatible without displaying support boilerplate.
export function publicErrorCopy(message: string, language: Locale = getLocale()) {
  const localized = normalizeUserErrorCopy(message, key => translate(key, undefined, language))
  const text = normalizeUserErrorCopy(localized, key => translate(key, undefined, 'en'))
  const billing = /^本次已扣 ([0-9]+(?:\.[0-9]+)?) 积分。$/.exec(text)
  return billing ? translate('本次已扣 {0} 积分。', { 0: Number(billing[1]) }, language) : translate(text, undefined, language)
}

// userFacingError keeps actionable Chinese copy and redacts everything else.
// Copy the UI already translated into another language is ours too: keep it
// only when it matches an application dictionary entry with controlled numeric parameters. Unknown diagnostics
// still pass through redaction, then the safe summary follows the interface language.
export function publicError(message: unknown, options?: Record<string, unknown>, language: Locale = getLocale()) {
  const text = String((message as { message?: unknown })?.message || message || '').trim()
  const safe = userFacingError(text, options)
  if (safe === GENERIC && text && language !== 'zh-CN' && isKnownTranslation(text, language)) return publicErrorCopy(text, language)
  return publicErrorCopy(safe, language)
}
