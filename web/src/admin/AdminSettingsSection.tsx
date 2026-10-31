import { ArrowRight, ShieldCheck, SlidersHorizontal, Receipt, ListChecks } from '@phosphor-icons/react';
import { adminText } from './i18n';
import { Badge } from './components';

type Props = {
  lang: string;
  settings: Record<string, any>;
  payments: Record<string, any>;
  onOpenServiceSettings(): void;
  onOpenPrices(): void;
  onNavigate(section: string): void;
};

export default function AdminSettingsSection({ lang, settings, payments, onOpenServiceSettings, onOpenPrices, onNavigate }: Props) {
  const t = (value: string) => adminText(value, lang);
  const flag = (value: unknown) => value == null ? '未知' : value ? '已开启' : '已关闭';
  return <div className="admin-settings-grid">
    <section className="admin-panel admin-setting-card">
      <header><ShieldCheck size={22}/><div><h2>{t('服务与注册')}</h2><p>{t('管理图片、视频生成与新用户注册开关。')}</p></div></header>
      <dl className="admin-settings-status">
        <div><dt>{t('生成服务')}</dt><dd><Badge value={flag(settings.enabled)}/></dd></div>
        <div><dt>{t('视频生成')}</dt><dd><Badge value={flag(settings.videoEnabled)}/></dd></div>
        <div><dt>{t('开放注册')}</dt><dd><Badge value={flag(settings.registrationEnabled)}/></dd></div>
      </dl>
      <footer><button onClick={onOpenServiceSettings}>{t('管理服务设置')}<ArrowRight size={16}/></button></footer>
    </section>
    <section className="admin-panel admin-setting-card">
      <header><SlidersHorizontal size={22}/><div><h2>{t('价格与自动报价')}</h2><p>{t('集中调整客户价格、默认加价和成本换算参数。')}</p></div></header>
      <div className="admin-setting-note"><strong>{t('人工档位价优先')}</strong><p>{t('人工设置的模型档位价优先于自动报价；改价只影响新请求。')}</p></div>
      <div className="admin-setting-note"><strong>{t('售价与采购成本分开')}</strong><p>{t('Grok 售价倍率只影响客户自动价，不修改实际采购成本。')}</p></div>
      <footer><button onClick={onOpenPrices}>{t('管理价格规则')}<ArrowRight size={16}/></button><button onClick={() => onNavigate('models')}>{t('查看模型目录')}</button></footer>
    </section>
    <section className="admin-panel admin-setting-card">
      <header><Receipt size={22}/><div><h2>{t('充值与支付')}</h2><p>{t('核对支付服务状态、充值订单和到账结果。')}</p></div></header>
      <dl className="admin-settings-status"><div><dt>{t('支付服务')}</dt><dd><Badge value={flag(payments?.enabled)}/></dd></div></dl>
      <p className="admin-muted">{t('订单与到账情况在充值订单中查看。')}</p>
      <footer><button onClick={() => onNavigate('payments')}>{t('查看充值订单')}<ArrowRight size={16}/></button></footer>
    </section>
    <section className="admin-panel admin-setting-card">
      <header><ListChecks size={22}/><div><h2>{t('运维与审计')}</h2><p>{t('查看服务配置、存储备份和管理操作记录。')}</p></div></header>
      <div className="admin-setting-note"><strong>{t('操作有据可查')}</strong><p>{t('账号、积分和设置操作继续保留原有审计记录。')}</p></div>
      <footer><button onClick={() => onNavigate('operations')}>{t('系统状态')}<ArrowRight size={16}/></button><button onClick={() => onNavigate('audit')}>{t('操作日志')}</button></footer>
    </section>
  </div>;
}
