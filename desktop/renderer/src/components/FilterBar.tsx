// @ts-nocheck
import {
  FunnelSimple,
  SortAscending,
  SortDescending,
  X,
} from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { useLang } from '../i18n'
import SelectMenu from './ui/SelectMenu'

const CHIP_LIMIT = 8
const TAG_CHIP_LIMIT = 10

function formatCount(count) {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count)
}

// 筛选栏按"排序 / 工具 / 标签"分组，每组一个组名 + 一排胶囊。
export default function FilterBar({
  popularTools,
  tools,
  selectedTool,
  onToolChange,
  popularTags = [],
  tags = [],
  selectedTag,
  onTagChange,
  sortOrder,
  onSortChange,
  resultCount,
  hasActiveFilters,
  onReset,
  disabled,
}) {
  const { t, locale } = useLang()
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false)
  const [mobileDraft, setMobileDraft] = useState({
    tool: selectedTool,
    tag: selectedTag,
    sort: sortOrder,
  })
  const chipTools = popularTools.slice(0, CHIP_LIMIT)
  const chipTags = popularTags.slice(0, TAG_CHIP_LIMIT)
  const selectedInChips = !selectedTool || chipTools.some(({ tool }) => tool === selectedTool)
  const selectedTagInChips = !selectedTag || chipTags.some(({ tagValue }) => tagValue === selectedTag)
  const selectedTagLabel = tags.find((tag) => tag.value === selectedTag)?.label || selectedTag
  const activeFilterCount = [selectedTool, selectedTag, sortOrder === 'oldest']
    .filter(Boolean).length
  const formattedCount = new Intl.NumberFormat(locale).format(resultCount)

  useEffect(() => {
    if (!mobileFiltersOpen) return undefined
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [mobileFiltersOpen])

  function openMobileFilters() {
    setMobileDraft({ tool: selectedTool, tag: selectedTag, sort: sortOrder })
    setMobileFiltersOpen(true)
  }

  function applyMobileFilters() {
    onToolChange(mobileDraft.tool)
    onTagChange(mobileDraft.tag)
    onSortChange(mobileDraft.sort)
    setMobileFiltersOpen(false)
  }

  return (
    <>
    <section className="glass-bar lib-toolbar sticky top-0 z-30" aria-label={t('filter.mobileTitle')}>
      <div className="lib-toolbar__inner">
        <div className="lib-toolbar__mobile">
          <p className="lib-toolbar__count" aria-live="polite">
            <strong>{formatCount(resultCount)}</strong>
            <span>{t('filter.mobileResults')}</span>
          </p>

          {hasActiveFilters && (
            <button type="button" onClick={onReset} className="lib-toolbar__reset focus-ring">
              {t('filter.clearAll')}
            </button>
          )}

          <button
            type="button"
            onClick={openMobileFilters}
            aria-expanded={mobileFiltersOpen}
            className="lib-toolbar__filter-btn focus-ring"
            data-active={activeFilterCount > 0}
          >
            <FunnelSimple size={14} weight={activeFilterCount > 0 ? 'fill' : 'regular'} />
            {t('filter.mobileFilters')}
            {activeFilterCount > 0 && <span className="lib-toolbar__badge">{activeFilterCount}</span>}
          </button>
        </div>

        <div className="lib-toolbar__desktop">
          <div className="lib-filter-row">
            <span className="lib-filter-row__label">{t('filter.mobileSort')}</span>
            <div className="lib-seg">
              <SortButton
                active={sortOrder === 'newest'}
                onClick={() => onSortChange('newest')}
                label={t('filter.sort.newest')}
                icon={SortDescending}
                disabled={disabled}
              />
              <SortButton
                active={sortOrder === 'oldest'}
                onClick={() => onSortChange('oldest')}
                label={t('filter.sort.oldest')}
                icon={SortAscending}
                disabled={disabled}
              />
            </div>


            <p className="lib-toolbar__result" aria-live="polite" aria-atomic="true">
              <strong>{formattedCount}</strong>
              {t('filter.results').replace('{n}', '')}
            </p>
          </div>

          <div className="lib-filter-row">
            <span className="lib-filter-row__label">{t('filter.mobileTool')}</span>
            <div className="chip-row lib-filter-row__chips">
              <button type="button" className="chip focus-ring" data-active={!selectedTool} onClick={() => onToolChange('')} disabled={disabled}>
                {t('filter.allTools')}
              </button>
              {chipTools.map(({ tool, count }) => (
                <button
                  key={tool}
                  type="button"
                  className="chip focus-ring"
                  data-active={selectedTool === tool}
                  onClick={() => onToolChange(selectedTool === tool ? '' : tool)}
                  disabled={disabled}
                >
                  {tool}
                  <span className="chip-count">{formatCount(count)}</span>
                </button>
              ))}
            </div>

            {tools.length > CHIP_LIMIT && (
              <div className="lib-filter-row__more">
                <SelectMenu
                  compact
                  value={selectedInChips ? '' : selectedTool}
                  options={tools}
                  onChange={onToolChange}
                  emptyLabel={t('filter.moreTools')}
                  resetLabel={t('filter.allTools')}
                  searchable
                  searchPlaceholder={t('filter.searchTools')}
                  disabled={disabled}
                />
              </div>
            )}
          </div>

          {tags.length > 0 && (
            <div className="lib-filter-row">
              <span className="lib-filter-row__label">{t('filter.mobileTag')}</span>
              <div className="chip-row lib-filter-row__chips">
                <button type="button" className="chip focus-ring" data-active={!selectedTag} onClick={() => onTagChange('')} disabled={disabled}>
                  {t('filter.allTags')}
                </button>
                {chipTags.map(({ tagValue, label, count }) => (
                  <button
                    key={tagValue}
                    type="button"
                    className="chip focus-ring"
                    data-active={selectedTag === tagValue}
                    onClick={() => onTagChange(selectedTag === tagValue ? '' : tagValue)}
                    disabled={disabled}
                  >
                    {label || tagValue}
                    <span className="chip-count">{formatCount(count)}</span>
                  </button>
                ))}
              </div>

              {tags.length > TAG_CHIP_LIMIT && (
                <div className="lib-filter-row__more">
                  <SelectMenu
                    compact
                    value={selectedTagInChips ? '' : selectedTag}
                    options={tags}
                    onChange={onTagChange}
                    emptyLabel={t('filter.moreTags')}
                    resetLabel={t('filter.allTags')}
                    searchable
                    searchPlaceholder={t('filter.searchTags')}
                    disabled={disabled}
                  />
                </div>
              )}
            </div>
          )}

          {hasActiveFilters && (
            <div className="lib-filter-row lib-filter-row--active">
              <span className="lib-filter-row__label">{t('filter.active')}</span>
              <div className="flex flex-wrap items-center gap-2">
                {selectedTool && <FilterToken>{selectedTool}</FilterToken>}
                {selectedTag && <FilterToken>{selectedTagLabel}</FilterToken>}
                {sortOrder === 'oldest' && <FilterToken>{t('filter.oldestFirst')}</FilterToken>}
                <button
                  type="button"
                  onClick={onReset}
                  className="focus-ring rounded-full px-2.5 py-1 font-medium text-brass transition-colors hover:bg-brass-soft"
                >
                  {t('filter.clearAll')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
    <AnimatePresence>
      {mobileFiltersOpen && (
        <MobileFilterSheet
          draft={mobileDraft}
          setDraft={setMobileDraft}
          tools={tools}
          tags={tags}
          onClose={() => setMobileFiltersOpen(false)}
          onApply={applyMobileFilters}
          disabled={disabled}
        />
      )}
    </AnimatePresence>
    </>
  )
}

function MobileFilterSheet({ draft, setDraft, tools, tags, onClose, onApply, disabled }) {
  const { t } = useLang()
  const hasDraftFilters = Boolean(draft.tool || draft.tag || draft.sort === 'oldest')

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label={t('filter.mobileTitle')}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 md:hidden"
    >
      <button type="button" className="absolute inset-0 bg-black/70" onClick={onClose} aria-label={t('filter.mobileClose')} />
      <motion.div
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', stiffness: 360, damping: 34 }}
        className="absolute inset-x-0 bottom-0 max-h-[82dvh] overflow-hidden rounded-t-[20px] border-t border-line-strong bg-canvas shadow-[0_-24px_80px_-30px_rgba(0,0,0,0.95)]"
      >
        <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-line-strong" aria-hidden="true" />
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <div>
            <p className="text-base font-semibold text-ink">{t('filter.mobileTitle')}</p>
            <p className="mt-0.5 text-[11px] text-muted">{t('filter.mobileSubtitle')}</p>
          </div>
          <button type="button" onClick={onClose} className="focus-ring grid size-10 place-items-center rounded-full bg-elevate text-body" aria-label={t('filter.mobileClose')}>
            <X size={16} />
          </button>
        </div>

        <div className="custom-scrollbar max-h-[calc(82dvh-9rem)] space-y-5 overflow-y-auto px-5 py-5">
          <fieldset>
            <legend className="lib-filter-row__label mb-2.5">{t('filter.mobileSort')}</legend>
            <div className="grid grid-cols-2 gap-2">
              <MobileChoice active={draft.sort === 'newest'} onClick={() => setDraft((value) => ({ ...value, sort: 'newest' }))} icon={SortDescending}>
                {t('filter.sort.newest')}
              </MobileChoice>
              <MobileChoice active={draft.sort === 'oldest'} onClick={() => setDraft((value) => ({ ...value, sort: 'oldest' }))} icon={SortAscending}>
                {t('filter.sort.oldest')}
              </MobileChoice>
            </div>
          </fieldset>

          <MobileField label={t('filter.mobileTool')}>
            <SelectMenu
              value={draft.tool}
              options={tools}
              onChange={(tool) => setDraft((value) => ({ ...value, tool }))}
              emptyLabel={t('filter.allTools')}
              resetLabel={t('filter.allTools')}
              searchable
              searchPlaceholder={t('filter.searchTools')}
              disabled={disabled}
            />
          </MobileField>


          {tags.length > 0 && (
            <MobileField label={t('filter.mobileTag')}>
              <SelectMenu
                value={draft.tag}
                options={tags}
                onChange={(tag) => setDraft((value) => ({ ...value, tag }))}
                emptyLabel={t('filter.allTags')}
                resetLabel={t('filter.allTags')}
                searchable
                searchPlaceholder={t('filter.searchTags')}
                disabled={disabled}
              />
            </MobileField>
          )}
        </div>

        <div className="grid grid-cols-[0.8fr_1.4fr] gap-2 border-t border-line bg-canvas/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
          <button
            type="button"
            disabled={!hasDraftFilters}
            onClick={() => setDraft({ tool: '', tag: '', sort: 'newest' })}
            className="focus-ring h-12 rounded-full border border-line text-sm font-medium text-body disabled:opacity-35"
          >
            {t('filter.clearAll')}
          </button>
          <button type="button" onClick={onApply} className="focus-ring h-12 rounded-full bg-brass text-sm font-semibold text-[#17140f]">
            {t('filter.mobileApply')}
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}

function MobileField({ label, children }) {
  return (
    <div>
      <p className="lib-filter-row__label mb-2.5">{label}</p>
      {children}
    </div>
  )
}

function MobileChoice({ active, onClick, icon: Icon, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`focus-ring inline-flex h-12 items-center justify-center gap-2 rounded-full border text-sm font-medium ${
        active ? 'border-brass bg-brass text-[#17140f]' : 'border-line bg-elevate text-body'
      }`}
    >
      <Icon size={16} />
      {children}
    </button>
  )
}

function SortButton({ active, onClick, label, icon: Icon, disabled }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      className="lib-seg__btn focus-ring"
      data-active={active}
    >
      <Icon size={14} />
      {label}
    </button>
  )
}

function FilterToken({ children }) {
  return (
    <span className="rounded-full bg-brass-soft px-2.5 py-1 font-medium text-brass-strong">{children}</span>
  )
}
