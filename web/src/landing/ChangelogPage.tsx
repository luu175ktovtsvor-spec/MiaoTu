import { ArrowLeft, ArrowUpRight } from '@phosphor-icons/react'
import { useEffect } from 'react'
import { useLang } from '../i18n'
import { RELEASE_NOTES } from '../../../server/release-notes'
import { MIAO_MANUAL_URL } from '../lib/productLinks'
import { compareVersions, usePublishedRelease } from './usePublishedRelease'
import './landing.css'

// 官网「更新日志」：和桌面端打开新版本时看到的说明是同一份数据，两边不会说得不一样。
const versions = Object.keys(RELEASE_NOTES).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))

export default function ChangelogPage() {
  const { lang, setLang } = useLang()
  const zh = lang === 'zh'
  const { version: publishedVersion, failed } = usePublishedRelease()
  const publishedVersions = publishedVersion ? versions.filter(version => compareVersions(version, publishedVersion) <= 0) : []
  useEffect(() => { document.title = zh ? '更新日志 · 妙图 MiaoImg' : 'Changelog · MiaoImg' }, [zh])
  const section = (key: 'fixes' | 'improvements') => zh ? { fixes: '修复', improvements: '改进' }[key] : { fixes: 'Fixes', improvements: 'Improvements' }[key]
  return <div className="miao-site site-changelog-page">
    <header className="site-header is-scrolled">
      <div className="site-header-inner">
        <a className="site-brand" href="/" aria-label="妙图 MiaoImg"><img src="/miaoimg-logo.png" width="30" height="30" alt="" /><span>妙图<small>MiaoImg</small></span></a>
        <nav aria-label={zh ? '主导航' : 'Main navigation'}><a href="/">{zh ? '首页' : 'Home'}</a><a href={MIAO_MANUAL_URL} target="_blank" rel="noreferrer">{zh ? '使用手册' : 'Guide'}<ArrowUpRight size={12} /></a></nav>
        <div className="site-header-actions"><div className="site-language" role="group" aria-label={zh ? '语言' : 'Language'}>
          <button aria-pressed={zh} onClick={() => setLang('zh')}>中</button><button aria-pressed={!zh} onClick={() => setLang('en')}>EN</button>
        </div><a className="site-button site-button-small" href="/#download">{zh ? '下载妙图' : 'Download'}</a></div>
      </div>
    </header>
    <main className="site-container site-changelog">
      <a className="site-text-link site-changelog-back" href="/"><ArrowLeft size={13} />{zh ? '返回首页' : 'Back to home'}</a>
      <h1>{zh ? '更新日志' : 'Changelog'}</h1>
      <p className="site-changelog-intro">{zh ? '妙图桌面版每个版本修好了什么、改进了什么。已安装的妙图会自动检查更新，也可以在「设置 → 关于妙图」里查看当前版本。' : 'What each MiaoImg desktop release fixed and improved. Installed copies check for updates automatically; see Settings → About for your version.'}</p>
      {!publishedVersion && <p role="status">{failed ? (zh ? '暂时无法核对正式版本，请刷新页面重试' : 'The current release could not be verified. Please refresh to retry.') : (zh ? '正在核对正式版本…' : 'Checking the current release…')}</p>}
      {publishedVersion && !RELEASE_NOTES[publishedVersion] && <p role="status">{zh ? `当前正式版为 ${publishedVersion}，更新说明正在补齐` : `The current release is ${publishedVersion}. Its release notes will be added shortly.`}</p>}
      <ol className="site-changelog-list">
        {publishedVersions.map((version) => { const notes = RELEASE_NOTES[version]; return <li key={version} id={`v${version}`}>
          <div className="site-changelog-version"><a href={`#v${version}`}>v{version}</a>{version === publishedVersion && <span>{zh ? '最新' : 'Latest'}</span>}</div>
          <article>
            <h2>{zh ? notes.title.zh : notes.title.en}</h2>
            {(['fixes', 'improvements'] as const).map(key => notes[key].length > 0 && <section key={key}>
              <h3>{section(key)}</h3>
              <ul>{notes[key].map((item, i) => <li key={i}>{zh ? item.zh : item.en}</li>)}</ul>
            </section>)}
          </article>
        </li> })}
      </ol>
    </main>
    <footer className="site-footer site-container">
      <div className="site-footer-bottom"><span>© {new Date().getFullYear()} MiaoImg</span><a className="site-text-link" href="/">{zh ? '返回首页' : 'Home'}<ArrowUpRight size={13} /></a></div>
    </footer>
  </div>
}
