import { useId } from 'react'

type Point = { day: string; value: number | null }
export type OperationsSeries = { key: string; label: string; color: string; points: Point[] }
export default function AdminOperationsTrend({ series, lang, label, formatValue, timeZone }: {
  series: OperationsSeries[]; lang: string; label: string; formatValue?: (value: number) => string; timeZone: string;
}) {
  const t = (zh: string, en: string) => lang === 'en' ? en : zh
  const title = useId()
  const format = formatValue || ((value: number) => value.toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN', { maximumFractionDigits: 2 }))
  const days = [...new Set(series.flatMap(item => item.points.map(point => point.day)))].sort()
  const values = series.flatMap(item => item.points.map(point => point.value).filter((value): value is number => value != null && Number.isFinite(value)))
  if (!days.length || !values.length) return <p className="admin-analytics-empty">{t('所选期间没有可展示的数据', 'No data is available for this period')}</p>
  const maximum = Math.max(1, ...values)
  const x = (index: number) => days.length === 1 ? 50 : index / (days.length - 1) * 100
  const y = (value: number) => 100 - value / maximum * 100
  const indexed = series.map(item => ({ ...item, lookup: new Map(item.points.map(point => [point.day, point.value])) }))
  const axisDays = [...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])]
  return <div className="admin-analytics-chart">
    <ul className="admin-analytics-legend">{series.map(item => <li key={item.key}><span style={{ background: item.color }}/>{item.label}</li>)}</ul>
    <div className="admin-chart-y"><span>{format(maximum)}</span><span>{format(maximum / 2)}</span><span>0</span></div>
    <div className="admin-chart-plot">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-labelledby={title}>
        <title id={title}>{label}</title>
        {[0, 50, 100].map(at => <line key={at} x1="0" x2="100" y1={at} y2={at} className="admin-chart-grid" vectorEffect="non-scaling-stroke"/>)}
        {indexed.map(item => {
          let connected = false
          const line = days.map((day, index) => {
            const value = item.lookup.get(day)
            if (value == null || !Number.isFinite(value)) { connected = false; return '' }
            const command = `${connected ? 'L' : 'M'}${x(index).toFixed(3)},${y(value).toFixed(3)}`
            connected = true
            return command
          }).filter(Boolean).join(' ')
          return <path key={item.key} d={line} fill="none" stroke={item.color} strokeWidth="2" vectorEffect="non-scaling-stroke"/>
        })}
      </svg>
      {indexed.map(item => item.points.filter(point => point.value != null && Number.isFinite(point.value)).map(point => <i key={item.key + point.day} className="admin-chart-point" style={{ left: x(days.indexOf(point.day)) + '%', top: y(point.value!) + '%', background: item.color }} title={`${point.day} · ${item.label}: ${format(point.value!)}`} aria-hidden="true"/>))}
    </div>
    <div className="admin-chart-x">{axisDays.map(index => <span key={index}>{days[index]}</span>)}</div>
    <details className="admin-chart-table"><summary>{t('查看图表数据', 'View chart data')}</summary><div className="admin-table-wrap"><table><thead><tr><th>{`${t('日期', 'Date')} (${timeZone === 'Asia/Shanghai' ? t('北京时间', 'Beijing time') : 'UTC'})`}</th>{series.map(item => <th key={item.key}>{item.label}</th>)}</tr></thead><tbody>{days.map(day => <tr key={day}><td>{day}</td>{indexed.map(item => <td key={item.key}>{item.lookup.get(day) == null ? '—' : format(item.lookup.get(day)!)}</td>)}</tr>)}</tbody></table></div></details>
  </div>
}
