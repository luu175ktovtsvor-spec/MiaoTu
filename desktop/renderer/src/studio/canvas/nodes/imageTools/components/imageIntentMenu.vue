<template>
  <el-dropdown v-if="controller.tools.length" trigger="click" :disabled="disabled || controller.busy" @command="id => controller.open(String(id))">
    <el-button text :icon="IconAdjustments" :disabled="disabled || controller.busy" :title="translate('图片编辑')" :aria-label="translate('图片编辑')" @click.stop />
    <template #dropdown><el-dropdown-menu><el-dropdown-item v-for="tool in controller.tools" :key="tool.id" :command="tool.id">{{ translate(tool.label) }}</el-dropdown-item></el-dropdown-menu></template>
  </el-dropdown>
  <el-dialog v-model="controller.state.visible" :title="translate(controller.definition.label)" width="min(520px, calc(100vw - 32px))" appendToBody :closeOnClickModal="false" :closeOnPressEscape="!controller.state.preparing" :showClose="!controller.state.preparing" @closed="controller.close">
    <div v-loading="controller.state.loading" class="intentForm nodrag nopan nowheel" @pointerdown.stop @keydown.stop>
      <div class="intentHeading">
        <span>{{ translate('编辑指令') }}</span>
        <el-tooltip placement="top" :content="translate(controller.state.intent === 'image:erase-object' ? '先打开现有局部编辑面板，绘制要擦除的选区，再确认生成。' : '只创建编辑节点，检查模型、参数和预计积分后再生成。结果可能改变细节，原图会保留。')"><el-button text :icon="IconInfoCircle" :aria-label="translate('操作说明')" /></el-tooltip>
      </div>
      <el-input v-model="controller.state.prompt" type="textarea" :autosize="{ minRows: 3, maxRows: 8 }" :disabled="controller.state.preparing" :aria-label="translate('编辑指令')" />
      <label>{{ translate('选择图片模型') }}<el-select v-model="controller.state.model" :disabled="controller.state.preparing" @change="controller.chooseModel"><el-option v-for="model in controller.choices" :key="JSON.stringify([model.providerId, model.modelId])" :value="JSON.stringify([model.providerId, model.modelId])" :label="`${model.providerLabel} · ${model.label}`" /></el-select></label>
      <div class="intentSettings">
        <label>{{ translate('清晰度') }}<el-select v-model="controller.state.size" :disabled="controller.state.preparing"><el-option v-if="controller.state.size && !controller.choice?.imageSizes?.includes(controller.state.size)" :value="controller.state.size" :label="sizeLabel(controller.choice, controller.state.size)"/><el-option v-for="size in controller.choice?.imageSizes || []" :key="size" :value="size" :label="sizeLabel(controller.choice, size)" /></el-select></label>
        <label>{{ translate('比例') }}<el-select v-model="controller.state.ratio" :disabled="controller.state.preparing"><el-option v-for="ratio in controller.choice?.imageRatios || []" :key="ratio" :value="ratio" :label="ratio === 'auto' ? translate('自动') : ratio" /></el-select></label>
        <label v-if="controller.state.intent === 'image:ai-redraw' && controller.choice?.quality?.length">{{ translate('质量') }}<el-select v-model="controller.state.quality" :disabled="controller.state.preparing"><el-option :value="controller.choice.quality.includes('auto') ? 'auto' : ''" :label="translate(controller.choice.quality.includes('auto') ? '自动' : '默认')" /><el-option v-for="quality in controller.choice.quality.filter(item => item !== 'auto')" :key="quality" :value="quality" :label="qualityLabel(quality)" /></el-select></label>
      </div>
      <label v-if="controller.state.intent !== 'image:erase-object' && controller.choice?.referenceRoles?.length">{{ translate('参考分工') }}<el-select v-model="controller.state.sourceRole" :disabled="controller.state.preparing"><el-option v-for="role in controller.choice.referenceRoles" :key="role.value" :value="role.value" :label="translate(role.label)" /></el-select></label>
    </div>
    <template #footer><el-button :disabled="controller.state.preparing" @click="controller.close">{{ translate('取消') }}</el-button><el-button type="primary" :loading="controller.state.preparing" :disabled="controller.busy || !controller.canPrepare" @click="controller.prepare">{{ translate(controller.state.intent === 'image:erase-object' ? '打开局部编辑' : '创建编辑节点') }}</el-button></template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ElButton, ElDialog, ElDropdown, ElDropdownMenu, ElDropdownItem, ElInput, ElOption, ElSelect, ElTooltip, ElLoading } from "element-plus";
import { IconAdjustments, IconInfoCircle } from "@tabler/icons-vue";
import { translate } from "@miaoimg/i18n/vue";
import { sizeRatio, sizeTier } from "../../../../../../../../server/media-size-label";
import type { NodeMediaModel } from "../../../scaffold/nodeAi";
import type { useImageIntentActions } from "../useImageIntentActions";
defineProps<{ controller: ReturnType<typeof useImageIntentActions>; disabled?: boolean }>();
const vLoading = ElLoading.directive;
function sizeLabel(model: NodeMediaModel | undefined, size: string) {
  if (size === "auto") return translate("自动");
  const metadata = model?.sizes?.find(item => item.value === size);
  return [metadata?.ratio && metadata.ratio !== "auto" ? metadata.ratio : sizeRatio(size), sizeTier(size, metadata?.label)].filter(Boolean).join(" · ");
}
function qualityLabel(value: string) {
  return translate(({ low: "低画质", medium: "标准画质", high: "高画质", xhigh: "超高画质", max: "极致画质" } as Record<string, string>)[value] || value);
}
</script>

<style scoped>
.intentForm { display: grid; gap: 14px; }
.intentHeading { display: flex; align-items: center; justify-content: space-between; }
.intentForm label { display: grid; gap: 6px; font-size: 12px; }
.intentSettings { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
</style>
