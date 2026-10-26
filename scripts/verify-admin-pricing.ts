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
import { estimateGenerationCost } from "../server/generation-cost.ts";
import { suihePricingSnapshot } from "../server/suihe-pricing.ts";
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

// Default image/video surcharges must survive quotation, reservation and refunds. Run
// against an isolated in-memory ledger without submitting an upstream task.
const billing = new ManagementStore(":memory:");
billing.saveSettings({ modelChannels: { 'doubao-seedream-4-0': { suihe: true, ark: false } } }, 'verification');
const { user } = billing.createUser({ name: "pricing-check", email: "pricing-check@example.invalid", password: "isolated-pricing-check", points: 10 }, "verification");
const session = { role: "user", userId: user.id };
const image = modelById("doubao-seedream-4-0");
const imageQuote = estimateGenerationCost({ model: image, generation: { size: "2K", count: 1 } });
assert.equal(imageQuote.points, 0.405);
const imageReservation = billing.reserve({ session, model: image, points: imageQuote.points, prompt: "pricing only", parameters: { size: "2K", count: 1 }, status: "queued" });
assert.equal(billing.user(user.id).points, 9.595);
billing.cancel(imageReservation.requestId, session);
assert.equal(billing.user(user.id).points, 10);

const suiheVideo = modelById("seedance-2.0");
const parameters = { duration: 4, resolution: "480p", ratio: "16:9", suiheCost: suihePricingSnapshot(suiheVideo, { resolution: "480p" }) };
const quote = estimateGenerationCost({ model: suiheVideo, generation: parameters });
assert.equal(quote.breakdown.customerMarkupRmb, 0.2);
const reservation = billing.reserve({ session, model: suiheVideo, points: quote.points, prompt: "pricing only", parameters, status: "running" });
billing.completeVideo(reservation.id, { id: "isolated-result", url: "https://example.invalid/never-fetched.mp4", duration: 4, usage: { completion_tokens: 10000 } });
assert.equal(billing.get("SELECT charged_points FROM generations WHERE id=?", reservation.id).charged_points, 0.5726);
assert.equal(billing.user(user.id).points, 9.4274);
assert.equal(Math.round(billing.get("SELECT SUM(delta) AS balance FROM ledger WHERE user_id=?", user.id).balance * 10000) / 10000, 9.4274);
assert.equal(estimateGenerationCost({ model: suiheVideo, generation: { ...parameters, submissionState: "started", suiheCost: { ...parameters.suiheCost, customerMarkupRmbPerUnit: 0.5 } } }).breakdown.customerMarkupRmb, 2);
assert.equal(estimateGenerationCost({ model: suiheVideo, generation: { ...parameters, submissionState: "started", suiheCost: { ...parameters.suiheCost, customerMarkupRmbPerUnit: 0.005 } } }).breakdown.customerMarkupRmb, 0.02);
console.log("Suihe half-jiao video surcharge, exact debit/refund and frozen historical surcharge verified; no upstream call.");
