import { AppleLogo, ArrowRight, ArrowUpRight, Check, Copy, DownloadSimple, FolderOpen, Images, Sparkle, VideoCamera, WindowsLogo } from '@phosphor-icons/react'
import { type RefObject, useEffect, useRef, useState } from 'react'
import { writeClipboard } from '../clipboard'
import { useLang } from '../i18n'
import { landingCopy } from './copy'
import { productName as desktopProductName } from '../../../desktop/package.json'
import { getMacInstallState, usePublishedRelease } from './usePublishedRelease'
import './landing.css'
import VideoShowcase from './VideoShowcase'
import CanvasFilm from './CanvasFilm'
import { LandingHeader, LandingHero } from './LandingHero'
import UiClip, { type UiClipName } from './UiClip'
import { MIAO_MANUAL_URL } from '../lib/productLinks'
const base = '/desktop-downloads/updates/'
const installCommand = 'curl -fsSL https://miaoimg.cn/desktop-downloads/updates/install-mac.sh | sh'
const canvasMedia = ['ui-connections', 'ui-settings', 'ui-plus'] as const satisfies readonly UiClipName[]

// Fades sections in once as they enter the viewport. Content stays visible
// without JS, and with reduced motion the CSS skips the transition.
function useReveal(ref: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const root = ref.current
    if (!root || !('IntersectionObserver' in window)) return
    root.classList.add('site-reveal-ready')
    const nodes = Array.from(root.querySelectorAll('[data-reveal]'))
    const observer = new IntersectionObserver(entries => entries.forEach(entry => {
      if (entry.isIntersecting) { entry.target.classList.add('is-in'); observer.unobserve(entry.target) }
    }), { rootMargin: '0px 0px -8% 0px', threshold: 0.08 })
    nodes.forEach(node => observer.observe(node))
    return () => { observer.disconnect(); root.classList.remove('site-reveal-ready') }
  }, [ref])
}

export default function LandingPage() {
  const { lang, setLang } = useLang()
  const c = landingCopy[lang] || landingCopy.en
  const { version, failed } = usePublishedRelease()
  const macInstallState = getMacInstallState(version)
  const macNotice = macInstallState === 'signed' ? c.macSignedNotice : macInstallState === 'unsigned' ? c.macNotice : c.macUnverifiedNotice
  const macOpenSteps = macInstallState === 'unsigned' ? c.macOpenSteps : c.macStandardOpenSteps
  const [copyState, setCopyState] = useState('')
  const [scrolled, setScrolled] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const site = useRef<HTMLDivElement>(null)
  useReveal(site)
  useEffect(() => {
    const old = document.title
    const id = window.setTimeout(() => { document.title = lang === 'zh' ? '妙图 MiaoImg · AI 无限画布' : 'MiaoImg · The AI infinite canvas' }, 0)
    return () => { window.clearTimeout(id); document.title = old }
  }, [lang])
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  useEffect(() => () => clearTimeout(timer.current), [])
  async function copyCommand() {
    try { await writeClipboard(installCommand); setCopyState('copied') }
    catch { setCopyState('failed') }
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopyState(''), 3000)
  }
  const versionSuffix = version ? `-${version}` : ''
  const downloads = [
    ['macOS', c.apple, `miaoimg-desktop-mac-arm64${versionSuffix}.dmg`, AppleLogo, 'arm64.dmg'], ['macOS', c.intel, `miaoimg-desktop-mac-x64${versionSuffix}.dmg`, AppleLogo, 'x64.dmg'], ['Windows', c.win, `miaoimg-desktop-windows${versionSuffix}.exe`, WindowsLogo, 'Windows-x64.exe'],
  ] as const
  return <div className="miao-site" id="top" ref={site}>
    <LandingHeader lang={lang} setLang={setLang} scrolled={scrolled}/>
    <main>
      <LandingHero lang={lang} film={<CanvasFilm lang={lang}/>}/>

      <section className="site-section site-canvas" id="canvas">
        <div className="site-container">
          <div className="site-section-heading site-heading-split" data-reveal><div><p className="site-kicker">{c.canvasKicker}</p><h2>{c.canvasTitle[0]}<br/><span>{c.canvasTitle[1]}</span></h2></div><p>{c.canvasBody}</p></div>
          <div className="site-bento">{c.canvasTiles.map((tile, i) => <figure key={i} className={`site-tile site-tile-${i + 1}`} data-reveal>
            <div className="site-tile-media"><UiClip name={canvasMedia[i]} label={tile.title}/></div>
            <figcaption>{i === 0 && <ul className="site-tile-chips">{c.canvasChips.map(chip => <li key={chip}>{chip}</li>)}</ul>}<span className="site-tile-index">0{i + 1}</span><h3>{tile.title}</h3><p>{tile.body}</p></figcaption>
          </figure>)}</div>
        </div>
      </section>

      <section className="site-section site-agent" id="features">
        <div className="site-container site-agent-section">
          <div className="site-section-heading" data-reveal><p className="site-kicker">{c.agentKicker}</p><h2>{c.agentTitle[0]}<br/><span>{c.agentTitle[1]}</span></h2><p>{c.agentBody}</p><ul className="site-local-list">{c.localItems.map(text => <li key={text}><span><Check size={13} weight="bold"/></span>{text}</li>)}</ul></div>
          <div className="site-agent-demo" data-reveal>
            <div className="site-agent-demo-header"><span className="site-agent-avatar"><Sparkle size={16} weight="fill"/></span><span>{c.agentDemoTitle}</span><i aria-hidden="true"/></div>
            <div className="site-agent-demo-message"><span>{c.agentDemoYou}</span><p>{c.agentDemoMessage.map((line, i) => <span key={i}>{line}</span>)}</p></div>
            <ol className="site-agent-demo-steps">{c.agentSteps.map((text, i) => <li key={text} style={{ ['--i' as string]: i }}><span>0{i + 1}</span><p>{text}</p><ArrowRight size={14}/></li>)}</ol>
          </div>
        </div>
      </section>

      <section className="site-section site-toolbox">
        <div className="site-container">
          <div className="site-section-heading" data-reveal><p className="site-kicker">{c.toolsKicker}</p><h2>{c.toolsTitle}</h2></div>
          <div className="site-feature-grid">{c.tools.map(([title, body], i) => { const Icon = [Images, VideoCamera, FolderOpen][i]; return <article key={i} data-reveal style={{ ['--i' as string]: i }}><div className="site-feature-icon"><Icon size={22}/></div><h3>{title}</h3><p>{body}</p></article> })}</div>
        </div>
      </section>

      <VideoShowcase lang={lang}/>

      <section className="site-section site-download" id="download">
        <div className="site-container">
          <div className="site-download-panel" data-reveal>
            <div className="site-download-aura" aria-hidden="true"/>
            <div className="site-section-heading"><img className="site-download-logo" src="/miaoimg-logo.png" width="56" height="56" alt=""/><p className="site-kicker">{c.downloadKicker}</p><h2>{c.downloadTitle[0]} <span>{c.downloadTitle[1]}</span></h2><p>{c.downloadBody}</p></div>
            <p className="site-release-version">{version ? `${c.currentVersion} ${version}` : failed ? c.releaseUnavailable : c.releaseLoading} · <a href="/changelog">{c.changelog}</a></p>
            <div className="site-download-grid">{downloads.map(([os, label, file, Icon, packageSuffix]) => <article key={file}><Icon size={26} weight="fill"/><div><h3>{os}</h3><p>{label}</p></div><a className="site-button site-button-outline" href={`${base}${file}`} download={version ? `${desktopProductName}-${version}-${packageSuffix}` : undefined} aria-label={`${c.downloadButton} · ${os} ${label}`}>{c.downloadButton}<DownloadSimple size={15}/></a></article>)}</div>
            <div className="site-mac-notice"><strong>{c.macNoticeTitle}</strong><p>{macNotice}</p><ol>{macOpenSteps.map(step => <li key={step}>{step}</li>)}</ol>{macInstallState === 'unsigned' && <a href="https://support.apple.com/zh-cn/102445" target="_blank" rel="noreferrer">{c.appleHelp}<ArrowUpRight size={13}/></a>}</div>
            {macInstallState === 'unsigned' && <details className="site-install-help"><summary>{c.installHelp}</summary><div><p>{c.installText} <a href={`${base}install-mac.sh`} target="_blank" rel="noreferrer">{c.viewScript}<ArrowUpRight size={13}/></a></p><div className="site-command"><code>{installCommand}</code><button onClick={copyCommand} aria-label={c.copy}>{copyState === 'copied' ? <Check size={17}/> : <Copy size={17}/>}</button></div><p role="status" className="site-copy-status">{copyState === 'copied' ? c.copied : copyState === 'failed' ? c.copyFailed : ''}</p></div></details>}
          </div>
        </div>
      </section>
    </main>
    <footer className="site-footer site-container">
      <div className="site-footer-top">
        <div><a className="site-brand" href="#top"><img src="/miaoimg-logo.png" width="26" height="26" alt=""/><span>妙图<small>MiaoImg</small></span></a><p className="site-footer-tag">{c.footerTag}</p></div>
        <nav aria-label={c.nav}><a href="#canvas">{c.workflow}</a><a href="#features">{c.agent}</a><a href="#films">{c.examples}</a><a href={MIAO_MANUAL_URL} target="_blank" rel="noreferrer">{c.guide} ↗</a><a href="/changelog">{c.changelog}</a><a href="#download">{c.download}</a></nav>
      </div>
      <div className="site-footer-bottom"><span>© {new Date().getFullYear()} MiaoImg</span><a className="site-text-link" href="#top">{c.top}<ArrowUpRight size={13}/></a></div>
    </footer>
  </div>
}
