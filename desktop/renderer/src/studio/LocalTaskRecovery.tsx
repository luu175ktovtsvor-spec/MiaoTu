import { studioText } from './studioText'
import './localTaskRecovery.css'
import type { LocalRecovery } from './studioState'

export default function LocalTaskRecovery({ recovery, lang }: { recovery?: LocalRecovery; lang: string }) {
  if (!recovery?.items?.length) return null
  return (
    <details className="local-task-recovery">
      <summary>{studioText('查看已保存的 {saved}/{total} 份原件', lang, { saved: recovery.saved, total: recovery.total })}</summary>
      <p>{studioText('未保存的服务器暂存文件已过期。可从原节点的历史记录恢复已保存文件。', lang)}</p>
      <ol>
        {recovery.items.map(item => (
          <li key={item.path}>
            {item.mime.startsWith('image/') && <img src={item.thumbnailUrl || item.url} loading="lazy" alt={studioText('第 {number} 份原件', lang, { number: item.index + 1 })} />}
            <a href={item.url} target="_blank" rel="noopener noreferrer">{studioText('查看第 {number} 份原件', lang, { number: item.index + 1 })}</a>
            <a href={item.url} download={item.path.split('/').at(-1)}>{studioText('下载', lang)}</a>
          </li>
        ))}
      </ol>
    </details>
  )
}
