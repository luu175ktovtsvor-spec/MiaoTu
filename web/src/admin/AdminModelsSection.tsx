import { Empty } from "./components";
import { adminText } from "./i18n";
import {
  buildMediaPriceSections,
  mediaPriceValues,
  pricingModeLabel,
  type AdminModelRow,
} from "./modelPricing";

type Props = {
  lang: string;
  models: AdminModelRow[];
  settings: Record<string, any>;
  costPolicy: Record<string, any>;
  search: string;
  kindFilter: string;
  busy: boolean;
  onSearch: (value: string) => void;
  onKindFilter: (value: string) => void;
  onToggle: (model: AdminModelRow, enabled: boolean) => void;
  onToggleChannel: (
    model: AdminModelRow,
    provider: string,
    enabled: boolean,
  ) => void;
  onOpenPrices: (modelId?: string) => void;
};

export default function AdminModelsSection({
  lang,
  models,
  settings,
  costPolicy,
  search,
  kindFilter,
  busy,
  onSearch,
  onKindFilter,
  onToggle,
  onToggleChannel,
  onOpenPrices,
}: Props) {
  const t = (value: string) => adminText(value, lang);
  const counts = {
    image: models.filter((model) => model.kind === "image").length,
    video: models.filter((model) => model.kind === "video").length,
    text: models.filter((model) => model.kind === "text").length,
  };
  const visible = models.filter((model) => {
    if (kindFilter && model.kind !== kindFilter) return false;
    const term = search.trim().toLowerCase();
    return !term || `${model.label} ${model.id}`.toLowerCase().includes(term);
  });
  const sections = new Map(
    buildMediaPriceSections(models, costPolicy).map((section) => [
      section.id,
      section,
    ]),
  );
  const activeCount = models.filter(
    (model) => settings?.models?.[model.id] !== false,
  ).length;

  return (
    <div className="model-directory">
      <section className="model-hero">
        <div>
          <span className="model-eyebrow">MODEL CONTROL</span>
          <h2>{t("模型目录与积分")}</h2>
          <p>
            {t(
              "所有妙图自营模型都在这里统一开关和调价。成本加成模型会显示当前自动报价，也可以直接改成固定积分价。",
            )}
          </p>
        </div>
        <button
          className="primary model-price-button"
          disabled={busy || !models.length}
          onClick={() => onOpenPrices()}
        >
          {t("编辑全部积分")}
        </button>
      </section>

      <section className="model-summary" aria-label={t("模型概况")}>
        <div>
          <span>{t("已开放")}</span>
          <strong>{activeCount}</strong>
          <small>
            {lang === "en"
              ? `${models.length} models total`
              : `共 ${models.length} 个模型`}
          </small>
        </div>
        <div>
          <span>{t("图片模型")}</span>
          <strong>{counts.image}</strong>
          <small>{t("按张或尺寸计价")}</small>
        </div>
        <div>
          <span>{t("视频模型")}</span>
          <strong>{counts.video}</strong>
          <small>{t("按秒和实际成本计价")}</small>
        </div>
        <div>
          <span>{t("文本模型")}</span>
          <strong>{counts.text}</strong>
          <small>{t("按 token 用量计价")}</small>
        </div>
      </section>

      <section className="model-browser">
        <header className="model-toolbar">
          <label className="admin-search model-search">
            <span aria-hidden="true">⌕</span>
            <input
              aria-label={t("搜索模型")}
              placeholder={t("搜索名称或模型 ID")}
              value={search}
              onChange={(event) => onSearch(event.target.value)}
            />
          </label>
          <div className="model-filter" role="group" aria-label={t("模型类型")}>
            {[
              ["", t("全部"), models.length],
              ["image", t("图片"), counts.image],
              ["video", t("视频"), counts.video],
              ["text", t("文本"), counts.text],
            ].map(([key, label, count]) => (
              <button
                key={String(key)}
                aria-pressed={kindFilter === key}
                onClick={() => onKindFilter(String(key))}
              >
                {label}
                <span>{count}</span>
              </button>
            ))}
          </div>
        </header>

        {visible.length ? (
          <div className="model-grid">
            {visible.map((model) => {
              const enabled = settings?.models?.[model.id] !== false;
              const rate =
                model.kind === "text"
                  ? costPolicy?.textModels?.[model.id] || {}
                  : costPolicy?.models?.[model.id] || {};
              const values = mediaPriceValues(model, rate);
              const low = values.length ? Math.min(...values) : null;
              const high = values.length ? Math.max(...values) : null;
              const section = sections.get(model.id);
              const channels = Array.isArray(model.channels) ? model.channels : [];
              const manual =
                !["text"].includes(model.kind) &&
                Boolean(
                  settings?.prices?.[model.id]?.image ||
                    settings?.prices?.[model.id]?.video,
                );
              return (
                <article
                  className={`model-card ${enabled ? "" : "is-paused"}`}
                  key={model.id}
                >
                  <header>
                    <div className="model-kind-mark" aria-hidden="true">
                      {model.kind === "image"
                        ? "IMG"
                        : model.kind === "video"
                          ? "VID"
                          : "TXT"}
                    </div>
                    <div className="model-card-title">
                      <h3>{model.label}</h3>
                      <code>{model.id}</code>
                    </div>
                    <button
                      className={`admin-switch ${enabled ? "on" : ""}`}
                      role="switch"
                      aria-checked={enabled}
                      aria-label={t("{name} 开放状态").replace(
                        "{name}",
                        model.label,
                      )}
                      disabled={busy}
                      onClick={() => onToggle(model, enabled)}
                    >
                      <span />
                    </button>
                  </header>

                  <div className="model-card-tags">
                    <span
                      className={`channel-state ${model.configured ? "ready" : ""}`}
                    >
                      {model.configured ? t("通道已配置") : t("未配置通道")}
                    </span>
                    <span className={`model-policy ${manual ? "manual" : ""}`}>
                      {manual
                        ? t("手动积分价")
                        : t(pricingModeLabel(model, costPolicy))}
                    </span>
                  </div>

                  <div className="model-route-meta">
                    <div>
                      <span>{t("当前上游")}</span>
                      <strong>{model.providerLabel || model.provider || t("未选择")}</strong>
                    </div>
                    <div>
                      <span>{t("上游模型 ID")}</span>
                      <code>{model.upstreamModelId || model.id}</code>
                    </div>
                  </div>

                  {channels.length > 0 && (
                    <div className="model-channel-list" aria-label={t("渠道开关")}>
                      {channels.map((channel) => {
                        const channelEnabled = channel.enabled === true;
                        const channelConfigured = channel.configured === true;
                        return (
                          <div className="model-channel-row" key={channel.provider}>
                            <div className="model-channel-copy">
                              <strong>{channel.providerLabel || channel.provider}</strong>
                              <code>{channel.upstreamModelId || model.id}</code>
                              <span className={channelConfigured ? "is-ready" : ""}>
                                {channelConfigured ? t("已配置") : t("未配置")}
                              </span>
                              {channel.active && <em>{t("当前")}</em>}
                            </div>
                            <button
                              className={`admin-switch compact ${channelEnabled ? "on" : ""}`}
                              role="switch"
                              aria-checked={channelEnabled}
                              aria-label={`${channel.providerLabel || channel.provider} ${t("渠道开关")}`}
                              disabled={busy || (!channelConfigured && !channelEnabled)}
                              onClick={() => onToggleChannel(model, channel.provider, channelEnabled)}
                            >
                              <span />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <div className="model-price-preview">
                    {model.kind === "text" ? (
                      <>
                        <span>{t("输入 / 输出")}</span>
                        <strong>
                          {rate.inputCreditsPerMillionTokens ?? 0} /{" "}
                          {rate.outputCreditsPerMillionTokens ?? 0}
                          <small>{t("积分 / 百万 token")}</small>
                        </strong>
                      </>
                    ) : low == null ? (
                      <span>{t("价格尚未生成")}</span>
                    ) : (
                      <>
                        <span>
                          {model.kind === "video"
                            ? t("每秒积分")
                            : t("每张积分")}
                        </span>
                        <strong>
                          {low === high ? low : `${low}–${high}`}
                          <small>
                            {section?.pricingMode === "cost_plus" && !manual
                              ? t("当前自动报价")
                              : t("当前有效价")}
                          </small>
                        </strong>
                      </>
                    )}
                  </div>

                  <footer>
                    <span>
                      {enabled ? t("已开放给客户端") : t("已从客户端隐藏")}
                    </span>
                    <button onClick={() => onOpenPrices(model.id)}>
                      {t("调整积分")}
                    </button>
                  </footer>
                </article>
              );
            })}
          </div>
        ) : (
          <Empty>{t("没有匹配的模型。")}</Empty>
        )}
      </section>
    </div>
  );
}
