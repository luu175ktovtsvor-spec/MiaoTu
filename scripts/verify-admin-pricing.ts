import assert from "node:assert/strict";
import { ManagementStore } from "../server/management-store.ts";
import {
  modelById,
  modelCatalog,
  publicModelCatalog,
  publicVideoCatalog,
} from "../server/image-models.ts";
import { DEFAULT_TEXT_PRICES } from "../server/text-pricing.ts";
import { ownTextModelIds } from "../server/text-model-registry.ts";
import {
  buildMediaPriceSections,
  buildPricingDraft,
  type AdminModelRow,
} from "../web/src/admin/modelPricing.ts";

const rows: AdminModelRow[] = [
  ...publicModelCatalog({}).map((model) => ({
    ...model,
    kind: "image" as const,
  })),
  ...publicVideoCatalog({}).map((model) => ({
    ...model,
    kind: "video" as const,
  })),
  ...ownTextModelIds().map((id) => ({
    id,
    label: id,
    kind: "text" as const,
    configured: true,
  })),
];

const textModels = Object.fromEntries(
  ownTextModelIds().map((id) => [
    id,
    {
      inputCreditsPerMillionTokens:
        DEFAULT_TEXT_PRICES[id].inputCreditsPerMillionTokens,
      outputCreditsPerMillionTokens:
        DEFAULT_TEXT_PRICES[id].outputCreditsPerMillionTokens,
      minimumCredits: DEFAULT_TEXT_PRICES[id].minimumCredits,
    },
  ]),
);
const costPolicy = {
  models: {},
  textModels,
};

const sections = buildMediaPriceSections(rows, costPolicy);
assert.equal(
  sections.length,
  rows.filter((model) => model.kind !== "text").length,
  "every image and video model must have a pricing row",
);
assert.equal(
  rows.filter((model) => model.kind === "text").length,
  ownTextModelIds().length,
  "every text model must have a pricing row",
);

const draft = buildPricingDraft(rows, costPolicy, {});
for (const section of sections) {
  assert.ok(
    draft.prices[section.id],
    `${section.id} is missing from the pricing draft`,
  );
  assert.equal(
    Object.keys(draft.prices[section.id][section.kind]).length,
    section.tiers.length,
    `${section.id} does not expose every size/resolution tier`,
  );
}

const store = new ManagementStore(":memory:");
const source = store.costPolicy();
const videoId = modelCatalog()
  .filter((model: any) => model.video)
  .map((model: any) => model.publicId || model.id)
  .find((id: string) => source.models[id]?.pricingMode === "cost_plus");
assert.ok(videoId, "at least one cost-plus video model must be present");
const video = modelById(videoId);
const tier = source.models[videoId].sizes[0];
store.saveSettings(
  { prices: { [videoId]: { video: { [tier]: 1.23 } } } },
  "pricing-verification",
);

let refreshed = store.costPolicy();
assert.equal(refreshed.models[videoId].pricingMode, "cost_plus");
assert.equal(
  refreshed.models[videoId].creditsPerSecond[tier],
  1.23,
  "a manual price must override the cost-plus quote",
);

store.saveSettings(
  {
    textPrices: {
      [ownTextModelIds()[0]]: {
        inputCreditsPerMillionTokens: 2,
        outputCreditsPerMillionTokens: 4,
        minimumCredits: 0.01,
      },
    },
  },
  "pricing-verification",
);
refreshed = store.costPolicy();
assert.equal(
  refreshed.textModels[ownTextModelIds()[0]].inputCreditsPerMillionTokens,
  2,
);
assert.equal(
  refreshed.textModels[ownTextModelIds()[0]].outputCreditsPerMillionTokens,
  4,
);

console.log(
  `Admin pricing verification passed: ${sections.length} image/video rows, ` +
    `${ownTextModelIds().length} text rows, ${video.label} manual override ${tier}=1.23`,
);
