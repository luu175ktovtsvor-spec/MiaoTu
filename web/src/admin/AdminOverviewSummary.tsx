import { ArrowRight, Users, Images, Receipt, SlidersHorizontal, Plus } from '@phosphor-icons/react';
import { adminText, number } from './i18n';

type Props = {
  lang: string;
  stats: Record<string, any>;
  payments: Record<string, any>;
  onNavigate(section: string, status?: string): void;
  onCreateUser(): void;
  onOpenPrices(): void;
};

export default function AdminOverviewSummary({ lang, stats, payments, onNavigate, onCreateUser, onOpenPrices }: Props) {
  const t = (value: string) => adminText(value, lang);
  const n = (value: unknown) => value == null ? '—' : number(value, lang);
  const money = (value: unknown) => value == null ? '—' : `¥${number(Number(value) / 100, lang)}`;
  const pending = stats.queued == null || stats.running == null ? null : Number(stats.queued) + Number(stats.running);
  const summary = payments?.summary || {};
  const metrics = [
    { label: t('用户总数'), value: n(stats.users), detail: `${t('正常账号')} ${n(stats.activeUsers)}`, target: 'users', Icon: Users },
    { label: t('进行中的任务'), value: n(pending), detail: `${t('排队')} ${n(stats.queued)} · ${t('生成中')} ${n(stats.running)}`, target: 'generations', Icon: Images },
    { label: t('今日充值金额（UTC）'), value: money(summary.todayCents), detail: `${n(summary.todayOrders)} ${t('笔已支付订单')}`, target: 'payments', Icon: Receipt },
    { label: t('本月充值金额（UTC）'), value: money(summary.monthCents), detail: `${n(summary.monthOrders)} ${t('笔已支付订单')}`, target: 'payments', Icon: Receipt },
  ];
  const mismatches = Array.isArray(stats.balanceAudit?.mismatches) ? stats.balanceAudit.mismatches.length : null;
  const reviews = [
    { label: t('失败记录'), value: stats.failed, detail: t('累计失败任务，可进入记录排查。'), target: 'generations', status: 'failed' },
    { label: t('缺少成本记录'), value: stats.missingCostRows, detail: t('已完成但成本未确认，不将未知成本计为零。'), target: 'upstream' },
    { label: t('余额不一致账号'), value: mismatches, detail: t('核对存储余额与积分账本。'), target: 'users' },
  ];
  return <>
    <section className="admin-primary-metrics" aria-label={t('经营与任务概况')}>
      {metrics.map(({ label, value, detail, target, Icon }) => <button key={label} onClick={() => onNavigate(target)} className="admin-primary-metric">
        <span className="admin-primary-metric-label">{label}<Icon size={18} aria-hidden="true" /></span>
        <strong>{value}</strong><small>{detail}</small>
      </button>)}
    </section>
    <div className="admin-workbench-grid">
      <section className="admin-panel admin-review-panel">
        <header><div><h2>{t('任务与对账')}</h2><p>{t('从当前记录中定位需要查看的事项。')}</p></div></header>
        <div className="admin-review-list">{reviews.map(item => <button key={item.label} onClick={() => onNavigate(item.target, item.status)}>
          <span className={`admin-review-count ${Number(item.value) > 0 ? 'has-records' : ''}`}>{n(item.value)}</span>
          <span className="admin-review-copy"><strong>{item.label}</strong><small>{item.detail}</small></span>
          <ArrowRight size={17} aria-hidden="true" />
        </button>)}</div>
      </section>
      <section className="admin-panel admin-quick-panel">
        <header><div><h2>{t('常用操作')}</h2><p>{t('常用管理入口集中在这里。')}</p></div></header>
        <div className="admin-workbench-actions">
          <button onClick={onCreateUser}><Plus size={20}/><span><strong>{t('创建用户')}</strong><small>{t('新增账号与初始权限')}</small></span><ArrowRight size={16}/></button>
          <button onClick={onOpenPrices}><SlidersHorizontal size={20}/><span><strong>{t('调整模型价格')}</strong><small>{t('图片、视频和文本统一调价')}</small></span><ArrowRight size={16}/></button>
          <button onClick={() => onNavigate('settings')}><SlidersHorizontal size={20}/><span><strong>{t('运营设置')}</strong><small>{t('服务开关与自动报价规则')}</small></span><ArrowRight size={16}/></button>
          <button onClick={() => onNavigate('feedback')}><Users size={20}/><span><strong>{t('用户反馈')}</strong><small>{t('查看问题并回复用户')}</small></span><ArrowRight size={16}/></button>
        </div>
      </section>
    </div>
  </>;
}
