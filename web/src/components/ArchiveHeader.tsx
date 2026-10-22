import { LANG_OPTIONS, useLang } from '../i18n'
import LibrarySearch from './LibrarySearch'

const STAT_KEYS = ['prompts', 'images', 'videos']

function LangSwitch() {
  const { lang, setLang, t } = useLang()
  return (
    <div className="lib-lang" role="group" aria-label={t('lang.label')}>
      {LANG_OPTIONS.map((option) => (
        <button
          key={option.code}
          type="button"
          onClick={() => setLang(option.code)}
          aria-pressed={lang === option.code}
          aria-label={option.label}
          className="focus-ring"
        >
          {option.short}
        </button>
      ))}
    </div>
  )
}

function HeroStats({ stats, loading }) {
  const { t, locale } = useLang()
  const format = new Intl.NumberFormat(locale)
  return (
    <dl className="lib-stats">
      {STAT_KEYS.map((key) => (
        <div className="lib-stat" key={key}>
          <dt className="lib-stat__label">{t(`hero.stats.${key}`)}</dt>
          <dd className="lib-stat__value">
            {loading ? '…' : format.format(Number(stats?.[key]) || 0)}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export default function ArchiveHeader({
  stats,
  loading,
  query,
  queryDirty,
  onQueryChange,
  onQuerySubmit,
  onQueryClear,
  searchInputRef,
  searchDisabled,
}) {
  const { t } = useLang()
  // 从画布跳过来的用户需要一条明确的回路；直接访问灵感库时仍是"打开画布"入口。
  const fromCanvas = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('from') === 'canvas'
  const canvasLabel = t(fromCanvas ? 'nav.backToCanvas' : 'nav.openCanvas')

  return (
    <header className="lib-hero">
      <div className="lib-hero__inner">
        <nav className="lib-nav" aria-label={t('nav.label')}>
          <a href="/?library=1" className="lib-brand focus-ring">
            <img src="/miaoimg-logo.png" alt="" width="30" height="30" />
            <span>妙图 <small>MiaoImg</small></span>
          </a>

          <div className="lib-nav__actions">
            <span className="lib-nav__status">{t('nav.status')}</span>
            <a href="/" className="lib-cta focus-ring">{canvasLabel}</a>
            <LangSwitch />
          </div>
        </nav>

        <div className="lib-hero__body">
          <p className="lib-eyebrow">
            <span className="status-pulse" aria-hidden="true" />
            {t('hero.eyebrow.suffix')}
          </p>
          <h1 className="lib-hero__title">{t('hero.title')}</h1>
          <p className="lib-hero__lede">{t('hero.description')}</p>

          <LibrarySearch
            query={query}
            queryDirty={queryDirty}
            onQueryChange={onQueryChange}
            onQuerySubmit={onQuerySubmit}
            onQueryClear={onQueryClear}
            searchInputRef={searchInputRef}
            disabled={searchDisabled}
          />

          <HeroStats stats={stats} loading={loading} />
        </div>
      </div>
    </header>
  )
}
