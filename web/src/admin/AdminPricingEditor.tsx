import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { adminText } from "./i18n";
import { buildMediaPriceSections, type AdminModelRow } from "./modelPricing";

type Props = {
  lang: string;
  models: AdminModelRow[];
  costPolicy: Record<string, any>;
  settings: Record<string, any>;
  form: Record<string, any>;
  setForm: Dispatch<SetStateAction<Record<string, any>>>;
  initialFocus?: string;
};

const COST_FIELDS = [
  {
    key: "paymentFeePercent",
    label: "支付总手续费（%）",
    min: "0",
    max: "50",
    step: "0.01",
  },
  {
    key: "serverAnnualUsd",
    label: "服务器年费（美元）",
    min: "0",
    max: "1000000",
    step: "0.01",
  },
  {
    key: "usdToRmb",
    label: "预算汇率（元/美元）",
    min: "0.000001",
    max: "100",
    step: "0.000001",
  },
  {
    key: "serverMonthlyRmb",
    label: "服务器月费（元，可覆盖美元折算）",
    min: "0",
    max: "1000000",
    step: "0.01",
  },
  {
    key: "monthlyMediaRequests",
    label: "预计每月图片与视频请求数",
    min: "1",
    max: "10000000000",
    step: "1",
  },
  {
    key: "monthlyBillableVideoSeconds",
    label: "预计每月付费生成视频秒数",
    min: "1",
    max: "10000000000",
    step: "1",
  },
  {
    key: "otherRmbPerSecond",
    label: "其他成本（元/生成秒）",
    min: "0",
    max: "10000",
    step: "0.000001",
  },
];

function hasVideoExpenses(policy: Record<string, unknown> = {}) {
  const known = (key: string) =>
    policy[key] !== null &&
    policy[key] !== undefined &&
    policy[key] !== "" &&
    Number.isFinite(Number(policy[key]));
  return (
    known("paymentFeePercent") &&
    known("otherRmbPerSecond") &&
    (policy.serverAllocationMode === "all_media_requests"
      ? known("monthlyMediaRequests") && Number(policy.monthlyMediaRequests) > 0
      : known("monthlyBillableVideoSeconds") &&
        Number(policy.monthlyBillableVideoSeconds) > 0) &&
    (known("serverMonthlyRmb") ||
      (known("serverAnnualUsd") &&
        known("usdToRmb") &&
        Number(policy.usdToRmb) > 0))
  );
}

export default function AdminPricingEditor({
  lang,
  models,
  costPolicy,
  settings,
  form,
  setForm,
  initialFocus,
}: Props) {
  const t = (value: string) => adminText(value, lang);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | "image" | "video" | "text">("all");
  const sections = buildMediaPriceSections(models, costPolicy);
  const textModels = models.filter((model) => model.kind === "text");

  useEffect(() => {
    if (!initialFocus) return;
    const model = models.find((item) => item.id === initialFocus);
    if (!model) return;
    setQuery(model.id);
    setKind("all");
  }, [initialFocus]);

  function updateMediaPrice(
    id: string,
    mediaKind: "image" | "video",
    tier: string,
    value: string,
  ) {
    setForm((current) => ({
      ...current,
      prices: {
        ...(current.prices || {}),
        [id]: {
          ...(current.prices?.[id] || {}),
          [mediaKind]: {
            ...(current.prices?.[id]?.[mediaKind] || {}),
            [tier]: value,
          },
        },
      },
    }));
  }

  function updateTextPrice(id: string, key: string, value: string) {
    setForm((current) => ({
      ...current,
      textPrices: {
        ...(current.textPrices || {}),
        [id]: {
          ...(current.textPrices?.[id] || {}),
          [key]: value,
        },
      },
    }));
  }

  function updateCost(key: string, value: string) {
    setForm((current) => ({
      ...current,
      videoPricing: {
        ...(current.videoPricing || {}),
        [key]: value === "" ? null : Number(value),
      },
    }));
  }

  const term = query.trim().toLowerCase();
  const visibleSections = sections.filter((section) => {
    if (kind !== "all" && section.kind !== kind) return false;
    return (
      !term || `${section.label} ${section.id}`.toLowerCase().includes(term)
    );
  });
  const visibleTextModels = textModels.filter((model) => {
    if (kind !== "all" && kind !== "text") return false;
    return !term || `${model.label} ${model.id}`.toLowerCase().includes(term);
  });
  const totalVisible = visibleSections.length + visibleTextModels.length;
  const hasExpenses = hasVideoExpenses(form.videoPricing);

  return (
    <div className="pricing-editor">
      <div className="pricing-intro">
        <div>
          <span className="model-eyebrow">PRICE MATRIX</span>
          <h2>{t("全部模型积分")}</h2>
          <p>
            {t(
              "图片、视频和文本模型统一调价。成本加成视频保留自动报价；只有你改动过的档位才会保存为手动固定积分价。",
            )}
          </p>
        </div>
        <span className="pricing-count">
          {totalVisible} {t("个模型")}
        </span>
      </div>

      <div className="pricing-toolbar">
        <label className="admin-search model-search">
          <span aria-hidden="true">⌕</span>
          <input
            aria-label={t("搜索待调价模型")}
            placeholder={t("搜索名称或模型 ID")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div
          className="model-filter"
          role="group"
          aria-label={t("定价模型类型")}
        >
          {(
            [
              ["all", t("全部"), sections.length + textModels.length],
              [
                "image",
                t("图片"),
                sections.filter((section) => section.kind === "image").length,
              ],
              [
                "video",
                t("视频"),
                sections.filter((section) => section.kind === "video").length,
              ],
              ["text", t("文本"), textModels.length],
            ] as const
          ).map(([key, label, count]) => (
            <button
              key={key}
              aria-pressed={kind === key}
              onClick={() => setKind(key)}
            >
              {label}
              <span>{count}</span>
            </button>
          ))}
        </div>
      </div>

      {visibleSections.length > 0 && (
        <section className="pricing-group">
          <header>
            <div>
              <span className="pricing-group-index">01</span>
              <h3>{t("图片与视频")}</h3>
            </div>
            <small>{t("按尺寸/分辨率分别设置，保存后用于新请求。")}</small>
          </header>
          <div className="pricing-card-grid">
            {visibleSections.map((section) => {
              const automatic = section.pricingMode === "cost_plus";
              const manual = Boolean(
                settings?.prices?.[section.id]?.image ||
                  settings?.prices?.[section.id]?.video,
              );
              return (
                <fieldset className="pricing-card" key={section.id}>
                  <legend>{section.label}</legend>
                  <div className="pricing-card-head">
                    <code>{section.id}</code>
                    <span
                      className={`model-policy ${automatic ? "automatic" : ""} ${manual ? "manual" : ""}`}
                    >
                      {manual
                        ? t("手动固定价")
                        : automatic
                          ? t("成本加成自动价")
                          : t("固定积分价")}
                    </span>
                  </div>
                  {automatic && !manual && (
                    <p className="pricing-note">
                      {t(
                        "下面是当前自动报价。保持不动会继续自动计算；修改任一档位后，该档位改用手动积分价。",
                      )}
                    </p>
                  )}
                  <div className="pricing-tier-list">
                    {section.tiers.map((tier) => (
                      <label className="pricing-field" key={tier.key}>
                        <span>{tier.label}</span>
                        <input
                          aria-label={`${section.label} ${tier.label}`}
                          type="number"
                          required
                          min="0.01"
                          max="10000"
                          step="any"
                          value={
                            form.prices?.[section.id]?.[section.kind]?.[
                              tier.key
                            ] ?? ""
                          }
                          onChange={(event) =>
                            updateMediaPrice(
                              section.id,
                              section.kind,
                              tier.key,
                              event.target.value,
                            )
                          }
                        />
                        <em>
                          {section.kind === "video"
                            ? t("积分 / 秒")
                            : t("积分 / 张")}
                        </em>
                      </label>
                    ))}
                  </div>
                </fieldset>
              );
            })}
          </div>
        </section>
      )}

      {visibleTextModels.length > 0 && (
        <section className="pricing-group">
          <header>
            <div>
              <span className="pricing-group-index">02</span>
              <h3>{t("文本模型")}</h3>
            </div>
            <small>
              {t("输入和输出 token 分开计价，最低积分用于极短请求。")}
            </small>
          </header>
          <div className="pricing-text-list">
            {visibleTextModels.map((model) => (
              <fieldset className="pricing-text-card" key={model.id}>
                <legend>{model.label}</legend>
                <code>{model.id}</code>
                <div className="pricing-text-fields">
                  <label className="pricing-field">
                    <span>{t("输入 / 百万 token")}</span>
                    <input
                      type="number"
                      required
                      min="0"
                      max="1000000"
                      step="0.0001"
                      value={
                        form.textPrices?.[model.id]
                          ?.inputCreditsPerMillionTokens ?? 0
                      }
                      onChange={(event) =>
                        updateTextPrice(
                          model.id,
                          "inputCreditsPerMillionTokens",
                          event.target.value,
                        )
                      }
                    />
                    <em>{t("积分")}</em>
                  </label>
                  <label className="pricing-field">
                    <span>{t("输出 / 百万 token")}</span>
                    <input
                      type="number"
                      required
                      min="0"
                      max="1000000"
                      step="0.0001"
                      value={
                        form.textPrices?.[model.id]
                          ?.outputCreditsPerMillionTokens ?? 0
                      }
                      onChange={(event) =>
                        updateTextPrice(
                          model.id,
                          "outputCreditsPerMillionTokens",
                          event.target.value,
                        )
                      }
                    />
                    <em>{t("积分")}</em>
                  </label>
                  <label className="pricing-field">
                    <span>{t("每次最低积分")}</span>
                    <input
                      type="number"
                      required
                      min="0"
                      max="1000000"
                      step="0.0001"
                      value={form.textPrices?.[model.id]?.minimumCredits ?? 0}
                      onChange={(event) =>
                        updateTextPrice(
                          model.id,
                          "minimumCredits",
                          event.target.value,
                        )
                      }
                    />
                    <em>{t("积分")}</em>
                  </label>
                </div>
              </fieldset>
            ))}
          </div>
        </section>
      )}

      {!totalVisible && <p className="admin-empty">{t("没有匹配的模型。")}</p>}

      <details className="pricing-costs">
        <summary>
          <span>{t("成本与净利参数")}</span>
          <small>{hasExpenses ? t("已配置") : t("待补全")}</small>
        </summary>
        <div className="pricing-cost-grid">
          <label className="pricing-field">
            <span>{t("秘塔每积分成本（元）")}</span>
            <input
              type="number"
              required
              min="0.008798"
              max="1"
              step="0.000001"
              value={form.videoPricing?.metasoRmbPerCredit ?? 0.0108}
              onChange={(event) =>
                updateCost("metasoRmbPerCredit", event.target.value)
              }
            />
          </label>
          <label className="pricing-field">
            <span>{t("服务器分摊方式")}</span>
            <select
              value={form.videoPricing?.serverAllocationMode || "video_seconds"}
              onChange={(event) =>
                updateCost("serverAllocationMode", event.target.value)
              }
            >
              <option value="video_seconds">{t("按视频生成秒数分摊")}</option>
              <option value="all_media_requests">
                {t("全站图片与视频请求共同分摊")}
              </option>
            </select>
          </label>
          <label className="pricing-field">
            <span>{t("目标净利每秒（元）")}</span>
            <input
              type="number"
              required
              min="0.10"
              max="100"
              step="0.01"
              value={form.videoPricing?.markupPerSecond ?? 0.1}
              onChange={(event) =>
                updateCost("markupPerSecond", event.target.value)
              }
            />
          </label>
          {COST_FIELDS.map((field) => (
            <label className="pricing-field" key={field.key}>
              <span>{t(field.label)}</span>
              <input
                type="number"
                min={field.min}
                max={field.max}
                step={field.step}
                value={form.videoPricing?.[field.key] ?? ""}
                onChange={(event) => updateCost(field.key, event.target.value)}
              />
            </label>
          ))}
        </div>
        <p className="pricing-note">
          {hasExpenses
            ? t("成本参数已配置；实际生成量下降时应重新调整分摊。")
            : t("成本参数未补全，不能据此刻意确认净利达标。")}
        </p>
      </details>
    </div>
  );
}
