import { LANG_OPTIONS, useLang } from './i18n'

// 21 种界面语言的下拉：当前值就是当前语言的原生名称；选择会写回画布设置，画布与外壳始终说同一种语言。
export default function LanguageControl({ compact = false }) {
  const { lang, setLang, t } = useLang()
  return (
    <div className={`language-control${compact ? ' is-compact' : ''}`}>
      <select value={lang} aria-label={t('lang.label')} onChange={(event) => setLang(event.target.value as typeof lang)}>
        {LANG_OPTIONS.map((option) => (
          <option key={option.code} value={option.code}>{option.name}</option>
        ))}
      </select>
    </div>
  )
}
