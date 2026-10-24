<template>
  <div class="ui">
    <settings-section>
      <settings-row :label="translate('界面外观')" :description="translate('跟随系统切换明暗，也可以固定外观或选择自己的背景色。')" stacked>
        <div class="appearanceOptions" role="group" :aria-label="translate('界面外观')">
          <button v-for="mode in appearanceModes" :key="mode.value" type="button" :aria-pressed="uiSettings.theme === mode.value" @click="updateUiSettings({ theme: mode.value })">{{ translate(mode.label) }}</button>
        </div>
      </settings-row>

      <settings-row v-if="uiSettings.theme === 'custom'" :label="translate('背景颜色')" :description="translate('背景、面板和文字一起适配，图片与视频保持原色。')" stacked>
        <div class="colorOptions">
          <button v-for="color in backgrounds" :key="color.value" class="colorSwatch" type="button" :style="{ '--swatchColor': color.value }" :aria-label="translate(color.label)" :title="translate(color.label)" :aria-pressed="uiSettings.backgroundColor === color.value" @click="updateUiSettings({ backgroundColor: color.value })" />
          <el-color-picker :modelValue="uiSettings.backgroundColor" colorFormat="hex" :aria-label="translate('自定义背景色')" @change="changeBackground" />
          <el-input v-model="backgroundInput" class="backgroundInput" maxlength="7" :aria-label="translate('背景颜色值')" :placeholder="uiSettings.backgroundColor" @change="changeBackground" @blur="backgroundInput = uiSettings.backgroundColor.toUpperCase()" />
        </div>
      </settings-row>

      <settings-row :label="translate('强调颜色')" :description="translate('按钮、选中状态和画布高亮都用它。')" :value="uiSettings.primaryColor.toUpperCase()" stacked>
        <div class="colorOptions">
          <button
            v-for="color in colors"
            :key="color.value"
            class="colorSwatch"
            type="button"
            :style="{ '--swatchColor': color.value, color: ['#f2f2f2', '#d7f7ff'].includes(color.value) ? '#151515' : '#ffffff' }"
            :aria-label="color.label"
            :aria-pressed="uiSettings.primaryColor.toLowerCase() === color.value"
            :title="color.label"
            @click="updateUiSettings({ primaryColor: color.value })">
            <icon-check v-if="uiSettings.primaryColor.toLowerCase() === color.value" :size="16" :strokeWidth="2.5" />
          </button>
          <span class="colorDivider" aria-hidden="true"></span>
          <el-color-picker
            :modelValue="uiSettings.primaryColor"
            colorFormat="hex"
            :aria-label="translate('自定义主题色')"
            @change="changeColor" />
          <span class="colorHint">{{ translate('自定义') }}</span>
        </div>
      </settings-row>

      <settings-row :label="translate('字体大小')" :description="translate('界面、聊天和节点里的文字大小。')" :value="`${fontScale}%`" stacked>
        <el-slider
          v-model="fontScale"
          class="settingSlider"
          :min="85"
          :max="125"
          :step="5"
          :marks="{ 85: translate('较小'), 100: translate('默认'), 125: translate('较大') }"
          :aria-label="translate('字体大小')"
          @change="(value) => typeof value === 'number' && updateUiSettings({ fontScale: value })" />
      </settings-row>

      <settings-row :label="translate('界面圆角')" :description="translate('卡片、按钮和输入框的圆角。')" :value="`${radius} px`" stacked>
        <el-slider
          v-model="radius"
          class="settingSlider"
          :min="0"
          :max="16"
          :step="2"
          :marks="{ 0: translate('无圆角'), 8: translate('小圆角'), 16: translate('默认') }"
          :aria-label="translate('界面圆角')"
          @change="(value) => typeof value === 'number' && updateUiSettings({ radius: value })" />
      </settings-row>
    </settings-section>

    <section class="preview" :aria-label="translate('外观预览')">
      <h3>{{ translate('外观预览') }}</h3>
      <div class="previewBody">
        <el-button type="primary" size="small">{{ translate('主按钮') }}</el-button>
        <el-button size="small">{{ translate('次按钮') }}</el-button>
        <el-tag type="primary" effect="light">{{ translate('标签') }}</el-tag>
        <span class="previewText">{{ translate('正文与说明文字') }}</span>
      </div>
    </section>

    <Teleport to="#settings-footer">
      <el-button :icon="IconRestore" @click="resetUi">{{ translate('恢复默认') }}</el-button>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { translate } from "@miaoimg/i18n/vue";
import { ref, watchEffect } from "vue";
import { IconCheck, IconRestore } from "@tabler/icons-vue";
import settingsRow from "../components/settingsRow.vue";
import settingsSection from "../components/settingsSection.vue";
import { defaultUiSettings, uiSettings, updateUiSettings } from "@/stores/settings";

const fontScale = ref(uiSettings.value.fontScale);
const radius = ref(uiSettings.value.radius);
const backgroundInput = ref(uiSettings.value.backgroundColor.toUpperCase());
const appearanceModes = [
  { value: 'system', label: '跟随系统' }, { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' }, { value: 'custom', label: '自定义' },
] as const;
const backgrounds = [
  { value: '#111114', label: '石墨黑' }, { value: '#f4f4f6', label: '雾白' },
  { value: '#e9e3d9', label: '暖灰' }, { value: '#18242b', label: '深海蓝' },
  { value: '#1d2925', label: '森林绿' }, { value: '#292231', label: '暮紫' },
];
watchEffect(() => {
  fontScale.value = uiSettings.value.fontScale;
  radius.value = uiSettings.value.radius;
  backgroundInput.value = uiSettings.value.backgroundColor.toUpperCase();
});

const colors = [
  { value: "#f2f2f2", get label() { return translate("亮白"); } },
  { value: "#d7f7ff", get label() { return translate("冰蓝"); } },
  { value: "#6366f1", get label() { return translate("鸢尾紫"); } },
  { value: "#a855f7", get label() { return translate("薰衣紫"); } },
  { value: "#e34b83", get label() { return translate("蔷薇粉"); } },
  { value: "#e89524", get label() { return translate("琥珀橙"); } },
  { value: "#18a17c", get label() { return translate("松石绿"); } },
];
function changeColor(value: string | null) {
  if (value) updateUiSettings({ primaryColor: value });
}
function changeBackground(value: string | null) {
  if (value && /^#[\da-f]{6}$/i.test(value)) updateUiSettings({ backgroundColor: value.toLowerCase() });
}

// 语言和启动动画不在这个面板里，恢复默认时保持不动。
function resetUi() {
  updateUiSettings({ ...defaultUiSettings, language: uiSettings.value.language, startupAnimation: uiSettings.value.startupAnimation });
}
</script>

<style lang="scss" scoped>
.ui {
  display: flex;
  flex-direction: column;
  gap: var(--settings-gap-section);
}

.appearanceOptions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  button {
    flex: 1 0 auto;
    min-height: 38px;
    padding: 8px 14px;
    border: 1px solid var(--el-border-color);
    border-radius: 10px;
    background: transparent;
    color: var(--el-text-color-regular);
    font: inherit;
    cursor: pointer;
    &:hover { background: var(--color-hover); }
    &[aria-pressed="true"] { border-color: var(--el-color-primary); color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
  }
}
.backgroundInput { width: 116px; }

.colorOptions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;

  .colorSwatch {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: var(--swatchColor);
    color: #fff;
    cursor: pointer;

    &[aria-pressed="true"] {
      outline: 2px solid var(--el-text-color-primary);
      outline-offset: 2px;
    }

    &:focus-visible {
      outline: 2px solid var(--el-text-color-primary);
      outline-offset: 2px;
    }
  }

  .colorDivider {
    width: 1px;
    height: 18px;
    margin: 0 2px;
    background: var(--el-border-color);
  }

  .colorHint {
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }
}

.settingSlider {
  // 两端的刻度文字以滑块位置居中，不给够横向留白会顶出内容列。
  padding: 0 24px;
  // 刻度文字挂在滑块下方、不占高度，下面留出它的位置，不压到下一行的分隔线。
  margin-bottom: 30px;

  :deep(.el-slider__marks-text) {
    margin-top: 14px;
    color: var(--el-text-color-secondary);
    font-size: 12px;
    letter-spacing: .04em;
    white-space: nowrap;
  }

  :deep(.el-slider__stop) {
    background-color: var(--el-text-color-secondary);
    box-shadow: 0 0 0 1px var(--el-bg-color-overlay);
  }
}

.preview {
  padding: 14px 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base);
  background: var(--el-fill-color-extra-light);

  h3 {
    // 「外观预览」标题到下面样例控件，与分区标题到正文同档
    margin: 0 0 var(--settings-gap-block);
    color: var(--el-text-color-secondary);
    font-size: 12px;
    font-weight: 500;
    line-height: 1.5;
  }

  .previewBody {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;

    :deep(.el-button + .el-button) { margin-left: 0; }
  }

  .previewText {
    color: var(--el-text-color-regular);
    font-size: 13px;
  }
}
</style>
