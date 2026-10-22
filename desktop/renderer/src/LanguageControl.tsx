import { LANG_OPTIONS, useLang } from './i18n'

export default function LanguageControl({ compact = false }) {
  const { lang, setLang, t } = useLang()
  return (
    <div className={`language-control${compact ? ' is-compact' : ''}`} role="group" aria-label={t('lang.label')}>
      {LANG_OPTIONS.map((option) => (
        <button key={option.code} type="button" aria-pressed={lang === option.code} onClick={() => setLang(option.code)}>
          {option.short}
        </button>
      ))}
    </div>
  )
}
