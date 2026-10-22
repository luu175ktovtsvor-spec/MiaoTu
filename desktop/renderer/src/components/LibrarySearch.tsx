// @ts-nocheck
import { MagnifyingGlass, X } from '@phosphor-icons/react'
import { useRef } from 'react'
import { useLang } from '../i18n'

// 搜索框是首屏的一部分，不再塞在筛选条里。
export default function LibrarySearch({
  query,
  queryDirty,
  onQueryChange,
  onQuerySubmit,
  onQueryClear,
  searchInputRef,
  disabled,
}) {
  const { t } = useLang()
  const composingRef = useRef(false)

  return (
    <form
      role="search"
      className="lib-search"
      onSubmit={(event) => {
        event.preventDefault()
        if (!composingRef.current) onQuerySubmit()
      }}
    >
      <MagnifyingGlass size={17} className="lib-search__icon" aria-hidden="true" />
      <input
        ref={searchInputRef}
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onCompositionStart={() => {
          composingRef.current = true
        }}
        onCompositionEnd={() => {
          composingRef.current = false
        }}
        onKeyDown={(event) => {
          if (
            event.key === 'Enter'
            && (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229)
          ) {
            event.preventDefault()
          }
          if (event.key === 'Escape' && query) {
            event.preventDefault()
            onQueryClear()
          }
        }}
        enterKeyHint="search"
        disabled={disabled}
        placeholder={t('filter.search.placeholder')}
        aria-describedby={queryDirty ? 'search-pending-hint' : undefined}
        className="lib-search__input"
      />
      {query && (
        <button
          type="button"
          onClick={onQueryClear}
          className="lib-search__clear focus-ring"
          aria-label={t('filter.search.clear')}
        >
          <X size={13} />
        </button>
      )}
      <button
        type="submit"
        disabled={disabled || !queryDirty}
        aria-label={t('filter.search.submit')}
        className="lib-search__submit focus-ring"
      >
        <MagnifyingGlass size={15} weight="bold" />
        <span className="lib-search__submit-label">{t('filter.search.submit')}</span>
      </button>
      <span id="search-pending-hint" className="sr-only" aria-live="polite">
        {queryDirty ? t('filter.search.pending') : ''}
      </span>
    </form>
  )
}
