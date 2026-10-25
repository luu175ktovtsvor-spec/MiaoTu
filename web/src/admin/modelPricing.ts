export type AdminModelKind = "image" | "video" | "text";

export type AdminModelRow = {
  id: string;
  label: string;
  kind: AdminModelKind;
  configured?: boolean;
  paused?: boolean;
  video?: boolean;
  sizes?: Array<{ value: string; label?: string }>;
  [key: string]: unknown;
};

export type MediaPriceSection = {
  id: string;
  label: string;
  kind: Exclude<AdminModelKind, "text">;
  tiers: Array<{ key: string; label: string }>;
  pricingMode: "cost_plus" | "fixed";
};

export type PricingDraft = {
  prices: Record<
    string,
    Partial<Record<"image" | "video", Record<string, string | number>>>
  >;
  textPrices: Record<
    string,
    {
      inputCreditsPerMillionTokens: string | number;
      outputCreditsPerMillionTokens: string | number;
      cacheReadCreditsPerMillionTokens: string | number;
      cacheWriteCreditsPerMillionTokens: string | number;
      minimumCredits: string | number;
    }
  >;
  videoPricing: Record<string, unknown>;
};

export function buildMediaPriceSections(
  models: AdminModelRow[],
  costPolicy: Record<string, any> = {},
): MediaPriceSection[] {
  return models
    .filter((model) => model.kind !== "text")
    .map((model) => {
      const kind = model.kind as "image" | "video";
      const sizes = (model.sizes || [])
        .map((size) => String(size.value || "").trim())
        .filter(Boolean);
      const tiers = sizes.length ? sizes : ["default"];
      return {
        id: model.id,
        label: model.label,
        kind,
        tiers: tiers.map((key) => ({
          key,
          label:
            key === "default" ? "其他尺寸" : key === "auto" ? "自动" : key,
        })),
        pricingMode:
          costPolicy?.models?.[model.id]?.pricingMode === "cost_plus"
            ? "cost_plus"
            : "fixed",
      };
    });
}

export function buildPricingDraft(
  models: AdminModelRow[],
  costPolicy: Record<string, any> = {},
  settings: Record<string, any> = {},
): PricingDraft {
  const mediaPolicy = costPolicy?.models || {};
  const prices: PricingDraft["prices"] = {};
  for (const section of buildMediaPriceSections(models, costPolicy)) {
    const rate = mediaPolicy[section.id] || {};
    const tiers = Object.fromEntries(
      section.tiers.map((tier) => [tier.key, ""]),
    );
    if (section.kind === "video") {
      for (const tier of section.tiers) {
        tiers[tier.key] =
          rate.creditsPerSecond?.[tier.key] ??
          rate.defaultCreditsPerSecond ??
          "";
      }
      prices[section.id] = { video: tiers };
    } else {
      for (const tier of section.tiers) {
        tiers[tier.key] =
          rate.creditsPerImageBySize?.[tier.key] ??
          (tier.key === "default" ? rate.creditsPerImage : "") ??
          "";
      }
      prices[section.id] = { image: tiers };
    }
  }

  const textPolicy = costPolicy?.textModels || {};
  const textPrices = Object.fromEntries(
    models
      .filter((model) => model.kind === "text")
      .map((model) => {
        const rate = textPolicy[model.id] || {};
        return [
          model.id,
          {
            inputCreditsPerMillionTokens:
              rate.inputCreditsPerMillionTokens ?? 0,
            outputCreditsPerMillionTokens:
              rate.outputCreditsPerMillionTokens ?? 0,
            cacheReadCreditsPerMillionTokens: rate.cacheReadCreditsPerMillionTokens ?? rate.inputCreditsPerMillionTokens ?? 0,
            cacheWriteCreditsPerMillionTokens: rate.cacheWriteCreditsPerMillionTokens ?? rate.inputCreditsPerMillionTokens ?? 0,
            minimumCredits: rate.minimumCredits ?? 0,
          },
        ];
      }),
  );

  return {
    prices,
    textPrices,
    videoPricing: { ...(settings.videoPricing || {}) },
  };
}

export function mediaPriceValues(
  model: AdminModelRow,
  rate: Record<string, any> = {},
): number[] {
  const values =
    model.kind === "video"
      ? Object.values(rate.creditsPerSecond || {})
      : Object.values(rate.creditsPerImageBySize || {});
  const fallback =
    model.kind === "video"
      ? rate.defaultCreditsPerSecond
      : rate.creditsPerImage;
  if (!values.length && fallback != null) values.push(fallback);
  return values.map(Number).filter(Number.isFinite);
}

export function pricingModeLabel(
  model: AdminModelRow,
  costPolicy: Record<string, any> = {},
) {
  if (model.kind === "text") return "按 token 用量";
  return costPolicy?.models?.[model.id]?.pricingMode === "cost_plus"
    ? "成本加成自动价"
    : "固定积分价";
}
