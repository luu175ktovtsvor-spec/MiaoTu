<template>
  <div class="mediaModels">
    <feedbackNotice v-if="error" :message="error"  />
    <p v-else-if="loading && !models.length" class="mediaStatus" role="status">{{ translate('正在读取模型目录…') }}</p>
    <p v-else-if="!loading && !groups.length" class="mediaStatus" role="status">{{ translate('当前没有可用的图片或视频模型。') }}</p>

    <section v-for="group in groups" :key="group.key" class="mediaGroup">
      <header class="mediaGroupHead">
        <h3>{{ group.title }}</h3>
        <span class="mediaGroupMeta">{{ group.meta }}</span>
      </header>
      <div class="mediaGrid">
        <article v-for="model in group.models" :key="model.id" class="mediaCard">
          <header class="mediaCardHead">
            <span class="mediaLogo"><modelIcon :model="model.id" :size="22" /></span>
            <strong class="mediaName">{{ model.label }}</strong>
          </header>
          <dl class="mediaSpecs">
            <template v-for="spec in model.specs" :key="spec.label">
              <dt>{{ spec.label }}</dt>
              <dd :class="{ isCredit: spec.credit }"><span v-for="item in spec.items" :key="item" class="specItem">{{ item }}</span><small v-if="spec.hint">{{ spec.hint }}</small></dd>
            </template>
          </dl>
        </article>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { mediaSizeLabel, sizeTier } from "../../../../../../../../server/media-size-label";
import feedbackNotice from '../../../components/feedbackNotice.vue';
import { t, translate } from "@miaoimg/i18n/vue";
import { computed, onMounted, onUnmounted, ref } from "vue";
import modelIcon from "@/studio/canvas/components/modelIcon.vue";
import { loadMediaModels, type NodeMediaModel } from "@miaoimg/nodes-scaffold/nodeAi";
import { captureWorkspaceScope, assertWorkspaceScope, subscribeWorkspaceScope } from "@/lib/workspaceRemote";

const models = ref<NodeMediaModel[]>([]);
const error = ref("");
const loading = ref(true);
let disposed = false;
let refreshing = false;
let scopeVersion = 0;

// 与节点共用实时目录，服务端已过滤管理员开关、通道配置和账号权限。
// 本机平台的账号权益在「豆包与 Dola」说明，不混入本站积分目录。
const imageModels = computed(() => models.value.filter(model => model.type === 'image').map((model) => ({
  id: model.modelId,
  label: String(model.label || translate("模型")),
  sizes: sizeLabels(model.sizes),
  capabilities: imageCapabilities(model),
  creditItems: imageRates(model),
})));

const videoModels = computed(() => models.value.filter(model => model.type === 'video').map((model) => ({
  id: model.modelId,
  label: String(model.label || translate("模型")),
  sizes: sizeLabels(model.sizes),
  ratios: Array.isArray(model.ratios) ? model.ratios : [],
  durationItems: durationItems(model.durations),
  referenceItems: referenceItems(model),
  rateItems: rateItems(model),
  minimumCredits: Number(model.minimumCredits) || 0,
  maxDuration: Math.max(0, ...(Array.isArray(model.durations) ? model.durations.map(Number).filter(Number.isFinite) : [])),
  maxDurationByResolution: Object.fromEntries((model.durationResolutionMap || []).flatMap(rule =>
    (rule.resolution || []).map(resolution => [resolution, Math.max(0, ...(rule.duration || []).filter(value => value > 0))]))),
  maxDurationByMode: model.maxDurationByMode || {},
  inputPricing: model.inputPricing,
  billingMode: model.billingMode,
  pricingNotice: model.pricingNotice,
})));

// 每一项单独成块，换行只发生在项与项之间。
type Spec = { label: string; items: string[]; hint?: string; credit?: boolean };
const ratioLabel = (ratio: string) => (ratio === "adaptive" ? translate("自适应") : ratio === "auto" ? translate("自动") : ratio);
// 尺寸很多的模型只列前几个，其余写成数量，避免一张卡片被尺寸撑满。
function listItems(values: string[], limit = 6) {
  return values.length > limit ? [...values.slice(0, limit), t`等 ${values.length} 种`] : values;
}

function videoSpecs(model: any): Spec[] {
  const specs: Spec[] = [];
  const hints: string[] = [];
  for (const [resolution, max] of Object.entries(model.maxDurationByResolution || {})) {
    if (Number(max) < model.maxDuration) hints.push(t`${resolution} 最长 ${max} 秒`);
  }
  if (Number(model.maxDurationByMode?.image) < model.maxDuration) hints.push(t`参考图模式最长 ${model.maxDurationByMode.image} 秒`);
  if (model.durationItems.length) specs.push({ label: translate("时长"), items: model.durationItems, hint: hints.join("，") });
  if (model.sizes.length) specs.push({ label: translate("清晰度"), items: model.sizes.map((size: string) => sizeTier(size) || size) });
  if (model.ratios.length) specs.push({ label: translate("比例"), items: model.ratios.map(ratioLabel) });
  if (model.referenceItems.length) specs.push({ label: translate("参考素材"), items: model.referenceItems });
  const priceHints: string[] = model.pricingNotice ? [translate(model.pricingNotice)] : [];
  if (model.inputPricing?.billReferenceVideoSeconds) priceHints.push(translate('参考视频按时长另计'));
  if (model.billingMode === 'upstream_usage') priceHints.push(translate('按实际用量结算'));
  if (model.rateItems.length) specs.push({ label: translate("积分"), items: model.rateItems, credit: true, hint: priceHints.join('，') });
  if (model.minimumCredits >= 0.01) specs.push({ label: translate("单次最低"), items: [t`${points(model.minimumCredits)} 积分`], credit: true });
  return specs;
}

function imageSpecs(model: any): Spec[] {
  const specs: Spec[] = [];
  // 与画布设置一致，只列“比例 · 清晰度”，不展示像素宽高。
  if (model.sizes.length) specs.push({ label: translate("尺寸"), items: listItems([...new Set<string>(model.sizes.map((size: string) => mediaSizeLabel(size, "", translate("自动"))))]) });
  if (model.capabilities.length) specs.push({ label: translate("能力"), items: model.capabilities });
  if (model.creditItems.length) specs.push({ label: translate("积分"), items: model.creditItems, credit: true });
  return specs;
}

const groups = computed(() => [
  { key: "video", title: translate("视频模型"), meta: t`${videoModels.value.length} 个模型 · 按秒计费`, models: videoModels.value.map(model => ({ ...model, specs: videoSpecs(model) })) },
  { key: "image", title: translate("图片模型"), meta: t`${imageModels.value.length} 个模型 · 按张计费`, models: imageModels.value.map(model => ({ ...model, specs: imageSpecs(model) })) },
].filter(group => group.models.length));

function sizeLabels(sizes: unknown) {
  if (!Array.isArray(sizes)) return [];
  return sizes.map((size: any) => (typeof size === "string" ? size : size?.value)).filter(Boolean).map(String);
}

// 时长里的 -1 是「由模型自动选择时长」（方舟 Seedance 的官方取值），单独写成「自动」，不当成秒数。
function durationItems(durations: unknown): string[] {
  if (!Array.isArray(durations) || !durations.length) return [];
  const values = durations.map(Number).filter(Number.isFinite);
  const automatic = values.includes(-1);
  const sorted = values.filter(value => value > 0).sort((a, b) => a - b);
  if (!sorted.length) return automatic ? [translate("自动")] : [];
  const range = sorted[0] === sorted[sorted.length - 1] ? t`${sorted[0]} 秒` : t`${sorted[0]}–${sorted[sorted.length - 1]} 秒`;
  return automatic ? [range, translate("可选自动")] : [range];
}

function referenceItems(model: any): string[] {
  const limits = model?.referenceLimits;
  if (!limits || typeof limits !== "object") {
    return model?.maxReferences ? [t`最多 ${model.maxReferences} 个`] : [];
  }
  const parts = [[translate("图片"), limits.image], [translate("视频"), limits.video], [translate("音频"), limits.audio]]
    .filter(([, value]) => Number(value) > 0)
    .map(([label, value]) => `${label} ${value}`);
  return parts;
}

// 图片积分按张计：服务端给出的 creditsPerImage 已经是最终口径。
function imageRates(model: NodeMediaModel): string[] {
  const sizes = sizeLabels(model.sizes);
  const tiers = Object.entries(model.creditsPerImageBySize || {}).filter(([size, price]) => sizes.includes(size) && Number.isFinite(price) && price >= 0);
  const prices = [...new Set(tiers.map(([, price]) => price))];
  if (prices.length > 1) return prices.map(price => {
    const labels = tiers.filter(([, value]) => value === price).map(([size]) => mediaSizeLabel(size, "", translate("自动")));
    return `${listItems(labels, 3).join('、')} ${points(price)} ${translate('积分/张')}`;
  });
  if (tiers.length && tiers.length === sizes.length) return [t`${points(prices[0])} 积分/张`];
  const credits = Number(model?.creditsPerImage);
  return model.creditsPerImage != null && Number.isFinite(credits) && credits >= 0 ? [t`${points(credits)} 积分/张`] : [];
}

// 单价由服务端相乘得出，可能带浮点尾数（如 1.7440000000000002），显示时最多保留四位小数。
const points = (value: unknown) => String(Number(Number(value).toFixed(4)));
function rateItems(model: NodeMediaModel): string[] {
  const rates = model.creditsPerSecond;
  if (!rates) return [];
  return sizeLabels(model.sizes).flatMap(resolution => {
    const value = rates[resolution] ?? rates.default;
    return Number.isFinite(value) && value >= 0 ? [t`${resolution} ${points(value)}/秒`] : [];
  });
}

function imageCapabilities(model: any) {
  const capabilities: string[] = [];
  if (Number(model?.maxReferences) > 0) capabilities.push(t`参考图 ${model.maxReferences} 张`);
  if (Number(model?.maxCount) > 1) capabilities.push(t`单次出图 ${model.maxCount} 张`);
  // supportsEdit 只是「能拿图生图」；画布上的局部重绘入口按区域编辑通道走，这里跟着同一份能力标。
  if (model?.regionEdit) capabilities.push(translate("局部重绘"));
  if (model?.supportsTransparent) capabilities.push(translate("透明背景"));
  if (model?.supportsLayerDecomposition) capabilities.push(translate("图层拆分"));
  if (Array.isArray(model?.quality) && model.quality.length) capabilities.push(translate("可选画质"));
  // 「auto」表示格式由模型决定，不算一项可选能力。
  const formats = Array.isArray(model?.formats) ? model.formats.filter((format: string) => format !== "auto") : [];
  if (formats.length) capabilities.push(t`输出 ${formats.join("/")}`);
  return capabilities;
}

async function refreshModels() {
  if (disposed || refreshing || document.visibilityState === 'hidden') return;
  refreshing = true;
  const version = scopeVersion;
  const scope = captureWorkspaceScope();
  try {
    const catalog = await loadMediaModels(true);
    assertWorkspaceScope(scope);
    if (disposed || version !== scopeVersion) return;
    const next = catalog.filter(model => model.providerId === 'miaoimg');
    const changed = JSON.stringify(models.value) !== JSON.stringify(next);
    models.value = next;
    error.value = '';
    if (changed) window.dispatchEvent(new Event('miao-media-models'));
  } catch (loadError) {
    if (disposed || version !== scopeVersion) return;
    models.value = [];
    error.value = translate("模型列表暂时无法加载，请稍后重新打开设置。");
  } finally {
    refreshing = false;
    if (!disposed) loading.value = false;
    if (!disposed && version !== scopeVersion) void refreshModels();
  }
}
const unsubscribeScope = subscribeWorkspaceScope(() => {
  scopeVersion++;
  models.value = [];
  error.value = '';
  loading.value = true;
  void refreshModels();
});
let refreshTimer: ReturnType<typeof setInterval>;
onMounted(() => {
  void refreshModels();
  window.addEventListener('focus', refreshModels);
  document.addEventListener('visibilitychange', refreshModels);
  refreshTimer = setInterval(refreshModels, 30_000);
});
onUnmounted(() => {
  disposed = true;
  unsubscribeScope();
  clearInterval(refreshTimer);
  window.removeEventListener('focus', refreshModels);
  document.removeEventListener('visibilitychange', refreshModels);
});
</script>

<style scoped lang="scss">
.mediaModels { display: grid; gap: 28px; }
.mediaStatus { margin: 0; color: var(--el-text-color-secondary); font-size: 13px; }
.mediaGroupHead {
  display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 14px;
  h3 { margin: 0; color: var(--el-text-color-primary); font-size: 16px; font-weight: 600; letter-spacing: .01em; }
}
.mediaGroupMeta { color: var(--el-text-color-secondary); font-size: 12px; letter-spacing: .04em; }
.mediaGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); gap: 14px; }
.mediaCard {
  position: relative; display: grid; align-content: start; gap: 16px; min-width: 0; overflow: hidden;
  padding: 20px 22px; border: 1px solid var(--el-border-color); border-radius: 18px;
  background: linear-gradient(180deg, rgb(255 255 255 / .03), transparent 60%);
  transition: border-color .3s, box-shadow .3s;
  &::after { position: absolute; top: 0; right: 28px; left: 28px; height: 1px; background: linear-gradient(90deg, transparent, #4c9dff, transparent); content: ""; opacity: 0; transition: opacity .4s; }
  &:hover { border-color: var(--el-border-color-hover, var(--el-border-color)); box-shadow: 0 0 0 1px rgb(76 157 255 / .2), 0 20px 50px -20px rgb(76 157 255 / .35); }
  &:hover::after { opacity: .9; }
}
.mediaCardHead { display: flex; align-items: center; gap: 12px; min-width: 0; }
.mediaLogo {
  display: grid; flex: none; width: 40px; height: 40px; place-items: center;
  border: 1px solid var(--el-border-color); border-radius: 12px; background: var(--el-fill-color-light);
}
.mediaName { min-width: 0; overflow: hidden; color: var(--el-text-color-primary); font-size: 15px; font-weight: 600; letter-spacing: .01em; text-overflow: ellipsis; white-space: nowrap; }
.mediaSpecs {
  display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 9px 16px; margin: 0;
  dt { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.7; }
  // 每项之间只留间距、不加分隔点：换行时行首行尾不会出现孤立的符号。
  dd { display: flex; flex-wrap: wrap; gap: 0 14px; margin: 0; color: var(--el-text-color-regular); font-size: 13px; font-variant-numeric: tabular-nums; line-height: 1.7; }
  dd small { flex-basis: 100%; color: var(--el-text-color-secondary); font-size: 12px; }
  .specItem { white-space: nowrap; }
  dd.isCredit { color: var(--el-text-color-primary); }
}
</style>
