import { useLang } from '../i18n'
import { landingCopy } from './copy'
import './landing.css'

export default function LandingFallback() {
  const { lang } = useLang()
  const c = landingCopy[lang] || landingCopy.en
  return <div className="miao-site"><header className="site-header"><div className="site-header-inner"><a className="site-brand" href="/"><img src="/miaoimg-logo.png" width="30" height="30" alt=""/><span>妙图<small>MiaoImg</small></span></a></div></header><main className="site-hero site-container"><h1 data-lang={lang}>{c.heroTitle[0]}<br/><span>{c.heroTitle[1]}</span></h1><p className="site-hero-body">{c.heroBody}</p><div className="site-hero-actions"><a className="site-button" href="/desktop-downloads/updates/miaoimg-desktop-mac-arm64.dmg">macOS · Apple</a><a className="site-button" href="/desktop-downloads/updates/miaoimg-desktop-mac-x64.dmg">macOS · Intel</a><a className="site-button" href="/desktop-downloads/updates/miaoimg-desktop-windows.exe">Windows</a></div></main></div>
}
