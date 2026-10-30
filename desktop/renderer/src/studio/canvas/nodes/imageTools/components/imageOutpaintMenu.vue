<template>
  <el-button v-if="controller.available" text :icon="IconArrowsMaximize" :disabled="disabled || controller.busy" :title="translate('扩图')" :aria-label="translate('扩图')" @click.stop="controller.open()" />
  <el-dialog :model-value="controller.state.visible" width="min(620px, calc(100vw - 32px))" append-to-body :close-on-click-modal="false" :close-on-press-escape="!controller.state.saving" :show-close="!controller.state.saving" @update:model-value="value => { if (!value) controller.close(); }">
    <template #header="{ titleId, titleClass }"><div class="outpaintHeading"><h2 :id="titleId" :class="titleClass">{{ translate('扩图') }}</h2><el-tooltip placement="bottom" :content="translate('原图不缩放，只平移到扩展画布。扩展边界会向外对齐模型尺寸要求；先准备真实画布与蒙版，检查预计积分后再生成。模型仍可能改变原图细节，原件会保留。')"><el-button text :icon="IconInfoCircle" :aria-label="translate('操作说明')" /></el-tooltip></div></template>
    <div v-loading="controller.state.loading" class="outpaintForm nodrag nopan nowheel" @pointerdown.stop @keydown.stop>
      <div class="outpaintStage" :style="stageStyle">
        <img v-if="controller.state.preview" :src="controller.state.preview" :style="imageStyle" :alt="translate('扩图预览')" draggable="false" />
      </div>
      <label>{{ translate('选择图片模型') }}<el-select v-model="controller.state.model" :disabled="controller.state.saving" :no-data-text="translate('暂无支持蒙版扩图的可用模型')"><el-option v-if="controller.state.model && !controller.choice" :value="controller.state.model" :label="nodeModelValueLabel(controller.state.model)" disabled/><el-option v-for="model in controller.choices" :key="JSON.stringify([model.providerId, model.modelId])" :value="JSON.stringify([model.providerId, model.modelId])" :label="model.label" /></el-select></label>
      <div class="extensionEdges"><label v-for="edge in edges" :key="edge.key"><span>{{ translate(edge.label) }} <b>{{ controller.state.ratio === 'free' ? '' : '≥ ' }}{{ controller.state[edge.key] }}%</b></span><el-slider v-model="controller.state[edge.key]" :min="0" :max="200" :step="5" :disabled="controller.state.saving" :aria-label="translate(edge.label)" /></label></div>
      <div class="outpaintOptions"><label>{{ translate('目标比例') }}<el-select v-model="controller.state.ratio" :disabled="controller.state.saving"><el-option value="free" :label="translate('自由扩展')"/><el-option v-for="ratio in ['1:1','4:3','3:4','16:9','9:16','2:1']" :key="ratio" :value="ratio" :label="ratio"/></el-select></label><label>{{ translate('原图位置') }}<div class="outpaintAnchors"><button v-for="(anchor,index) in anchors" :key="index" type="button" :class="{ selected: controller.state.anchorX === anchor[0] && controller.state.anchorY === anchor[1] }" :aria-pressed="controller.state.anchorX === anchor[0] && controller.state.anchorY === anchor[1]" :aria-label="translate('原图位置 {0}', { 0: index+1 })" :disabled="controller.state.saving || controller.state.ratio === 'free'" @click="controller.state.anchorX = anchor[0]; controller.state.anchorY = anchor[1]"><i/></button></div></label></div>
      <label>{{ translate('编辑指令') }}<el-input v-model="controller.state.prompt" type="textarea" :maxlength="10000" :autosize="{ minRows: 2, maxRows: 5 }" :disabled="controller.state.saving" :aria-label="translate('编辑指令')" /></label>
      <p v-if="controller.calculation.geometry" class="outpaintSummary">{{ mediaSizeLabel(`${controller.calculation.geometry.width}x${controller.calculation.geometry.height}`) }}</p>
      <el-alert v-if="controller.calculation.error" :title="controller.calculation.error" type="warning" :closable="false" />
    </div>
    <template #footer><el-button :disabled="controller.state.cancelling" @click="controller.cancel">{{ translate(controller.state.saving ? '取消处理' : '取消') }}</el-button><el-button type="primary" :loading="controller.state.saving" :disabled="controller.state.loading || !controller.calculation.geometry || Boolean(controller.calculation.error) || controller.state.prompt.trim().length < 2 || controller.state.prompt.length > 10000" @click="controller.prepare">{{ translate('准备扩图节点') }}</el-button></template>
  </el-dialog>
</template>
<script setup lang="ts">
import { computed } from "vue";
import { ElAlert, ElButton, ElDialog, ElInput, ElLoading, ElOption, ElSelect, ElSlider, ElTooltip } from "element-plus";
import { IconArrowsMaximize, IconInfoCircle } from "@tabler/icons-vue";
import { translate } from "@miaoimg/i18n/vue";
import { mediaSizeLabel } from "../../../../../../../../server/media-size-label";
import { nodeModelValueLabel } from "../../../scaffold/localModelLabel";
import type { useImageOutpaintActions } from "../useImageOutpaintActions";
const props = defineProps<{ controller: ReturnType<typeof useImageOutpaintActions>; disabled?: boolean }>();
const vLoading = ElLoading.directive;
const edges = [{key:'left',label:'向左扩展'},{key:'right',label:'向右扩展'},{key:'top',label:'向上扩展'},{key:'bottom',label:'向下扩展'}] as const;
const anchors = [0,.5,1].flatMap(y=>[0,.5,1].map(x=>[x,y]));
const stageStyle = computed(() => {
  const box = props.controller.calculation.geometry;
  const ratio = box ? box.width / box.height : props.controller.state.width / props.controller.state.height || 1;
  return { aspectRatio: String(ratio), width: `min(100%, ${260 * ratio}px)` };
});
const imageStyle = computed(() => {
  const box=props.controller.calculation.geometry;
  return box ? { left:`${box.left/box.width*100}%`,top:`${box.top/box.height*100}%`,width:`${box.sourceWidth/box.width*100}%`,height:`${box.sourceHeight/box.height*100}%` } : {left:'0',top:'0',width:'100%',height:'100%'};
});
</script>
<style scoped>
.outpaintHeading { display:flex; align-items:center; gap:5px; }
.outpaintHeading h2 { margin:0; }
.outpaintForm { display:grid; gap:14px; max-height:68vh; overflow:auto; }
.outpaintStage { position:relative; max-height:260px; width:100%; border:1px solid var(--el-border-color); overflow:hidden; background:repeating-conic-gradient(var(--el-fill-color-dark) 0% 25%,var(--el-fill-color-light) 0% 50%) 0/16px 16px; }
.outpaintStage img { position:absolute; object-fit:fill; }
.outpaintForm label { display:grid; gap:5px; font-size:12px; }
.extensionEdges,.outpaintOptions { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px 20px; }
.extensionEdges span { display:flex; justify-content:space-between; } b { font-weight:500; }
.outpaintAnchors { display:grid; grid-template-columns:repeat(3,18px); gap:3px; direction:ltr; }
.outpaintAnchors button { width:18px;height:18px;padding:3px;border:1px solid var(--el-border-color);background:transparent;cursor:pointer; }
.outpaintAnchors button.selected { border-color:var(--el-color-primary);background:var(--el-color-primary-light-8); }
.outpaintAnchors i { display:block;width:100%;height:100%;background:var(--el-text-color-secondary); }
.outpaintSummary { margin:0;font-size:12px;color:var(--el-text-color-secondary);text-align:right; }
</style>
