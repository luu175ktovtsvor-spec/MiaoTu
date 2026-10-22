import { useEffect, useRef, type ReactNode } from 'react'
import { X } from '@phosphor-icons/react'
import { useLang } from '../i18n'
import { adminText, statusLabel } from './i18n'

export function Modal({title,children,onClose,lang='zh'}: {title: string; children: ReactNode; onClose: () => void; lang?: string}) {
 const closeRef = useRef(onClose)
 useEffect(() => { closeRef.current = onClose }, [onClose])
 useEffect(()=>{
  const prev=document.activeElement as HTMLElement | null
  const box=document.querySelector<HTMLElement>('.admin-modal')
  if (!box) return
  box?.querySelector<HTMLElement>('input,button,textarea')?.focus()
  function key(e){
   const target = e.target instanceof Element ? e.target : undefined
   const typingTarget = target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="slider"]')
   // Character keys and IME composition stay with the field; Escape closes and
   // Tab is the intentional focus-trap boundary.
   if (e.isComposing || (typingTarget && e.key !== 'Escape' && e.key !== 'Tab')) return
   if(e.key==='Escape'){closeRef.current();return}
   if(e.key!=='Tab') return
   const list=[...box.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href]')]
   if (!list.length) return
   if(e.shiftKey && document.activeElement===list[0]){e.preventDefault();list.at(-1)?.focus()}
   else if(!e.shiftKey&&document.activeElement===list.at(-1)){e.preventDefault();list[0]?.focus()}
  }
  document.addEventListener('keydown',key)
  return()=>{document.removeEventListener('keydown',key);prev?.focus()}
 },[])
 return <div className="admin-modal-backdrop"><section className="admin-modal" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button aria-label={adminText('关闭弹窗', lang)} onClick={onClose}><X size={20}/></button></header>{children}</section></div>
}

export function Badge({value}: {value: string}) {const { lang } = useLang();const english={ok:'Provider completed',rejected:'Provider rejected',submission_unknown:'Submission awaiting confirmation',submitted:'Submitted',failed_after_submit:'Failed after submission',cancelled_after_submit:'Cancelled after submission',unknown:'Provider status unknown',active:'Active',disabled:'Disabled',queued:'Queued',running:'Running',succeeded:'Completed',failed:'Failed',cancelled:'Cancelled',expired:'Expired',created:'Awaiting payment',paid:'Paid',closed:'Closed'};return <span className={`admin-badge ${value}`}>{lang==='en'?(english[value]||adminText(value,lang)):(statusLabel[value]||adminText(({ok:'上游已完成',rejected:'上游拒绝',submission_unknown:'提交结果待确认',submitted:'已提交',failed_after_submit:'提交后失败',cancelled_after_submit:'提交后取消',unknown:'上游状态未知'})[value]||value,lang))}</span>}

export function Empty({children}: {children: ReactNode}) {return <div className="admin-empty">{children}</div>}
