<template>
  <el-popover :persistent="false" :popper-options="{ modifiers: [{ name: 'preventOverflow', options: { padding: 12, altAxis: true } }] }" trigger="click" placement="top-start" width="min(360px, calc(100vw - 24px))" :disabled="disabled" :showArrow="false" :popperStyle="{ padding: '14px 16px' }">
    <template #reference>
      <el-button class="settingsButton" text size="small" :disabled="disabled" :aria-label="translate('图片生成设置')">
        <span class="ratioShape" :style="ratioStyle(effectiveRatio)" aria-hidden="true" />
        <span>{{ settingsSummary }}</span>
        <icon-chevron-up :size="14" aria-hidden="true" />
      </el-button>
    </template>
    <div class="generationSettings nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.stop @wheel.stop>
      <template v-if="qualityChoices.length">
        <div class="sectionLabel">{{ translate('画质') }}</div>
        <settingOptions v-model="qualitySelection" :options="qualityChoices" :columns="3" :disabled="disabled" :label="translate('画质')" />
      </template>
      <template v-if="tierChoices.length">
        <div class="sectionLabel">{{ translate('清晰度') }}</div>
        <settingOptions :model-value="currentTier" :options="tierChoices" :columns="Math.min(4, Math.max(3, tierChoices.length))" :disabled="disabled" :label="translate('清晰度')" @update:model-value="chooseTier" />
        <p v-if="limitedTiers" class="customHint">{{ translate('当前比例可选：{0}', { 0: availableTiers.join(' / ') }) }}</p>
      </template>
      <template v-if="transparentAllowed">
        <div class="sectionLabel">{{ translate('背景') }}</div>
        <settingOptions v-model="background" :options="backgroundChoices" :columns="3" :disabled="disabled" :label="translate('背景')" />
      </template>
      <template v-if="ratioChoices.length">
        <div class="sectionLabel">{{ translate('比例') }}</div>
        <settingOptions v-model="ratio" :options="ratioChoices" :columns="5" ratio :disabled="disabled" :label="translate('图片比例')" />
      </template>
      <template v-if="countChoices.length > 1 && !layerDecomposition">
        <div class="sectionLabel">{{ translate('生成数量') }}</div>
        <settingOptions v-model="count" :options="countChoices" :columns="Math.min(4, countChoices.length)" :disabled="disabled" :label="translate('生成数量')" />
      </template>
      <label v-if="supportsLayers" class="layerToggle">
        <el-switch v-model="layerDecomposition" :disabled="disabled || !layerReady" :aria-label="translate('图层分离')" />
        <span>
          {{ translate('图层分离') }}
          <small>{{ layerReady ? translate("1 张底图 + 最多 16 个透明图层") : translate("需要恰好 1 张参考图") }}</small>
        </span>
      </label>
      <el-button v-if="hasAdvanced" class="advancedToggle" text :aria-expanded="showAdvanced" @click="showAdvanced = !showAdvanced">
        {{ translate(showAdvanced ? '收起高级设置' : '高级设置') }}
        <icon-chevron-down :size="14" :class="{ flipped: showAdvanced }" aria-hidden="true" />
      </el-button>
      <div v-if="showAdvanced" class="advancedSettings">
        <template v-if="customRule">
          <div class="sectionLabel">{{ translate('自定义宽高') }}</div>
          <div class="customSize">
            <el-input-number v-model="customWidth" :min="1" :step="customRule.multipleOf || 1" :disabled="disabled" controls-position="right" :aria-label="translate('宽度')" />
            <span>×</span>
            <el-input-number v-model="customHeight" :min="1" :step="customRule.multipleOf || 1" :disabled="disabled" controls-position="right" :aria-label="translate('高度')" />
            <el-button size="small" :disabled="disabled || !customFits" @click="applyCustomSize">{{ translate('使用') }}</el-button>
          </div>
          <p v-if="customWidth && customHeight && !customFits" class="customHint">{{ translate('当前宽高不在这个模型接受的范围内') }}</p>
        </template>
        <template v-if="formatOptions.length > 1">
          <div class="sectionLabel">{{ translate('输出格式') }}</div>
          <settingOptions v-model="format" :options="formatOptions.map(item => ({ value: item, label: item.toUpperCase() }))" :columns="3" :disabled="disabled" :label="translate('输出格式')" />
        </template>
        <template v-if="fidelityOptions.length">
          <div class="sectionLabel">{{ translate('输入保真度') }}</div>
          <settingOptions v-model="inputFidelity" :options="[{ value: '', label: translate('自动') }, ...fidelityOptions.map(item => ({ value: item, label: fidelityLabel(item) }))]" :columns="3" :disabled="disabled" :label="translate('输入保真度')" />
        </template>
        <template v-if="optimizeModes.length">
          <div class="sectionLabel">{{ translate('提示词优化') }}</div>
          <settingOptions v-model="optimizePrompt" :options="[{ value: '', label: translate('标准') }, ...(optimizeModes.includes('fast') ? [{ value: 'fast', label: translate('极速') }] : [])]" :columns="3" :disabled="disabled" :label="translate('提示词优化')" />
        </template>
        <template v-for="control in controls" :key="control.key">
          <div class="controlRow">
            <span class="sectionLabel">{{ translate(control.label) }}</span>
            <el-switch v-if="control.type === 'boolean'" :model-value="Boolean(parameters[control.key])" :disabled="disabled" :aria-label="translate(control.label)" @update:model-value="parameters = { ...parameters, [control.key]: $event }" />
          </div>
          <el-select v-if="control.type === 'select'" :model-value="String(parameters[control.key] || '')" :teleported="false" :disabled="disabled" :aria-label="translate(control.label)" @update:model-value="parameters = { ...parameters, [control.key]: $event }">
            <el-option v-for="option in control.options || []" :key="option" :value="option" :label="option" />
          </el-select>
        </template>
      </div>
    </div>
  </el-popover>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElButton, ElInputNumber, ElOption, ElPopover, ElSelect, ElSwitch } from "element-plus";
import { IconChevronDown, IconChevronUp } from "@tabler/icons-vue";
import { translate } from "@miaoimg/i18n/vue";
import { fitsCustomSize } from "../scaffold/nodeAi";
import { visibleControls } from "../scaffold/mediaParameters";
import { sizeRatio, sizeTier } from "../../../../../../server/media-size-label";
import settingOptions from "./settingOptions.vue";

const props = defineProps<{ sizes: string[]; ratios: string[]; disabled?: boolean; model?: { providerId?: string; modelId?: string; formats?: string[]; quality?: string[]; inputFidelity?: string[]; maxCount?: number; supportsTransparent?: boolean; supportsLayerDecomposition?: boolean; optimizePromptModes?: string[]; customSize?: boolean; sizes?: { value: string; ratio?: string; label?: string }[]; sizeRule?: { minPixels: number; maxPixels: number; minRatio: number; maxRatio: number; multipleOf?: number; maxEdge?: number } | null }; referenceCount?: number }>();
const size = defineModel<string>("size", { required: true });
const ratio = defineModel<string>("ratio", { required: true });
const format = defineModel<string>("format", { default: "" });
const background = defineModel<string>("background", { default: "opaque" });
const quality = defineModel<string>("quality", { default: "" });
const inputFidelity = defineModel<string>("inputFidelity", { default: "" });
const count = defineModel<number>("count", { default: 1 });
const layerDecomposition = defineModel<boolean>("layerDecomposition", { default: false });
const optimizePrompt = defineModel<string>("optimizePrompt", { default: "" });
const parameters = defineModel<Record<string, unknown>>("parameters", { default: () => ({}) });
const controls = computed(() => visibleControls(props.model, "text"));

const formatOptions = computed(() => props.model?.formats || []);
const qualityOptions = computed(() => props.model?.quality || []);
const fidelityOptions = computed(() => props.model?.inputFidelity || []);
const maxCount = computed(() => Math.max(1, Number(props.model?.maxCount) || 1));
const transparentAllowed = computed(() => Boolean(props.model?.supportsTransparent));
const supportsLayers = computed(() => Boolean(props.model?.supportsLayerDecomposition));
const optimizeModes = computed(() => props.model?.optimizePromptModes || []);
const layerReady = computed(() => (props.referenceCount || 0) === 1);
const customRule = computed(() => props.model?.customSize ? props.model.sizeRule || null : null);
const parsedSize = computed(() => /^(\d+)x(\d+)$/.exec(size.value || ""));
const sizeMeta = computed(() => props.model?.sizes || []);
// Grok uses resolution and aspect ratio as independent upstream fields. Other
// image providers encode the aspect ratio in `size`; keeping the two controls
// independent would let the composer show combinations the upstream never gets.
const independentRatio = computed(() => sizeMeta.value.length > 0 && sizeMeta.value.every(item => !item.ratio));
const effectiveRatio = computed(() => {
  if (independentRatio.value) return ratio.value || "auto";
  const mapped = sizeMeta.value.find(item => item.value === size.value)?.ratio;
  if (mapped) return mapped;
  return parsedSize.value ? sizeRatio(size.value) : ratio.value || "auto";
});
// 和 LibTV 一样只给用户看“比例 · 画质 · 清晰度 · 张数”，像素宽高只在高级设置的自定义宽高里出现。
const QUALITY_LABELS: Record<string, string> = { low: "低画质", medium: "标准画质", high: "高画质", xhigh: "超高画质", max: "极致画质" };
const FIDELITY_LABELS: Record<string, string> = { low: "低", high: "高" };
function fidelityLabel(value: string) { return translate(FIDELITY_LABELS[value] || value); }
// Keep the server's legacy omitted-quality default visible. Selecting Auto
// now writes an explicit auto, while merely opening an old canvas keeps medium.
const qualitySelection = computed({
  get: () => quality.value || (props.model?.modelId?.startsWith('gpt-image-2') ? 'medium' : qualityOptions.value.includes('auto') ? 'auto' : ''),
  set: (value: string) => { quality.value = value; },
});
const qualityChoices = computed(() => qualityOptions.value.length
  ? [{ value: qualityOptions.value.includes("auto") ? "auto" : "", label: translate("自动") }, ...qualityOptions.value.filter(item => item !== "auto").map(item => ({ value: item, label: translate(QUALITY_LABELS[item] || item) }))]
  : []);
const backgroundChoices = computed(() => [
  { value: "opaque", label: translate("保留背景") },
  { value: "transparent", label: translate("透明背景") },
]);
const sizeEntries = computed(() => props.sizes.map(value => {
  const metadata = sizeMeta.value.find(item => item.value === value);
  const ratio = metadata?.ratio || (value === "auto" ? "auto" : sizeRatio(value));
  return { value, ratio, tier: sizeTier(value, metadata?.label) };
}));
const availableTiers = computed(() => [...new Set(sizeEntries.value
  .filter(item => independentRatio.value || item.ratio === effectiveRatio.value)
  .map(item => item.tier).filter(Boolean))]);
const limitedTiers = computed(() => availableTiers.value.length > 0 && availableTiers.value.length < tierChoices.value.length);
const tierValue = (tier: string) => Number.parseFloat(tier.replace(/^</, '')) * (tier.startsWith('<') ? 0.5 : /p$/i.test(tier) ? 0.001 : 1);
const tierChoices = computed(() => [...new Set(sizeEntries.value.map(item => item.tier).filter(Boolean))]
  .sort((left, right) => tierValue(left) - tierValue(right))
  .map(tier => ({ value: tier, label: tier,
    disabled: !availableTiers.value.includes(tier),
    title: availableTiers.value.includes(tier) ? undefined : translate('该比例暂无此清晰度预设'),
  })));
const currentTier = computed(() => sizeEntries.value.find(item => item.value === size.value)?.tier || sizeTier(size.value));
function chooseTier(tier: string) {
  const entries = sizeEntries.value.filter(item => item.tier === tier);
  // 不因切清晰度悄悄改掉用户选定的比例；不兼容组合在菜单里禁用。
  const target = independentRatio.value ? entries[0] : entries.find(item => item.ratio === effectiveRatio.value);
  if (target && target.value !== size.value) size.value = target.value;
}
const ratioChoices = computed(() => props.ratios.map(item => ({ value: item, label: item === "auto" ? translate("自动") : item })));
// 张数只列模型目录允许的范围（含“参考图 + 生成张数”合计上限）；超出时收回到上限，不展示上游不接受的值。
const countChoices = computed(() => Array.from({ length: maxCount.value }, (_, index) => index + 1)
  .map(value => ({ value, label: translate("{0}张", { 0: value }) })));
watch(maxCount, max => { if (count.value > max) count.value = max; }, { immediate: true });
const showAdvanced = ref(false);
const hasAdvanced = computed(() => Boolean(customRule.value) || formatOptions.value.length > 1 || fidelityOptions.value.length > 0 || optimizeModes.value.length > 0 || controls.value.length > 0);
const settingsSummary = computed(() => {
  const ratioText = effectiveRatio.value === "auto" || !effectiveRatio.value ? translate("自动") : effectiveRatio.value;
  const selectedQuality = qualitySelection.value;
  const qualityText = selectedQuality && selectedQuality !== "auto" ? translate(QUALITY_LABELS[selectedQuality] || selectedQuality) : "";
  const tier = currentTier.value;
  return [ratioText, qualityText, tier, translate("{0}张", { 0: count.value })].filter(Boolean).join(" · ");
});
const customWidth = ref<number | undefined>(parsedSize.value ? Number(parsedSize.value[1]) : undefined);
const customHeight = ref<number | undefined>(parsedSize.value ? Number(parsedSize.value[2]) : undefined);
watch(parsedSize, (value) => {
  if (!value) return;
  customWidth.value = Number(value[1]);
  customHeight.value = Number(value[2]);
});
const customFits = computed(() => fitsCustomSize(customRule.value, customWidth.value && customHeight.value ? `${customWidth.value}x${customHeight.value}` : undefined));
function applyCustomSize() {
  if (!customFits.value || !customWidth.value || !customHeight.value) return;
  size.value = `${customWidth.value}x${customHeight.value}`;
}

// 比例由所选尺寸推出时，不能再反过来按比例改尺寸，否则同比例的大尺寸会被换成列表里第一个。
let ratioFromSize = false;
function setRatioFromSize(next: string) {
  if (ratio.value === next) return;
  ratioFromSize = true;
  ratio.value = next;
}
function reconcileSizeAndRatio() {
  if (independentRatio.value) return;
  const mapped = sizeMeta.value.find(item => item.value === size.value)?.ratio;
  if (mapped) {
    setRatioFromSize(mapped);
    return;
  }
  const match = parsedSize.value;
  if (!match) return;
  const width = Number(match[1]), height = Number(match[2]);
  const gcd = (left: number, right: number): number => right ? gcd(right, left % right) : left;
  const divisor = gcd(width, height);
  const exact = `${width / divisor}:${height / divisor}`;
  setRatioFromSize(props.ratios.includes(exact) ? exact : "");
}
watch(size, reconcileSizeAndRatio, { immediate: true });
watch(() => sizeMeta.value.map(item => `${item.value}:${item.ratio || ""}`).join("|"), reconcileSizeAndRatio, { immediate: true });
watch(ratio, value => {
  if (ratioFromSize) { ratioFromSize = false; return; }
  if (independentRatio.value || !value) return;
  // 换比例时尽量保持当前清晰度档位。
  const target = sizeEntries.value.find(item => item.ratio === value && item.tier === currentTier.value)
    ?? sizeEntries.value.find(item => item.ratio === value);
  if (target && size.value !== target.value) size.value = target.value;
});

function ratioStyle(value: string) {
  const [width = 1, height = 1] = value.split(":").map(Number);
  // auto 这类没有比例的值画成虚线方框，不然宽高是 NaN，只剩一个小点。
  if (!(width > 0 && height > 0)) return { width: "16px", height: "12px", borderStyle: "dashed" };
  return { width: `${16 * Math.min(width / height, 1)}px`, height: `${16 * Math.min(height / width, 1)}px` };
}
</script>

<style scoped lang="scss">
.ratioShape {
  display: inline-block;
  flex-shrink: 0;
  border: 1px solid currentColor;
  border-radius: 2px;
  box-sizing: border-box;
}

.settingsButton {
  flex-shrink: 0;
  border-radius: 8px;
  :deep(> span) { gap: 6px; }
}

.generationSettings {
  display: flex;
  flex-direction: column;
  text-align: left;
  max-height: min(70vh, 600px);
  overflow-y: auto;

  .sectionLabel {
    margin: 14px 0 8px;
    color: var(--el-text-color-regular);
    font-size: 13px;
    font-weight: 500;
    &:first-child { margin-top: 0; }
  }

  .layerToggle {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin-top: 14px;
    color: var(--el-text-color-primary);
    font-size: 13px;
    cursor: pointer;
    > span { display: grid; gap: 2px; }
    small { color: var(--el-text-color-secondary); font-size: 11px; font-weight: 400; }
  }

  .advancedToggle {
    align-self: flex-start;
    margin-top: 12px;
    padding-inline: 0;
    color: var(--el-text-color-secondary);
    :deep(> span) { gap: 4px; }
    .flipped { transform: rotate(180deg); }
  }

  .advancedSettings {
    display: flex;
    flex-direction: column;
    .sectionLabel:first-child { margin-top: 6px; }
  }

  .controlRow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    .sectionLabel { margin: 14px 0 8px; }
  }

  .customSize {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    align-items: center;
    gap: 6px;
    min-width: 0;

    :deep(.el-input-number) { width: 100%; min-width: 0; }
    .el-button { grid-column: 1 / -1; justify-self: end; margin: 0; }
  }

  .customHint {
    margin: 6px 0 0;
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }
}
</style>
