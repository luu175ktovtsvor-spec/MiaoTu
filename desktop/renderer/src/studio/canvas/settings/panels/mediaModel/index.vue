<template>
  <div class="providerList">
    <el-alert v-if="error" :title="error" type="error" :closable="false" showIcon />

    <div class="itemList">
      <el-card class="providerItem" shadow="never">
        <div class="providerHeader">
          <div class="providerMark" aria-hidden="true"><img class="providerLogo" :src="logoUrl" alt="" /></div>
          <div class="providerInfo">
            <div class="providerHeading">
              <el-text class="providerName" tag="strong">{{ translate('视频模型') }}</el-text>
            </div>
            <el-text class="providerId" size="small" type="info">{{ t`${videoModels.length} 个模型 · 按秒计费` }}</el-text>
          </div>
        </div>
        <div class="modelTable">
          <div v-for="model in videoModels" :key="model.id" class="modelRow">
            <div class="modelHead">
              <modelIcon :model="model.id" :size="16" />
              <span class="modelName">{{ model.label }}</span>
              <el-tag v-if="model.paused" size="small" type="danger" effect="plain">{{ translate('已暂停') }}</el-tag>
            </div>

            <div v-if="model.durationText" class="modelCaps">
              <span class="capLabel">{{ translate('时长') }}</span>
              <el-tag size="small" effect="plain">{{ model.durationText }}</el-tag>
            </div>
            <div v-if="model.sizes.length" class="modelCaps">
              <span class="capLabel">{{ translate('分辨率') }}</span>
              <el-tag v-for="size in model.sizes" :key="size" size="small" effect="plain">{{ size }}</el-tag>
            </div>
            <div v-if="model.ratios.length" class="modelCaps">
              <span class="capLabel">{{ translate('比例') }}</span>
              <el-tag v-for="ratio in model.ratios" :key="ratio" size="small" effect="plain">{{ ratio }}</el-tag>
            </div>
            <div v-if="model.referenceText" class="modelCaps">
              <span class="capLabel">{{ translate('参考素材') }}</span>
              <el-tag size="small" effect="plain">{{ model.referenceText }}</el-tag>
            </div>
            <div v-if="model.rateText" class="modelCaps">
              <span class="capLabel">{{ translate('积分') }}</span>
              <el-tag size="small" effect="plain">{{ model.rateText }}</el-tag>
            </div>
            <div v-if="model.minimumCredits" class="modelCaps">
              <span class="capLabel">{{ translate('最低积分') }}</span>
              <el-tag size="small" effect="plain">{{ t`${model.minimumCredits} 积分` }}</el-tag>
            </div>
          </div>
        </div>
      </el-card>

      <el-card class="providerItem" shadow="never">
        <div class="providerHeader">
          <div class="providerMark" aria-hidden="true"><img class="providerLogo" :src="logoUrl" alt="" /></div>
          <div class="providerInfo">
            <div class="providerHeading">
              <el-text class="providerName" tag="strong">{{ translate('图片模型') }}</el-text>
            </div>
            <el-text class="providerId" size="small" type="info">{{ t`${imageModels.length} 个模型 · 按张计费` }}</el-text>
          </div>
        </div>
        <div class="modelTable">
          <div v-for="model in imageModels" :key="model.id" class="modelRow">
            <div class="modelHead">
              <modelIcon :model="model.id" :size="16" />
              <span class="modelName">{{ model.label }}</span>
              <el-tag v-if="model.paused" size="small" type="danger" effect="plain">{{ translate('已暂停') }}</el-tag>
            </div>

            <div v-if="model.sizes.length" class="modelCaps">
              <span class="capLabel">{{ translate('尺寸') }}</span>
              <el-tag v-for="size in model.sizes" :key="size" size="small" effect="plain">{{ size }}</el-tag>
            </div>
            <div v-if="model.capabilities.length" class="modelCaps">
              <span class="capLabel">{{ translate('能力') }}</span>
              <el-tag v-for="capability in model.capabilities" :key="capability" size="small" effect="plain">{{ capability }}</el-tag>
            </div>
            <div v-if="model.creditText" class="modelCaps">
              <span class="capLabel">{{ translate('积分') }}</span>
              <el-tag size="small" effect="plain">{{ model.creditText }}</el-tag>
            </div>
          </div>
        </div>
      </el-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t, translate } from "@miaoimg/i18n/vue";
import { computed, onMounted, ref } from "vue";
import modelIcon from "@/studio/canvas/components/modelIcon.vue";

const logoUrl = "/miaoimg-logo.png";
const config = ref<{ models?: any[]; videoModels?: any[] } | null>(null);
const error = ref("");

// 服务端只下发模型目录和能力；供应商标识与上游通道都不进用户界面。
const imageModels = computed(() => (config.value?.models || []).map((model: any) => ({
  id: String(model.id),
  label: String(model.label || translate("模型")),
  note: String(model.note || ""),
  paused: model.paused === true,
  sizes: sizeLabels(model.sizes),
  capabilities: imageCapabilities(model),
  creditText: creditsPerImage(model),
})));

const videoModels = computed(() => (config.value?.videoModels || []).map((model: any) => ({
  id: String(model.id),
  label: String(model.label || translate("模型")),
  note: String(model.note || ""),
  paused: model.paused === true,
  sizes: sizeLabels(model.sizes),
  ratios: Array.isArray(model.ratios) ? model.ratios : [],
  durations: Array.isArray(model.durations) ? model.durations.map(Number).sort((a: number, b: number) => a - b) : [],
  durationText: durationText(model.durations),
  referenceText: referenceText(model),
  rateText: rateText(model.creditsPerSecond),
  minimumCredits: Number(model.minimumCredits) || 0,
})));

function sizeLabels(sizes: unknown) {
  if (!Array.isArray(sizes)) return [];
  return sizes.map((size: any) => (typeof size === "string" ? size : size?.value)).filter(Boolean).map(String);
}

function durationText(durations: unknown) {
  if (!Array.isArray(durations) || !durations.length) return "";
  const sorted = durations.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return "";
  return sorted[0] === sorted[sorted.length - 1] ? t`${sorted[0]} 秒` : t`${sorted[0]}–${sorted[sorted.length - 1]} 秒`;
}

function referenceText(model: any) {
  const limits = model?.referenceLimits;
  if (!limits || typeof limits !== "object") {
    return model?.maxReferences ? t`最多 ${model.maxReferences} 个` : "";
  }
  const parts = [[translate("图片"), limits.image], [translate("视频"), limits.video], [translate("音频"), limits.audio]]
    .filter(([, value]) => Number(value) > 0)
    .map(([label, value]) => `${label} ${value}`);
  return parts.join(" · ");
}

// 图片积分按张计：服务端给出的 creditsPerImage 已经是最终口径。
function creditsPerImage(model: any) {
  const credits = Number(model?.creditsPerImage);
  return Number.isFinite(credits) && credits > 0 ? t`${credits} 积分/张` : "";
}

function rateText(rates?: Record<string, number>) {
  if (!rates) return "";
  const entries = Object.entries(rates).filter(([key]) => key !== "default");
  if (!entries.length) return "";
  return entries.map(([resolution, value]) => t`${resolution} ${value}/秒`).join(" · ");
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
  if (Array.isArray(model?.formats) && model.formats.length) capabilities.push(t`输出 ${model.formats.join("/")}`);
  return capabilities;
}

onMounted(async () => {
  try {
    const response = await fetch("./api/imagine/config", { cache: "no-store" });
    if (!response.ok) throw new Error(translate("模型目录读取失败（{0}）", { 0: response.status }));
    config.value = await response.json();
  } catch (loadError) {
    error.value = translate("模型列表暂时无法加载，请稍后重新打开设置。");
  }
});
</script>

<style lang="scss" scoped src="../../providerList.scss"></style>
<style scoped lang="scss">
.mediaHint,
.providerDescription {
  margin: 0 0 var(--settings-gap-tight);
  font-size: 12px;
  line-height: 1.7;
  color: var(--el-text-color-secondary);
}

.modelTable {
  // 卡头（模型分类 + 计费方式）到下面模型表：标题 → 内容
  margin-top: var(--settings-gap-block);

  .modelRow {
    padding: 10px 0;
    border-top: 0;

    &:first-child { border-top: 0; }

    .modelHead {
      display: flex;
      align-items: center;
      gap: 8px;

      .modelName { font-size: 13px; font-weight: 600; color: var(--el-text-color-primary); }
    }

    .modelNote {
      display: block;
      margin: 4px 0 0 24px;
      font-size: 12px;
      line-height: 1.6;
    }

    // 模型名下面一行行能力标签（时长 / 分辨率 / 比例……）：每行都是一组
    //「字段名 + 标签」，行与行之间用 tight 档，别挤成一片。
    .modelCaps {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      margin: var(--settings-gap-tight) 0 0 24px;

      .capLabel { font-size: 12px; color: var(--el-text-color-secondary); }
    }
  }
}
</style>
