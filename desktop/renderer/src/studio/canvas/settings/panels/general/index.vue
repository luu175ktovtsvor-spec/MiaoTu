<template>
  <div class="general">
    <settings-section>
      <settings-row :label="translate('启动动画')" :description="translate('打开妙图时的开场动画，关闭后启动更快；下次启动生效。')">
        <el-switch
          :modelValue="uiSettings.startupAnimation"
          :aria-label="translate('启动动画')"
          @change="(value) => updateUiSettings({ startupAnimation: value === true })" />
      </settings-row>

      <settings-row :label="translate('流畅画布')" :description="translate('优化节点较多时的平移和缩放；设备运行吃力时可以关闭。')">
        <el-switch
          :modelValue="generalSettings.canvasCompositingEnabled"
          :aria-label="translate('流畅画布')"
          @change="(value) => updateGeneralSettings({ canvasCompositingEnabled: value === true })" />
      </settings-row>

      <settings-row :label="translate('节点连线动画')" :description="translate('选中或拖动节点时，相连的线条显示流动动画；关闭后仍有高亮。')">
        <el-switch
          :modelValue="generalSettings.canvasEdgeAnimationEnabled"
          :aria-label="translate('节点连线动画')"
          @change="(value) => updateGeneralSettings({ canvasEdgeAnimationEnabled: value === true })" />
      </settings-row>

      <settings-row :label="translate('节点连线高亮颜色')" :description="translate('选中或拖动节点时，相连线条的高亮颜色。')" control-width="240px">
        <el-select
          :modelValue="generalSettings.canvasEdgeColorMode"
          :aria-label="translate('节点连线颜色模式')"
          @change="(value) => updateGeneralSettings({ canvasEdgeColorMode: value })">
          <el-option :label="translate('不高亮')" value="none" />
          <el-option :label="translate('跟随主题色')" value="theme" />
          <el-option :label="translate('自选颜色')" value="custom" />
        </el-select>
        <el-color-picker
          v-if="generalSettings.canvasEdgeColorMode === 'custom'"
          :modelValue="generalSettings.canvasEdgeColor"
          colorFormat="hex"
          :aria-label="translate('节点连线自选颜色')"
          @change="setCanvasEdgeColor" />
      </settings-row>
    </settings-section>

    <canvas-shortcuts />
  </div>
</template>

<script setup lang="ts">
import { translate } from "@miaoimg/i18n/vue";
import settingsRow from "../../components/settingsRow.vue";
import settingsSection from "../../components/settingsSection.vue";
import { defaultUiSettings, generalSettings, uiSettings, updateGeneralSettings, updateUiSettings } from "@/stores/settings";
import canvasShortcuts from "./canvasShortcuts.vue";
function setCanvasEdgeColor(value: string | null) {
  updateGeneralSettings({ canvasEdgeColor: value || defaultUiSettings.primaryColor });
}
</script>

<style lang="scss" scoped>
.general {
  display: flex;
  flex-direction: column;
  gap: var(--settings-gap-section);
}
</style>
