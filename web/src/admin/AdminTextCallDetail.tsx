import { RecordIdentifier } from './components'

// Present the existing call receipt without changing billing or request data.
export default function AdminTextCallDetail({ record: detail, lang }: { record: any; lang: string }) {
  const t = (zh: string, en: string) => lang === 'en' ? en : zh
  const fmt = (value: any, digits = 4) => value == null ? '—' : Number(value).toLocaleString(undefined, { maximumFractionDigits: digits })
  const fields = [
    { label: t('用户', 'User'), value: detail.user_name || (detail.source === 'upstream_history' ? t('用户未留存', 'User unavailable') : null) },
    { label: t('模型', 'Model'), value: detail.model },
    { label: t('请求编号', 'Request ID'), value: detail.request_id, identifier: true },
    { label: t('关联操作', 'Operation'), value: detail.operation_id, identifier: true },
    { label: t('上游请求编号', 'Upstream request ID'), value: detail.upstream_request_id, identifier: true },
    { label: t('上游响应编号', 'Response ID'), value: detail.response_id, identifier: true },
    { label: 'HTTP', value: detail.upstream_status },
    { label: t('输入 / 输出 Token', 'Input / output tokens'), value: detail.usage_known ? `${fmt(detail.input_tokens, 0)} / ${fmt(detail.output_tokens, 0)}` : t('未取得用量回执', 'Usage unavailable') },
    { label: t('缓存读取 / 写入', 'Cache read / write'), value: `${fmt(detail.cache_read_tokens, 0)} / ${fmt(detail.cache_write_tokens, 0)}` },
    { label: t('推理 Token（已含在输出）', 'Reasoning tokens (included in output)'), value: fmt(detail.reasoning_tokens, 0) },
    { label: t('预扣 / 实扣积分', 'Held / charged credits'), value: `${fmt(detail.reserved_points)} / ${fmt(detail.charged_points)}` },
    { label: t('首 Token 耗时', 'First token latency'), value: detail.first_token_ms === null ? '—' : `${detail.first_token_ms} ms` },
    { label: t('上游成本', 'Upstream cost'), value: detail.upstream_cost === null ? t('未取得供应商账单', 'Supplier bill unavailable') : detail.upstream_cost },
    { label: t('网关计价（USD，非采购成本）', 'Gateway charge (USD, not supplier cost)'), value: fmt(detail.gateway_cost_usd) },
    { label: t('诊断', 'Diagnostic'), value: detail.error, wide: true },
  ]
  return <section className="admin-text-call-detail">
    <dl className="console-detail">{fields.map(field => <div key={field.label} className={field.identifier || field.wide ? 'console-detail-wide' : undefined}>
      <dt>{field.label}</dt><dd>{field.identifier ? <RecordIdentifier value={field.value} label={field.label} lang={lang}/> : field.value ?? '—'}</dd>
    </div>)}</dl>
    <details className="admin-technical-details"><summary>{t('本次价格快照', 'Price snapshot')}</summary><pre className="console-json" tabIndex={0} aria-label={t('本次价格快照', 'Price snapshot')}>{JSON.stringify(detail.pricing_snapshot, null, 2)}</pre></details>
  </section>
}
