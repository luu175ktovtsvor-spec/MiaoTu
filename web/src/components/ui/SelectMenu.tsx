import { CaretDown, Check, MagnifyingGlass } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'framer-motion'
import { createPortal } from 'react-dom'
import { useEffect, useLayoutEffect, useId, useMemo, useRef, useState } from 'react'
import { useLang } from '../../i18n'

import type { CSSProperties } from 'react'

const MAX_VISIBLE_OPTIONS = 120

function optionValue(option) {
  return typeof option === 'string' ? option : option.value
}

function optionLabel(option) {
  return typeof option === 'string' ? option : option.label || option.value
}

function optionSearchText(option) {
  return typeof option === 'string' ? option : option.searchText || `${option.label || ''} ${option.value || ''}`
}

export default function SelectMenu({
  value,
  displayValue,
  options,
  onChange,
  emptyLabel,
  resetLabel,
  searchable = false,
  searchPlaceholder = 'Search…',
  disabled = false,
  compact = false,
}) {
  const { t } = useLang()
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const rootRef = useRef(null)
  const menuRef = useRef(null)
  const menuId = useId()
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({})

  const filteredOptions = useMemo(() => {
    const normalized = filter.trim().toLocaleLowerCase()
    const matches = normalized
      ? options.filter((option) => optionSearchText(option).toLocaleLowerCase().includes(normalized))
      : options
    return matches.slice(0, MAX_VISIBLE_OPTIONS)
  }, [filter, options])

  useEffect(() => {
    if (!open) return undefined

    function handlePointerDown(event) {
      if (!rootRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setOpen(false)
    }

    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open) return undefined
    function placeMenu() {
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return
      const mobile = window.innerWidth < 768
      const above = Math.max(0, Math.min(window.innerHeight - 24, rect.top - 20))
      const below = Math.max(0, Math.min(window.innerHeight - 24, window.innerHeight - rect.bottom - 20))
      const upwards = above > below
      const next: CSSProperties = mobile
        ? { position: 'fixed', left: 16, right: 16, bottom: 'calc(env(safe-area-inset-bottom) + 5.25rem)', top: 'auto', width: 'auto', maxHeight: Math.max(80, window.innerHeight - 110) }
        : { position: 'fixed', left: Math.max(12, Math.min(window.innerWidth - 300, rect.right - 288)), right: 'auto', top: upwards ? 'auto' : Math.max(12, Math.min(window.innerHeight - 92, rect.bottom + 8)), bottom: upwards ? Math.max(12, Math.min(window.innerHeight - 92, window.innerHeight - rect.top + 8)) : 'auto', maxHeight: Math.max(80, Math.max(above, below)) }
      setMenuStyle(previous => previous.left === next.left && previous.width === next.width && previous.top === next.top && previous.bottom === next.bottom && previous.maxHeight === next.maxHeight ? previous : next)
    }
    placeMenu()
    window.addEventListener('resize', placeMenu)
    window.addEventListener('scroll', placeMenu, true)
    return () => {
      window.removeEventListener('resize', placeMenu)
      window.removeEventListener('scroll', placeMenu, true)
    }
  }, [open])

  function choose(option) {
    onChange(optionValue(option))
    setOpen(false)
    setFilter('')
  }

  const hasValue = Boolean(value)
  const selectedOption = options.find((option) => optionValue(option) === value)

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        disabled={disabled}
        aria-label={emptyLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((isOpen) => !isOpen)}
        className={`focus-ring flex w-full min-w-0 items-center justify-between gap-2 border text-left transition-colors duration-300 disabled:cursor-not-allowed disabled:opacity-50 ${
          compact
            ? `h-[34px] rounded-full px-3.5 text-[12.5px] font-medium ${
                hasValue
                  ? 'border-brass bg-brass text-[#17140f]'
                  : 'border-line bg-elevate text-body hover:border-line-strong hover:text-ink'
              }`
            : `h-11 rounded-full px-4 text-sm ${
                hasValue
                  ? 'border-brass/60 bg-brass-soft text-brass-strong'
                  : 'border-line bg-elevate text-ink hover:border-line-strong'
              }`
        }`}
      >
        <span className="truncate">{displayValue || (selectedOption ? optionLabel(selectedOption) : value) || emptyLabel}</span>
        <CaretDown
          size={13}
          className={`shrink-0 transition-transform duration-300 ${open ? 'rotate-180' : ''} ${hasValue ? '' : 'text-faint'}`}
        />
      </button>

      {createPortal(<AnimatePresence>
        {open && (
          <motion.div
            ref={menuRef}
            id={menuId}
            style={menuStyle}
            role="listbox"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 380, damping: 28 }}
            className="flex flex-col absolute right-0 top-[calc(100%+8px)] z-[80] w-[min(18rem,calc(100vw-2.5rem))] origin-top-right overflow-hidden rounded-xl border border-line-strong bg-elevate/95 p-1.5 shadow-[0_24px_70px_-24px_rgba(0,0,0,0.85)] backdrop-blur-xl max-md:fixed max-md:inset-x-4 max-md:bottom-[calc(env(safe-area-inset-bottom)+5.25rem)] max-md:top-auto max-md:z-[80] max-md:w-auto max-md:origin-bottom"
          >
            {searchable && (
              <label className="relative mb-1.5 block shrink-0">
                <span className="sr-only">{searchPlaceholder}</span>
                <MagnifyingGlass
                  size={14}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
                />
                <input
                  autoFocus
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder={searchPlaceholder}
                  className="focus-ring h-9 w-full rounded-full border border-line bg-abyss/60 pl-8.5 pr-3 text-[13px] text-ink placeholder:text-faint"
                />
              </label>
            )}

            <div className="custom-scrollbar min-h-0 max-h-[min(18rem,calc(100dvh-12rem))] overflow-y-auto max-md:max-h-[48dvh]">
              <Option selected={!value} onSelect={() => choose('')}>
                {resetLabel || emptyLabel}
              </Option>
              {filteredOptions.map((option) => (
                <Option key={optionValue(option)} selected={value === optionValue(option)} onSelect={() => choose(option)}>
                  {optionLabel(option)}
                </Option>
              ))}
              {filteredOptions.length === 0 && (
                <p className="px-3 py-6 text-center text-[13px] text-muted">{t('select.noMatch')}</p>
              )}
            </div>
            {options.length > MAX_VISIBLE_OPTIONS && !filter && (
              <p className="shrink-0 border-t border-line px-3 py-2 text-[11px] text-faint">
                {t('select.searchHint', { n: options.length })}
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>, document.body)}
    </div>
  )
}

function Option({ selected, onSelect, children }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left text-[13px] transition-colors ${
        selected ? 'bg-brass-soft text-brass-strong' : 'text-body hover:bg-overlay hover:text-ink'
      }`}
    >
      <span className="truncate">{children}</span>
      {selected && <Check size={14} className="shrink-0" />}
    </button>
  )
}
