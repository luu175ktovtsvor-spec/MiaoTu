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

const store = (await ManagementStore.open(":memory:"));
const source = (await store.costPolicy());
const videoId = modelCatalog()
  .filter((model: any) => model.video)
  .map((model: any) => model.publicId || model.id)
  .find((id: string) => source.models[id]?.pricingMode === "cost_plus");
assert.ok(videoId, "at least one cost-plus video model must be present");
const video = modelById(videoId);
const tier = source.models[videoId].sizes[0];
await store.saveSettings(
  { prices: { [videoId]: { video: { [tier]: 1.23 } } } },
  "pricing-verification",
);

let refreshed = (await store.costPolicy());
assert.equal(refreshed.models[videoId].pricingMode, "cost_plus");
assert.equal(
  refreshed.models[videoId].creditsPerSecond[tier],
  1.23,
  "a manual price must override the cost-plus quote",
);

await store.saveSettings(
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
refreshed = (await store.costPolicy());
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
const billing = (await ManagementStore.open(":memory:"));
await billing.saveSettings({ modelChannels: { 'doubao-seedream-4-0': { suihe: true, ark: false } } }, 'verification');
const { user } = (await billing.createUser({ name: "pricing-check", email: "pricing-check@example.invalid", password: "isolated-pricing-check", points: 10 }, "verification"));
const session = { role: "user", userId: user.id };
const image = modelById("doubao-seedream-4-0");
const imageQuote = estimateGenerationCost({ model: image, generation: { size: "2K", count: 1 } });
assert.equal(imageQuote.points, 0.405);
const imageReservation = (await billing.reserve({ session, model: image, points: imageQuote.points, prompt: "pricing only", parameters: { size: "2K", count: 1 }, status: "queued" }));
assert.equal((await billing.user(user.id)).points, 9.595);
await billing.cancel(imageReservation.requestId, session);
assert.equal((await billing.user(user.id)).points, 10);

const suiheVideo = modelById("seedance-2.0");
const parameters = { duration: 4, resolution: "480p", ratio: "16:9", suiheCost: suihePricingSnapshot(suiheVideo, { resolution: "480p" }) };
const quote = estimateGenerationCost({ model: suiheVideo, generation: parameters });
assert.equal(quote.breakdown.customerMarkupRmb, 0.4);
const reservation = (await billing.reserve({ session, model: suiheVideo, points: quote.points, prompt: "pricing only", parameters, status: "running" }));
await billing.completeVideo(reservation.id, { id: "isolated-result", url: "https://example.invalid/never-fetched.mp4", duration: 4, usage: { completion_tokens: 10000 } });
assert.equal((await billing.get("SELECT charged_points FROM generations WHERE id=?", reservation.id)).charged_points, 0.7726);
assert.equal((await billing.user(user.id)).points, 9.2274);
assert.equal(Math.round((await billing.get("SELECT SUM(delta) AS balance FROM ledger WHERE user_id=?", user.id)).balance * 10000) / 10000, 9.2274);
assert.equal(estimateGenerationCost({ model: suiheVideo, generation: { ...parameters, submissionState: "started", suiheCost: { ...parameters.suiheCost, customerMarkupRmbPerUnit: 0.5 } } }).breakdown.customerMarkupRmb, 2);
assert.equal(estimateGenerationCost({ model: suiheVideo, generation: { ...parameters, submissionState: "started", suiheCost: { ...parameters.suiheCost, customerMarkupRmbPerUnit: 0.005 } } }).breakdown.customerMarkupRmb, 0.02);
assert.equal(estimateGenerationCost({ model: suiheVideo, generation: { ...parameters, submissionState: "started", suiheCost: undefined } }).breakdown.customerMarkupRmb, 0.2);
console.log("Suihe RMB 0.10/output-second surcharge, exact debit/refund and frozen historical surcharge verified; no upstream call.");

// New Ark layer settlements use original output pixels and frozen prices.
// All users, ledgers and stored bytes in this block are isolated in memory.
const { activeModelForSettings } = await import('../server/image-models.ts');
const { imageLayerPricingSnapshot, setPricingOverrides } = await import('../server/generation-cost.ts');
const { imageLayerDimensions, hasPngAlphaChannel, IMAGE_LAYER_UNCONFIRMED_BASIS } = await import('../server/image-layer-pricing.ts');
const { deflateSync } = await import('node:zlib');
const pngCrc = (bytes: Buffer) => {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
};
const pngChunk = (type: string, bytes: Buffer) => {
  const result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length); result.write(type, 4, 'ascii'); bytes.copy(result, 8);
  result.writeUInt32BE(pngCrc(result.subarray(4, 8 + bytes.length)), 8 + bytes.length);
  return result;
};
const layerPng = (width: number, height: number) => {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * height))), pngChunk('IEND', Buffer.alloc(0))]);
};
const layerBytes = [layerPng(2048, 2048), layerPng(1024, 1024), layerPng(1536, 1536)];
const newLayerStore = async () => {
  const value = (await ManagementStore.open(':memory:'));
  await value.saveSettings({ modelChannels: { 'doubao-seedream-5-0-pro': { ark: true, suihe: false } } }, 'verification');
  const { user } = (await value.createUser({ name: 'layer-pricing-check', email: 'layer-pricing@example.invalid', password: 'isolated-layer-check', points: 100 }, 'verification'));
  const saved = new Map<string, Buffer>();
  value.artifactFiles = async () => ({ put: (_owner, id, bytes) => { saved.set(id, Buffer.from(bytes)); return { blob: null, size: bytes.length }; } });
  return { store: value, user, session: { role: 'user', userId: user.id }, saved };
};
const layerModel = activeModelForSettings('doubao-seedream-5-0-pro', {}, { OIP_MOCK_PROVIDERS: '1', ARK_API_KEY: 'fake', ARK_BASE_URL: 'http://127.0.0.1:9' });
assert.ok(layerModel);
const layerCase = async (manual?: number, legacy = false, reservedOverride?: number) => {
  const state = (await newLayerStore());
  if (manual !== undefined) await state.store.saveSettings({ prices: { 'doubao-seedream-5-0-pro': { image: manual } } }, 'verification');
  const snapshot = imageLayerPricingSnapshot(layerModel, { size: '2K', referenceCount: 1 });
  const parameters: Record<string, any> = { size: '2K', count: 17, layerDecomposition: true, upstreamProvider: 'ark', ...(legacy ? {} : { imageLayerPricing: snapshot }) };
  const quote = legacy ? { points: 11.9 } : estimateGenerationCost({ model: layerModel, generation: parameters });
  const reservation = (await state.store.reserve({ session: state.session, model: layerModel, points: reservedOverride ?? quote.points, prompt: 'pricing only', parameters, status: 'running' }));
  return { ...state, snapshot, parameters, reservation };
};
{
  const state = (await layerCase());
  assert.equal(state.snapshot.small.customerCredits, 0.25); assert.equal(state.snapshot.large.customerCredits, 0.4);
  assert.equal((await state.store.user(state.user.id)).points, 93.2);
  // Changing current prices after acceptance cannot change this job.
  await state.store.saveSettings({ prices: { 'doubao-seedream-5-0-pro': { image: 4.56 } } }, 'verification');
  const results = (await state.store.finish(state.reservation.id, layerBytes.map(bytes => ({ bytes, mime: 'image/png' }))));
  const row = (await state.store.get('SELECT * FROM generations WHERE id=?', state.reservation.id));
  assert.equal(row.charged_points, 0.9); assert.equal((await state.store.user(state.user.id)).points, 99.1);
  assert.equal(JSON.parse(row.upstream_cost).rmb, 0.6);
  assert.deepEqual(JSON.parse(row.parameters).imageLayerSettlement.layers.map(layer => layer.tier), ['large', 'small', 'small']);
  assert.deepEqual(results.map(result => state.saved.get(result.id)), layerBytes);
  const publicRow = (await state.store.publicGeneration(row));
  assert.equal(publicRow.parameters.imageLayerPricing, undefined); assert.equal(publicRow.parameters.imageLayerSettlement, undefined);
  await assert.rejects(async () => (await state.store.finish(state.reservation.id, [{ bytes: layerBytes[0], mime: 'image/png' }])));
  assert.equal((await state.store.user(state.user.id)).points, 99.1);
  await state.store.db.close();
}
{
  const state = (await layerCase(1.23));
  await state.store.finish(state.reservation.id, layerBytes.map(bytes => ({ bytes, mime: 'image/png' })));
  assert.equal((await state.store.get('SELECT charged_points FROM generations WHERE id=?', state.reservation.id)).charged_points, 3.69);
  await state.store.db.close();
}
{
  const state = (await layerCase(undefined, true));
  await state.store.finish(state.reservation.id, layerBytes.map(bytes => ({ bytes, mime: 'image/png' })));
  const row = (await state.store.get('SELECT * FROM generations WHERE id=?', state.reservation.id));
  assert.equal(row.charged_points, 2.1); assert.equal(JSON.parse(row.parameters).imageLayerPricing, undefined);
  await state.store.db.close();
}
{
  const state = (await layerCase(undefined, false, 0.5));
  await state.store.finish(state.reservation.id, layerBytes.map(bytes => ({ bytes, mime: 'image/png' })));
  assert.equal((await state.store.get('SELECT charged_points FROM generations WHERE id=?', state.reservation.id)).charged_points, 0.5);
  await state.store.db.close();
}
{
  const state = (await layerCase());
  await state.store.run('UPDATE generations SET upstream_cost=? WHERE id=?', JSON.stringify({ rmb: 5.1, basis: 'reservation_forecast' }), state.reservation.id);
  await state.store.recordUpstreamCall({ generationId: state.reservation.id, provider: 'ark', model: layerModel.publicId, kind: 'image', cost: { rmb: 5.1 }, status: 'submitted' });
  const bytes = Buffer.from('unreadable original bytes');
  const results = (await state.store.finish(state.reservation.id, [{ bytes, mime: 'image/png' }]));
  const row = (await state.store.get('SELECT * FROM generations WHERE id=?', state.reservation.id));
  assert.equal(row.status, 'succeeded'); assert.equal(row.charged_points, 0); assert.equal((await state.store.user(state.user.id)).points, 100);
  assert.equal(JSON.parse(row.upstream_cost).rmb, null); assert.equal(JSON.parse(row.upstream_cost).basis, IMAGE_LAYER_UNCONFIRMED_BASIS);
  assert.equal(JSON.parse(row.parameters).imageLayerSettlement.status, 'unconfirmed');
  assert.deepEqual(state.saved.get(results[0].id), bytes);
  assert.equal((await state.store.recordedGenerationCost(row)).rmb, null);
  assert.equal((await state.store.get('SELECT cost_rmb FROM upstream_calls WHERE generation_id=?', state.reservation.id)).cost_rmb, null);
  await state.store.recordUpstreamCall({ generationId: state.reservation.id, provider: 'ark', model: layerModel.publicId, kind: 'image', cost: (await state.store.recordedGenerationCost(row)), status: 'ok' });
  assert.equal((await state.store.get('SELECT cost_rmb FROM upstream_calls WHERE generation_id=?', state.reservation.id)).cost_rmb, null);
  const reconciliation = (await state.store.reconciliation({})).reconciliation;
  assert.equal(reconciliation.missingCostRows, 1); assert.equal(reconciliation.upstreamCostRmb, null); assert.equal(reconciliation.marginRmb, null);
  const overview = (await state.store.overview());
  assert.equal(overview.missingCostRows, 1); assert.equal(overview.costMatchedRows, 0); assert.equal(overview.upstreamCostRmb, null); assert.equal(overview.marginRmb, null);
  const record: any = (await state.store.records({}, true)).items[0];
  assert.equal(record.marginRmb, null); assert.equal(record.costEvidence.level, 'unknown');
  await state.store.db.close();
}
{
  const state = (await layerCase());
  state.store.artifactFiles = async () => ({ put: () => { throw new Error('isolated storage failure'); } });
  await assert.rejects(async () => (await state.store.finish(state.reservation.id, layerBytes.map(bytes => ({ bytes, mime: 'image/png' })))));
  assert.equal((await state.store.user(state.user.id)).points, 93.2);
  const row = (await state.store.get('SELECT * FROM generations WHERE id=?', state.reservation.id));
  assert.equal(row.status, 'running'); assert.equal(JSON.parse(row.parameters).imageLayerSettlement, undefined);
  await state.store.db.close();
}
assert.equal(hasPngAlphaChannel(layerBytes[0]), true);
assert.equal(hasPngAlphaChannel(Buffer.from([255,216,255,217])), false);
assert.equal(imageLayerDimensions(layerPng(0, 1)), null);
assert.equal(imageLayerDimensions(layerBytes[0].subarray(0, 32)), null);
const corruptPng = Buffer.from(layerBytes[0]); corruptPng[16] ^= 1;
assert.equal(imageLayerDimensions(corruptPng), null);
setPricingOverrides({});
console.log('Ark layer frozen pixel tiers, manual/legacy prices, capped settlement, original preservation and unknown-cost refunds verified in memory; no upstream call.');

// Administrators can retain four-decimal video rates without changing images.
const precise = (await ManagementStore.open(':memory:'));
await precise.saveSettings({ prices: { 'grok-imagine-video-1.5': { video: { '1080p': 0.66 } } } }, 'verification');
await precise.saveSettings({ prices: { 'grok-imagine-video-1.5': { video: { '480p': 0.2152, '720p': 0.3016 } }, 'grok-imagine-image': { image: 0.1234 } } }, 'verification');
const exactSettings = (await precise.settings());
assert.equal(exactSettings.prices['grok-imagine-video-1.5'].video['480p'], 0.2152);
assert.equal(exactSettings.prices['grok-imagine-video-1.5'].video['720p'], 0.3016);
assert.equal(exactSettings.prices['grok-imagine-video-1.5'].video['1080p'], 0.66);
assert.equal(exactSettings.prices['grok-imagine-image'].image, 0.12);
for (const [resolution,rate] of [['480p',0.2152],['720p',0.3016],['1080p',0.66]] as const) {
  assert.equal((await precise.costPolicy()).models['grok-imagine-video-1.5'].creditsPerSecond[resolution], rate);
  assert.equal(estimateGenerationCost({model:modelById('grok-imagine-video-1.5'),generation:{duration:5,resolution}}).points, Math.round(rate * 5 * 10000) / 10000);
}
await precise.db.close(); setPricingOverrides({});
console.log('Four-decimal video rate save/read/catalog/quote round trip verified; old 0.66 and image rounding preserved.');
