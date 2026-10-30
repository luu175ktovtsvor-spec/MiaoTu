import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Copy, X } from '@phosphor-icons/react'
import { useLang } from '../i18n'
import { adminText, statusLabel } from './i18n'
import { writeClipboard } from '../clipboard'

const modalScrollLocks = new Set<symbol>()
let previousBodyOverflow = ''

export function Modal({title,children,onClose,lang='zh'}: {title: string; children: ReactNode; onClose: () => void; lang?: string}) {
 const closeRef = useRef(onClose)
 const dialogRef = useRef<HTMLElement>(null)
 useEffect(() => { closeRef.current = onClose }, [onClose])
 useEffect(()=>{
  const prev=document.activeElement as HTMLElement | null
  const box=dialogRef.current
  if (!box) return
  const lock = Symbol('admin-modal')
  if (!modalScrollLocks.size) previousBodyOverflow = document.body.style.overflow
  modalScrollLocks.add(lock)
  document.body.style.overflow = 'hidden'
  box.focus({ preventScroll: true })
  function key(e){
   const target = e.target instanceof Element ? e.target : undefined
   const typingTarget = target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="slider"]')
   // Character keys and IME composition stay with the field; Escape closes and
   // Tab is the intentional focus-trap boundary.
   if (e.isComposing || (typingTarget && e.key !== 'Escape' && e.key !== 'Tab')) return
   if(e.key==='Escape'){closeRef.current();return}
   if(e.key!=='Tab') return
   const list=[...box.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],summary,[tabindex]:not([tabindex="-1"])')].filter(element => element.getClientRects().length > 0)
   if (!list.length) return
   if(document.activeElement===box || !box.contains(document.activeElement)){e.preventDefault();(e.shiftKey?list.at(-1):list[0])?.focus();return}
   if(e.shiftKey && document.activeElement===list[0]){e.preventDefault();list.at(-1)?.focus()}
   else if(!e.shiftKey&&document.activeElement===list.at(-1)){e.preventDefault();list[0]?.focus()}
  }
  document.addEventListener('keydown',key)
  return()=>{document.removeEventListener('keydown',key);modalScrollLocks.delete(lock);if(!modalScrollLocks.size)document.body.style.overflow=previousBodyOverflow;if(prev?.isConnected)prev.focus({preventScroll:true})}
 },[])
 return <div className="admin-modal-backdrop"><section className="admin-modal" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}><header className="admin-modal-header"><h2>{title}</h2><button type="button" className="admin-modal-close" aria-label={adminText('关闭弹窗', lang)} onClick={onClose}><X size={18}/></button></header><div className="admin-modal-body">{children}</div></section></div>
}

export function Badge({value}: {value: string}) {const { lang } = useLang();const english={ok:'Provider completed',rejected:'Provider rejected',submission_unknown:'Submission awaiting confirmation',submitted:'Submitted',failed_after_submit:'Failed after submission',cancelled_after_submit:'Cancelled after submission',unknown:'Provider status unknown',active:'Active',disabled:'Disabled',queued:'Queued',running:'Running',succeeded:'Completed',failed:'Failed',cancelled:'Cancelled',expired:'Expired',created:'Awaiting payment',paid:'Paid',closed:'Closed'};return <span className={`admin-badge ${value}`}>{lang==='en'?(english[value]||adminText(value,lang)):(statusLabel[value]||adminText(({ok:'上游已完成',rejected:'上游拒绝',submission_unknown:'提交结果待确认',submitted:'已提交',failed_after_submit:'提交后失败',cancelled_after_submit:'提交后取消',unknown:'上游状态未知'})[value]||value,lang))}</span>}

export function Empty({children}: {children: ReactNode}) {return <div className="admin-empty">{children}</div>}

export function RecordIdentifier({ value, label, lang = 'zh' }: { value: unknown; label: string; lang?: string }) {
 const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
 const text = value == null ? '' : String(value)
 useEffect(() => { if(state==='idle')return; const timer=setTimeout(()=>setState('idle'),2500);return()=>clearTimeout(timer) },[state])
 async function copy() { try { await writeClipboard(text);setState('copied') } catch { setState('failed') } }
 if(!text) return <>—</>
 return <span className="admin-identifier"><code>{text}</code><button type="button" className="admin-copy-id" onClick={copy} title={adminText('复制标识',lang)} aria-label={`${adminText('复制标识',lang)} · ${label}`}>{state==='copied'?<Check size={14}/>:<Copy size={14}/>}</button><span className={state==='failed'?'admin-copy-error':'admin-sr-only'} role="status">{state==='copied'?adminText('已复制',lang):state==='failed'?adminText('复制失败，请选中标识手动复制',lang):''}</span></span>
}
