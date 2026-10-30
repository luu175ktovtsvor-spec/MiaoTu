import { useEffect } from 'react'
import { useLang } from '../i18n'
import { RELEASE_NOTES, RELEASE_NOTE_SECTIONS } from '../../../server/release-notes'
import ChangelogFrame from './ChangelogFrame'
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
  return <ChangelogFrame lang={lang} setLang={setLang} status={<>
      {!publishedVersion && <p role="status">{failed ? (zh ? '暂时无法核对正式版本，请刷新页面重试' : 'The current release could not be verified. Please refresh to retry.') : (zh ? '正在核对正式版本…' : 'Checking the current release…')}</p>}
      {publishedVersion && !RELEASE_NOTES[publishedVersion] && <p role="status">{zh ? `当前正式版为 ${publishedVersion}，更新说明正在补齐` : `The current release is ${publishedVersion}. Its release notes will be added shortly.`}</p>}
  </>}>
      <ol className="site-changelog-list">
        {publishedVersions.map((version) => { const notes = RELEASE_NOTES[version]; return <li key={version} id={`v${version}`}>
          <div className="site-changelog-version"><a href={`#v${version}`}>v{version}</a>{version === publishedVersion && <span>{zh ? '最新' : 'Latest'}</span>}</div>
          <article>
            <h2>{zh ? notes.title.zh : notes.title.en}</h2>
            {RELEASE_NOTE_SECTIONS.map(section => notes[section.key].length > 0 && <section key={section.key}>
              <h3>{zh ? section.zh : section.en}</h3>
              <ul>{notes[section.key].map((item, i) => <li key={i}>{zh ? item.zh : item.en}</li>)}</ul>
            </section>)}
          </article>
        </li> })}
      </ol>
  </ChangelogFrame>
}
