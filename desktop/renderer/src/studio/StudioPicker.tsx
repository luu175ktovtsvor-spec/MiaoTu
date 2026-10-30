import { CaretDown, Check, SlidersHorizontal } from '@phosphor-icons/react'
import { createPortal } from 'react-dom'
import { useEffect, useId, useRef, useState } from 'react'
import { useLang } from '../i18n'
import { isChineseLang } from '../shellLanguage'
import { studioText } from './studioText'

export default function StudioPicker({ value, options, onChange, label, placeholder = '请选择', disabled = false, icon: Icon = SlidersHorizontal, compact = false }) {
  const { lang } = useLang()
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState(null)
  const triggerRef = useRef(null)
  const menuRef = useRef(null)
  const menuId = useId()
  const selected = options.find((option) => option.value === value)
  const resolvedPlaceholder = placeholder === '请选择' ? studioText('请选择', lang) : placeholder

  useEffect(() => {
    if (!open) return undefined
    function updatePosition() {
      const rect = triggerRef.current.getBoundingClientRect()
      const width = Math.min(Math.max(rect.width, 280), window.innerWidth - 24)
      const below = window.innerHeight - rect.bottom - 12
      const above = rect.top - 12
      const upwards = below < 240 && above > below
      setPosition({
        width,
        left: Math.min(Math.max(12, rect.left), window.innerWidth - width - 12),
        maxHeight: Math.min(360, Math.max(120, upwards ? above : below)),
        ...(upwards ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
      })
    }
    function close(event) {
      if (!triggerRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setOpen(false)
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    document.addEventListener('scroll', updatePosition, true)
    document.addEventListener('pointerdown', close)
    return () => {
      window.removeEventListener('resize', updatePosition)
      document.removeEventListener('scroll', updatePosition, true)
      document.removeEventListener('pointerdown', close)
    }
  }, [open])

  useEffect(() => {
    if (open && position) {
      const menu = menuRef.current
      const target = menu?.querySelector('[aria-selected="true"]:not(:disabled)') || menu?.querySelector('[role="option"]:not(:disabled)')
      if (menu && !menu.contains(document.activeElement)) target?.focus({ preventScroll: true })
    }
  }, [open, position])

  function keyboard(event) {
    const choices = [...menuRef.current.querySelectorAll('[role="option"]:not(:disabled)')]
    const index = choices.indexOf(document.activeElement)
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); triggerRef.current.focus() }
    else if (event.key === 'Tab') { setOpen(false) }
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length
      choices[next]?.focus()
    }
  }

  return <div className="studio-picker">
    <button ref={triggerRef} type="button" className={`studio-picker__button ${compact ? 'is-compact' : ''}`} aria-label={`${label}${isChineseLang(lang) ? '：' : ': '}${selected?.label || resolvedPlaceholder}`} aria-haspopup="listbox" aria-controls={menuId} aria-expanded={open} disabled={disabled || !options.length} onClick={() => setOpen(!open)} onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true) } }}>
      {selected?.leading ? selected.leading : !compact && <Icon size={17} className="studio-picker__icon" />}
      <span><strong>{selected?.label || resolvedPlaceholder}</strong>{!compact && selected?.detail && <small>{selected.detail}</small>}</span>
      <CaretDown size={14} className={open ? 'is-open' : ''} />
    </button>
    {open && position && createPortal(<div ref={menuRef} id={menuId} className="studio-picker__menu" style={position} role="listbox" aria-label={label} onKeyDown={keyboard}>
      {options.map((option, index) => <div role="presentation" key={option.value}>
        {option.group && (index === 0 || option.group !== options[index - 1]?.group) && <p className="studio-picker__group">{option.group}</p>}
        <button type="button" role="option" aria-selected={option.value === value} disabled={option.disabled} className={`studio-picker__option ${option.value === value ? 'is-selected' : ''}`} onClick={() => { onChange(option.value); setOpen(false); triggerRef.current.focus() }}>
          {option.leading ?? <Icon size={17} className="studio-picker__icon" />}<span><strong>{option.label}</strong>{option.detail && <small>{option.detail}</small>}</span>{option.value === value && <Check size={16} />}
        </button>
      </div>)}
    </div>, document.body)}
  </div>
}
