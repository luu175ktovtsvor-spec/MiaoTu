import React, { type ReactNode } from 'react'
import { ArrowLeft, ArrowUpRight } from '@phosphor-icons/react'
import { MIAO_MANUAL_URL } from '../lib/productLinks'
export default function ChangelogFrame({ lang, setLang, status, children }: {
  lang: string; setLang?: (lang: string) => void; status?: ReactNode; children?: ReactNode;
}) {
  const zh = lang === 'zh'
  return <div className="miao-site site-changelog-page">
    <header className="site-header is-scrolled">
      <div className="site-header-inner">
        <a className="site-brand" href="/" aria-label="妙图 MiaoImg"><img src="/miaoimg-logo.png" width="30" height="30" alt="" /><span>妙图<small>MiaoImg</small></span></a>
        <nav aria-label={zh ? '主导航' : 'Main navigation'}><a href="/">{zh ? '首页' : 'Home'}</a><a href={MIAO_MANUAL_URL} target="_blank" rel="noreferrer">{zh ? '使用手册' : 'Guide'}<ArrowUpRight size={12} /></a></nav>
        <div className="site-header-actions"><div className="site-language" role="group" aria-label={zh ? '语言' : 'Language'}>
          <button aria-pressed={zh} onClick={() => setLang?.('zh')}>中</button><button aria-pressed={!zh} onClick={() => setLang?.('en')}>EN</button>
        </div><a className="site-button site-button-small" href="/#download">{zh ? '下载妙图' : 'Download'}</a></div>
      </div>
    </header>
    <main className="site-container site-changelog">
      <a className="site-text-link site-changelog-back" href="/"><ArrowLeft size={13} />{zh ? '返回首页' : 'Back to home'}</a>
      <h1>{zh ? '更新日志' : 'Changelog'}</h1>
      <p className="site-changelog-intro">{zh ? '妙图桌面版每个版本的新增功能、优化改进和 Bug 修复。已安装的妙图会自动检查更新，也可以在「设置 → 关于妙图」里查看当前版本。' : 'New features, improvements and bug fixes in each MiaoImg desktop release. Installed copies check for updates automatically; see Settings → About for your version.'}</p>
      {status === undefined ? <p role="status">{zh ? '正在核对正式版本…' : 'Checking the current release…'}</p> : status}
      {children ?? <ol className="site-changelog-list"/>}

    </main>
    <footer className="site-footer site-container">
      <div className="site-footer-bottom"><span>© {new Date().getFullYear()} MiaoImg</span><a className="site-text-link" href="/">{zh ? '返回首页' : 'Home'}<ArrowUpRight size={13} /></a></div>
    </footer>
  </div>
}
