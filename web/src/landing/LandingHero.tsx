import React, { type ReactNode } from 'react'
import { AppleLogo, ArrowDown, ArrowRight, ArrowUpRight, WindowsLogo } from '@phosphor-icons/react'
import { landingCopy } from './copy'
import { MIAO_MANUAL_URL } from '../lib/productLinks'
export function LandingHeader({ lang, setLang, scrolled = false }: { lang: string; setLang?: (lang: string) => void; scrolled?: boolean }) {
  const c = landingCopy[lang === 'zh' ? 'zh' : 'en']
  return <>
    <header className={`site-header${scrolled ? ' is-scrolled' : ''}`}>
      <div className="site-header-inner">
        <a className="site-brand" href="/" aria-label="妙图 MiaoImg"><img src="/miaoimg-logo.png" width="30" height="30" alt="" /><span>妙图<small>MiaoImg</small></span></a>
        <nav aria-label={c.nav}><a href="#canvas">{c.workflow}</a><a href="#features">{c.agent}</a><a href="#films">{c.examples}</a><a href={MIAO_MANUAL_URL} target="_blank" rel="noreferrer">{c.guide}<ArrowUpRight size={12}/></a><a href="/changelog">{c.changelog}</a></nav>
        <div className="site-header-actions"><div className="site-language" role="group" aria-label={c.lang}>
          <button aria-pressed={lang === 'zh'} onClick={() => setLang?.('zh')}>中</button><button aria-pressed={lang === 'en'} onClick={() => setLang?.('en')}>EN</button>
        </div><a className="site-button site-button-small" href="#download">{c.download}<ArrowDown size={13} /></a></div>
      </div>
    </header>
  </>
}
export function LandingHero({ lang, film }: { lang: string; film: ReactNode }) {
  const c = landingCopy[lang === 'zh' ? 'zh' : 'en']
  return <>
      <section className="site-hero">
        <div className="site-hero-aura" aria-hidden="true"/>
        <div className="site-container site-hero-copy">
          <p className="site-eyebrow"><span className="site-eyebrow-brand">{c.eyebrow}</span><span className="site-eyebrow-sep" aria-hidden="true"/>{c.eyebrowTag}</p>
          <h1 data-lang={lang}>{c.heroTitle[0]}<br /><span>{c.heroTitle[1]}</span></h1>
          <p className="site-hero-body">{c.heroBody}</p>
          <div className="site-hero-actions"><a className="site-button" href="#download">{c.download}<ArrowDown size={16} /></a><a className="site-button site-button-ghost" href="#canvas">{c.explore}<ArrowRight size={16} /></a></div>
          <p className="site-hero-platforms"><AppleLogo size={14} weight="fill"/><WindowsLogo size={14} weight="fill"/>{c.platforms}</p>
        </div>
        <div className="site-container site-hero-film">{film}</div>
        <ol className="site-container site-steps" aria-label={c.workflow}>{c.steps.map(([title, body], i) => <li key={title} style={{ ['--i' as string]: i }}><span className="site-step-index">0{i + 1}</span><div><h3>{title}</h3><p>{body}</p></div>{i < 2 && <i className="site-step-line" aria-hidden="true"/>}</li>)}</ol>
      </section>
  </>
}
