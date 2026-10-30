<template>
  <el-dialog append-to-body :model-value="controller.state.visible" :style="{ maxWidth: 'calc(100vw - 24px)' }" width="760px" top="6vh" :close-on-click-modal="false" :close-on-press-escape="!controller.state.preparing" @update:model-value="value => { if (!value) controller.close(); }">
    <template #header="{ titleId, titleClass }">
      <div class="intentHeading">
        <h2 :id="titleId" :class="titleClass">{{ translate(controller.definition.value.label) }}</h2>
        <el-tooltip :content="translate('hint' in controller.definition.value ? controller.definition.value.hint : controller.defaultHint)" placement="bottom" :show-after="100">
          <el-button text :icon="IconInfoCircle" :aria-label="translate('编辑说明')" />
        </el-tooltip>
      </div>
    </template>
    <div class="videoIntentBody" v-loading="controller.state.loading">
      <video v-if="src" :src="src" controls preload="metadata" class="intentPreview" />
      <div class="sourceInfo" v-if="controller.state.source">{{ translate('原视频') }} · {{ controller.state.source.width }} × {{ controller.state.source.height }} · {{ controller.state.source.duration?.toFixed(3) }} {{ translate('秒') }}</div>
      <el-form label-position="top" :disabled="controller.state.preparing">
        <el-form-item :label="translate('具体编辑要求')" required>
          <el-input v-model="controller.state.prompt" type="textarea" :rows="3" :maxlength="10000" :placeholder="translate(controller.definition.value.placeholder)" />
        </el-form-item>
        <div v-if="controller.state.intent === 'video:retake-segment'" class="rangeFields">
          <el-form-item :label="translate('开始时间（秒）')"><el-input-number v-model="controller.state.start" :min="0" :max="controller.state.source?.duration || 0" :precision="3" :step="0.1" /></el-form-item>
          <el-form-item :label="translate('结束时间（秒）')"><el-input-number v-model="controller.state.end" :min="0" :max="controller.state.source?.duration || 0" :precision="3" :step="0.1" /></el-form-item>
        </div>
        <el-form-item :label="translate('附加参考素材（可选）')">
          <el-select v-model="controller.state.referenceKeys" multiple collapse-tags :max-collapse-tags="3" filterable :loading="controller.state.referenceLoading" :placeholder="translate('选择画布中的参考图片或音频')" class="fullWidth">
            <el-option-group :label="translate('参考图片')"><el-option v-for="item in controller.references.value.filter(item => item.kind === 'image')" :key="item.key" :label="item.label" :value="item.key" /></el-option-group>
            <el-option-group :label="translate('参考音频')"><el-option v-for="item in controller.references.value.filter(item => item.kind === 'audio')" :key="item.key" :label="item.label" :value="item.key" /></el-option-group>
          </el-select>
        </el-form-item>
        <el-form-item required>
          <template #label>
            <span>{{ translate('编辑模型') }}</span>
            <el-tooltip v-if="controller.modelHelp.value.length" placement="top"><template #content><div class="modelCompatibilityHelp"><div v-for="(line,index) in controller.modelHelp.value" :key="index">{{ line }}</div></div></template><el-button text :icon="IconInfoCircle" :aria-label="translate('模型编辑限制')" /></el-tooltip>
          </template>
          <el-select v-model="controller.state.model" :loading="controller.state.loading || controller.state.referenceLoading" :placeholder="translate('选择支持当前素材的编辑模型')" :no-data-text="translate('没有兼容当前素材的视频编辑模型')" class="fullWidth" @change="controller.chooseModel">
            <el-option v-if="controller.state.model && !controller.choice.value && controller.choices.value.length" :label="translate('所选模型不支持当前素材，请重新选择模型')" :value="controller.state.model" disabled />
            <el-option v-for="model in controller.choices.value" :key="controller.modelKey(model)" :label="nodeModelOptionLabel(model)" :value="controller.modelKey(model)" />
          </el-select>
        </el-form-item>
        <el-alert v-if="controller.modelError.value || controller.promptError.value" :title="controller.modelError.value || controller.promptError.value" type="warning" :closable="false" show-icon />
        <div v-if="controller.choice.value" class="specFields">
          <el-form-item :label="translate('时长')">
            <span v-if="controller.inherited.value.includes('duration')">{{ translate('跟随原视频') }}</span>
            <el-select v-else v-model="controller.state.duration"><el-option v-for="value in controller.durations.value" :key="value" :label="value === -1 ? translate('自动') : translate('{0} 秒', { 0: value })" :value="value" /></el-select>
          </el-form-item>
          <el-form-item :label="translate('清晰度')">
            <span v-if="controller.inherited.value.includes('resolution')">{{ translate('跟随原视频') }}</span>
            <el-select v-else v-model="controller.state.resolution"><el-option v-for="value in controller.resolutions.value" :key="value" :label="value" :value="value" /></el-select>
          </el-form-item>
        </div>
      </el-form>
    </div>
    <template #footer>
      <el-button :disabled="controller.state.preparing" @click="controller.close">{{ translate('取消') }}</el-button>
      <el-button type="primary" :loading="controller.state.preparing" :disabled="!controller.canPrepare.value" @click="controller.prepare">{{ translate('准备编辑节点') }}</el-button>
    </template>
  </el-dialog>
</template>
<script setup lang="ts">
import { ElAlert, ElButton, ElDialog, ElForm, ElFormItem, ElInput, ElInputNumber, ElLoading, ElOption, ElOptionGroup, ElSelect, ElTooltip } from "element-plus";
import { IconInfoCircle } from "@tabler/icons-vue";
import { translate } from "@miaoimg/i18n/vue";
import { nodeModelOptionLabel } from "../../scaffold/localModelLabel";
import type { VideoIntentController } from "./useVideoIntentActions";
defineProps<{ controller: VideoIntentController; src: string }>();
const vLoading = ElLoading.directive;
</script>
<style scoped>
.intentHeading { display:flex; align-items:center; gap:5px; }
.modelCompatibilityHelp { max-width:420px; max-height:45vh; overflow:auto; line-height:1.65; }
.intentHeading h2 { margin:0; font-size:18px; font-weight:600; }
.videoIntentBody { max-height:68vh; overflow:auto; }
.intentPreview { display:block; width:100%; max-height:220px; object-fit:contain; background:#111; border-radius:8px; }
.sourceInfo { color:var(--el-text-color-secondary); margin:8px 0 16px; font-size:12px; }
.fullWidth { width:100%; }
.rangeFields,.specFields { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
.el-form-item :deep(.el-form-item__label) { display:flex; align-items:center; }
</style>
