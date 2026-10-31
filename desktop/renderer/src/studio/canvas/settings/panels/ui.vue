<template>
  <div class="appearanceEditor">
    <section class="appearanceSection" :aria-label="translate('界面外观')">
      <header class="appearanceSectionHeader">
        <h3>{{ translate('界面外观') }}</h3>
        <span class="appearanceCurrent"><component :is="currentMode.icon" :size="13" aria-hidden="true" />{{ translate(currentMode.label) }}</span>
      </header>
      <div class="appearanceModes" role="group" :aria-label="translate('界面外观')">
        <button v-for="mode in appearanceModes" :key="mode.value" class="appearanceMode" type="button" :aria-pressed="uiSettings.theme === mode.value" @click="updateUiSettings({ theme: mode.value })">
          <span class="modeThumbnail" :class="mode.value" :style="modeThumbnailStyle(mode.value)" aria-hidden="true">
            <span class="miniRail"><i /><i /><i /></span>
            <span class="miniToolbar"><i /><i /></span>
            <span class="miniNode"><i /><i /><i /></span>
            <span class="miniPanel"><i /><i /><i /></span>
            <span v-if="mode.value === 'custom'" class="miniPalette"><i /><i /><i /></span>
          </span>
          <span class="modeCaption"><component :is="mode.icon" :size="15" aria-hidden="true" /><span>{{ translate(mode.label) }}</span><span class="modeCheck" aria-hidden="true"><icon-check v-if="uiSettings.theme === mode.value" :size="11" :stroke-width="2.8" /></span></span>
        </button>
      </div>
      <p class="appearanceSectionHint">{{ translate('跟随系统，或固定明暗和背景') }}</p>
    </section>

    <section v-if="uiSettings.theme === 'custom'" class="customBackground" :aria-label="translate('背景颜色')">
      <div class="controlHeading"><h3>{{ translate('背景颜色') }}</h3><span>{{ uiSettings.backgroundColor.toUpperCase() }}</span></div>
      <div class="backgroundControls">
        <div class="backgroundPresets" role="group" :aria-label="translate('背景颜色')">
          <button v-for="color in backgrounds" :key="color.value" class="backgroundSwatch" type="button" :style="swatchStyle(color.value)" :aria-label="translate(color.label)" :title="translate(color.label)" :aria-pressed="uiSettings.backgroundColor === color.value" @click="updateUiSettings({ backgroundColor: color.value })"><icon-check v-if="uiSettings.backgroundColor === color.value" :size="14" :stroke-width="2.5" /></button>
        </div>
        <div class="hexControl">
          <el-color-picker :model-value="uiSettings.backgroundColor" color-format="hex" :aria-label="translate('自定义背景色')" @change="changeBackground" />
          <el-input v-model="backgroundInput" maxlength="7" spellcheck="false" :aria-label="translate('背景颜色值')" :placeholder="uiSettings.backgroundColor" @change="changeBackground" @blur="backgroundInput = uiSettings.backgroundColor.toUpperCase()" />
        </div>
      </div>
      <p class="appearanceSectionHint">{{ translate('背景和文字一起变，图片视频保持原色') }}</p>
    </section>

    <section class="appearanceWorkbench">
      <div class="appearanceControls">
        <div class="appearanceControl accentControl">
          <div class="controlHeading"><h3>{{ translate('强调颜色') }}</h3><span>{{ uiSettings.primaryColor.toUpperCase() }}</span></div>
          <div class="accentOptions" role="group" :aria-label="translate('强调颜色')">
            <button v-for="color in colors" :key="color.value" class="accentSwatch" type="button" :style="swatchStyle(color.value)" :aria-label="translate(color.label)" :title="translate(color.label)" :aria-pressed="uiSettings.primaryColor.toLowerCase() === color.value" @click="updateUiSettings({ primaryColor: color.value })"><icon-check v-if="uiSettings.primaryColor.toLowerCase() === color.value" :size="14" :stroke-width="2.6" /></button>
            <span class="colorDivider" aria-hidden="true" />
            <span class="customAccentPicker"><el-color-picker :model-value="uiSettings.primaryColor" color-format="hex" :aria-label="translate('自定义主题色')" @change="changeColor" /><span>{{ translate('自定义') }}</span></span>
          </div>
          <p class="controlHint">{{ translate('按钮、选中态和画布高亮') }}</p>
        </div>

        <div class="appearanceControl scaleControl">
          <div class="controlHeading"><h3>{{ translate('字体大小') }}</h3><output>{{ fontScale }}<small>%</small></output></div>
          <div class="sliderHeading" aria-hidden="true"><span class="typeSmall">Aa</span><span class="typeLarge">Aa</span></div>
          <el-slider v-model="fontScale" class="appearanceSlider" :min="85" :max="125" :step="5" :format-tooltip="formatScale" :aria-label="translate('字体大小')" @change="commitFontScale" />
          <div class="sliderScale"><span>85%</span><span>{{ translate('默认') }} 100%</span><span>125%</span></div>
        </div>

        <div class="appearanceControl radiusControl">
          <div class="controlHeading"><h3>{{ translate('界面圆角') }}</h3><output>{{ radius }}<small>px</small></output></div>
          <div class="sliderHeading" aria-hidden="true"><span class="radiusSample square" /><span class="radiusSample rounded" /></div>
          <el-slider v-model="radius" class="appearanceSlider" :min="0" :max="16" :step="2" :format-tooltip="formatRadius" :aria-label="translate('界面圆角')" @change="commitRadius" />
          <div class="sliderScale"><span>{{ translate('无圆角') }}</span><span>8px</span><span>{{ translate('默认') }} 16px</span></div>
        </div>
      </div>

      <section class="appearancePreview" :aria-label="translate('外观预览')">
        <div class="previewHeading"><span>{{ translate('外观预览') }}</span><span class="previewMode">{{ translate(currentMode.label) }}</span></div>
        <div class="previewCanvas" :style="previewStyle" aria-hidden="true">
          <div class="previewToolbar"><icon-layout-grid :size="11" /><span>{{ translate('工作区') }}</span><i /><i /></div>
          <svg class="previewConnection" viewBox="0 0 320 300" preserveAspectRatio="none"><path d="M 150 120 C 224 120 117 221 192 221" /></svg>
          <div class="previewTextNode">
            <div class="previewNodeHeading"><span class="previewTextIcon">T</span><span>{{ translate('文本') }}</span><i /></div>
            <div class="previewTextBody"><strong>{{ translate('从一个想法开始') }}</strong><span>{{ translate('正文与说明文字') }}</span></div>
            <span class="previewPort" />
          </div>
          <div class="previewImageNode">
            <div class="previewNodeHeading"><icon-photo :size="11" /><span>{{ translate('图片') }}</span><i /></div>
            <div class="previewImageBody"><icon-photo :size="25" :stroke-width="1.4" /></div>
            <span class="previewAction">{{ translate('主按钮') }}<span>↗</span></span>
            <span class="previewPort" />
          </div>
          <div class="previewTools"><i /><i /><i class="active" /><i /></div>
        </div>
        <div class="previewSpecimens" :style="previewStyle"><span class="previewSpecimenTitle">Aa</span><span class="previewSpecimenCopy">{{ translate('正文与说明文字') }}</span><span class="previewSpecimenTag">{{ translate('标签') }}</span></div>
      </section>
    </section>

    <Teleport to="#settings-footer"><el-button class="appearanceReset" :icon="IconRestore" @click="resetUi">{{ translate('恢复默认') }}</el-button></Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watchEffect } from "vue";
import { translate } from "@miaoimg/i18n/vue";
import { IconCheck, IconDeviceDesktop, IconLayoutGrid, IconMoon, IconPalette, IconPhoto, IconRestore, IconSun } from "@tabler/icons-vue";
import { appearancePalette, type AppearanceMode } from "@/clientAppearance";
import { defaultUiSettings, uiSettings, updateUiSettings } from "@/stores/settings";

const fontScale = ref(uiSettings.value.fontScale);
const radius = ref(uiSettings.value.radius);
const backgroundInput = ref(uiSettings.value.backgroundColor.toUpperCase());
const systemMedia = window.matchMedia("(prefers-color-scheme: dark)");
const systemDark = ref(systemMedia.matches);
const updateSystemDark = () => { systemDark.value = systemMedia.matches; };
systemMedia.addEventListener("change", updateSystemDark);
onBeforeUnmount(() => systemMedia.removeEventListener("change", updateSystemDark));

const appearanceModes = [
  { value: "system", label: "跟随系统", icon: IconDeviceDesktop },
  { value: "light", label: "浅色", icon: IconSun },
  { value: "dark", label: "深色", icon: IconMoon },
  { value: "custom", label: "自定义", icon: IconPalette },
] as const;
const currentMode = computed(() => appearanceModes.find(mode => mode.value === uiSettings.value.theme) || appearanceModes[0]);
const backgrounds = [
  { value: "#111114", label: "石墨黑" }, { value: "#f4f4f6", label: "雾白" },
  { value: "#e9e3d9", label: "暖灰" }, { value: "#18242b", label: "深海蓝" },
  { value: "#1d2925", label: "森林绿" }, { value: "#292231", label: "暮紫" },
];
const colors = [
  { value: "#f2f2f2", label: "亮白" }, { value: "#d7f7ff", label: "冰蓝" },
  { value: "#6366f1", label: "鸢尾紫" }, { value: "#a855f7", label: "薰衣紫" },
  { value: "#e34b83", label: "蔷薇粉" }, { value: "#e89524", label: "琥珀橙" },
  { value: "#18a17c", label: "松石绿" },
];
watchEffect(() => {
  fontScale.value = uiSettings.value.fontScale;
  radius.value = uiSettings.value.radius;
  backgroundInput.value = uiSettings.value.backgroundColor.toUpperCase();
});

const previewStyle = computed(() => ({
  ...appearancePalette(uiSettings.value, systemDark.value).tokens,
  "--preview-radius": `${radius.value}px`,
  "--preview-font-scale": String(fontScale.value / 100),
}));
function modeThumbnailStyle(theme: AppearanceMode) {
  const palette = appearancePalette({ ...uiSettings.value, theme }, systemDark.value).tokens;
  return {
    "--sample-canvas": theme === "system" ? "linear-gradient(90deg, #f5f5f5 50%, #141414 50%)" : palette["--color-canvas"],
    "--sample-surface": theme === "system" ? "linear-gradient(90deg, #ffffff 50%, #262626 50%)" : palette["--color-surface"],
    "--sample-ink": theme === "system" ? "#9b9b9b" : palette["--color-muted"],
    "--sample-line": theme === "system" ? "#8b8b8b" : palette["--color-line"],
  };
}
function swatchStyle(color: string) {
  return { "--swatch-color": color, color: appearancePalette({ ...uiSettings.value, theme: "custom", backgroundColor: color }, false).tokens["--color-ink"] };
}
function changeColor(value: string | null) {
  if (value && /^#[\da-f]{6}$/i.test(value)) updateUiSettings({ primaryColor: value.toLowerCase() });
}
function changeBackground(value: string | null) {
  if (value && /^#[\da-f]{6}$/i.test(value)) updateUiSettings({ backgroundColor: value.toLowerCase() });
}
const formatScale = (value: number) => `${value}%`;
const formatRadius = (value: number) => `${value}px`;
function commitFontScale(value: number | number[]) { if (typeof value === "number") updateUiSettings({ fontScale: value }); }
function commitRadius(value: number | number[]) { if (typeof value === "number") updateUiSettings({ radius: value }); }
function resetUi() {
  updateUiSettings({ ...defaultUiSettings, language: uiSettings.value.language, startupAnimation: uiSettings.value.startupAnimation });
}
</script>

<style lang="scss" scoped>
.appearanceEditor { display: grid; gap: 24px; container-type: inline-size; }
.appearanceSectionHeader, .controlHeading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.appearanceSectionHeader { margin-bottom: 14px; }
.appearanceSectionHeader h3, .controlHeading h3 { margin: 0; color: var(--el-text-color-primary); font-size: 13px; font-weight: 600; line-height: 20px; }
.appearanceCurrent { display: inline-flex; align-items: center; gap: 5px; color: var(--el-text-color-secondary); font-size: 11px; line-height: 18px; }
.appearanceModes { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.appearanceMode { min-width: 0; padding: 5px; border: 1px solid var(--el-border-color); border-radius: 13px; background: var(--color-surface); color: var(--el-text-color-regular); text-align: start; font: inherit; cursor: pointer; transition: border-color .16s, box-shadow .16s, background .16s; }
.appearanceMode:hover { border-color: var(--color-line-strong); background: var(--color-hover); }
.appearanceMode[aria-pressed="true"] { border-color: var(--el-color-primary); box-shadow: 0 0 0 1px var(--el-color-primary); }
.appearanceMode:focus-visible, .accentSwatch:focus-visible, .backgroundSwatch:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 4px; }
.modeThumbnail { position: relative; display: block; height: 80px; overflow: hidden; border: 1px solid color-mix(in srgb,var(--sample-line) 60%,transparent); border-radius: 8px; background: var(--sample-canvas); }
.modeThumbnail i { display: block; height: 3px; border-radius: 2px; background: var(--sample-ink); opacity: .35; }
.miniRail { position: absolute; inset: 0 auto 0 0; display: grid; align-content: start; gap: 7px; width: 20%; padding: 14px 5px; border-inline-end: 1px solid color-mix(in srgb,var(--sample-line) 50%,transparent); background: var(--sample-surface); }
.miniRail i:first-child { width: 70%; margin-bottom: 4px; opacity: .65; }
.miniToolbar { position: absolute; inset: 7px 7px auto auto; display: flex; gap: 5px; width: 38%; height: 8px; align-items: center; justify-content: flex-end; }
.miniToolbar i { width: 12px; height: 3px; }
.miniNode, .miniPanel { position: absolute; display: grid; align-content: start; gap: 5px; padding: 8px; border: 1px solid color-mix(in srgb,var(--sample-line) 50%,transparent); border-radius: 5px; background: var(--sample-surface); box-shadow: 0 2px 4px rgb(0 0 0 / .03); }
.miniNode { top: 25px; inset-inline-start: 31%; width: 34%; height: 36px; }
.miniNode i:last-child { width: 60%; }
.miniPanel { top: 21px; inset-inline-end: -7px; width: 24%; height: 47px; gap: 5px; padding: 8px 5px; }
.miniPalette { position: absolute; inset-inline-end: 8px; bottom: 8px; display: flex; gap: 3px; }
.miniPalette i { width: 6px; height: 6px; border-radius: 50%; opacity: 1; background: #9c9df9; }
.miniPalette i:nth-child(2) { background: #df8ca5; }
.miniPalette i:nth-child(3) { background: #e6b468; }
.modeThumbnail.system .miniRail { background: #ffffff; }
.modeThumbnail.system .miniNode { background: linear-gradient(90deg,#fff 55%,#262626 55%); }
.modeThumbnail.system .miniPanel { background: #262626; }
.modeCaption { display: flex; align-items: center; gap: 5px; min-height: 34px; padding: 6px 3px 3px; font-size: 12px; line-height: 18px; }
.modeCaption > span:not(.modeCheck) { min-width: 0; overflow-wrap: anywhere; }
.modeCaption > svg { flex-shrink: 0; color: var(--el-text-color-secondary); }
.modeCheck { display: grid; place-items: center; flex: 0 0 15px; width: 15px; height: 15px; margin-inline-start: auto; border: 1px solid var(--el-border-color); border-radius: 50%; }
.appearanceMode[aria-pressed="true"] .modeCheck { color: var(--canvas-accent-ink,var(--color-accent-ink)); border-color: var(--el-color-primary); background: var(--el-color-primary); }
.appearanceSectionHint { margin: 12px 0 0; color: var(--el-text-color-secondary); font-size: 11px; line-height: 1.65; }
.customBackground { padding: 18px 20px; border: 1px solid var(--el-border-color); border-radius: 14px; background: var(--color-surface); }
.controlHeading > span { color: var(--el-text-color-secondary); font: 11px/18px var(--font-mono,ui-monospace,monospace); }
.backgroundControls { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 14px; margin-top: 14px; }
.backgroundPresets, .accentOptions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.backgroundSwatch, .accentSwatch { display: grid; place-items: center; flex-shrink: 0; width: 28px; height: 28px; margin: 0; padding: 0; border: 1px solid rgb(0 0 0 / .08); background: var(--swatch-color); cursor: pointer; }
.backgroundSwatch { width: 34px; height: 28px; border-radius: 7px; }
.accentSwatch { border-radius: 50%; }
.backgroundSwatch[aria-pressed="true"], .accentSwatch[aria-pressed="true"] { outline: 2px solid var(--el-text-color-primary); outline-offset: 3px; }
.hexControl { display: flex; align-items: center; gap: 9px; }
.hexControl .el-input { width: 110px; font-family: var(--font-mono,ui-monospace,monospace); }
.appearanceWorkbench { display: grid; grid-template-columns: minmax(0,1.08fr) minmax(230px,.92fr); overflow: hidden; border: 1px solid var(--el-border-color); border-radius: 16px; background: var(--color-surface); }
.appearanceControls { min-width: 0; padding: 20px 22px 22px; }
.appearanceControl + .appearanceControl { padding-top: 22px; margin-top: 22px; border-top: 1px solid var(--el-border-color-lighter); }
.controlHeading output { display: inline-flex; align-items: baseline; justify-content: flex-end; gap: 3px; min-width: 48px; color: var(--el-text-color-primary); font-size: 15px; font-weight: 500; font-variant-numeric: tabular-nums; line-height: 20px; }
.controlHeading output small { color: var(--el-text-color-secondary); font-size: 10px; font-weight: 400; }
.accentOptions { margin-top: 17px; gap: 10px; }
.customAccentPicker { display: inline-flex; align-items: center; gap: 7px; }
.customAccentPicker > span { color: var(--el-text-color-secondary); font-size: 10px; line-height: 18px; }
.colorDivider { width: 1px; height: 16px; margin-inline: 1px; background: var(--el-border-color); }
.controlHint { margin: 14px 0 0; color: var(--el-text-color-secondary); font-size: 11px; line-height: 1.6; }
.accentOptions :deep(.el-color-picker), .hexControl :deep(.el-color-picker) { --el-color-picker-size: 28px; height: 28px; }
.accentOptions :deep(.el-color-picker__trigger), .hexControl :deep(.el-color-picker__trigger) { width: 28px; height: 28px; padding: 3px; border-color: var(--el-border-color); border-radius: 7px; background: var(--color-surface); }
.accentOptions :deep(.el-color-picker__color), .hexControl :deep(.el-color-picker__color) { border: 0; border-radius: 3px; overflow: hidden; }
.sliderHeading { display: flex; align-items: flex-end; justify-content: space-between; height: 23px; margin-top: 8px; color: var(--el-text-color-secondary); }
.typeSmall { font-size: 11px; }
.typeLarge { font-size: 17px; line-height: 20px; }
.radiusSample { display: block; width: 15px; height: 15px; border: 1px solid var(--el-text-color-secondary); }
.radiusSample.square { border-radius: 0; }
.radiusSample.rounded { border-radius: 5px; }
.appearanceSlider { width: auto; margin: 0 5px; }
.appearanceSlider :deep(.el-slider__runway) { height: 3px; margin-block: 14px 10px; background: var(--el-fill-color-light); }
.appearanceSlider :deep(.el-slider__bar) { height: 3px; }
.appearanceSlider :deep(.el-slider__button-wrapper) { top: -16px; }
.appearanceSlider :deep(.el-slider__button) { width: 11px; height: 11px; border-width: 2px; }
.appearanceEditor .appearanceSlider :deep(.el-slider__bar),
.appearanceEditor .appearanceSlider :deep(.el-slider__button) { box-shadow: none !important; }
.appearanceEditor .hexControl :deep(.el-input__wrapper) { border-radius: 8px; background: var(--color-canvas); box-shadow: 0 0 0 1px var(--el-border-color) inset !important; }
.appearanceEditor .hexControl :deep(.el-input__wrapper.is-focus) { box-shadow: 0 0 0 1px var(--el-color-primary) inset !important; }
.sliderScale { display: flex; justify-content: space-between; gap: 6px; color: var(--el-text-color-secondary); font-size: 10px; font-variant-numeric: tabular-nums; line-height: 18px; }
.sliderScale > span:nth-child(2) { color: var(--el-text-color-placeholder); }
.appearancePreview { display: flex; flex-direction: column; min-width: 0; padding: 18px; border-inline-start: 1px solid var(--el-border-color); background: var(--color-soft); }
.previewHeading { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; color: var(--el-text-color-secondary); font-size: 11px; line-height: 18px; }
.previewMode { font-size: 10px; color: var(--el-text-color-placeholder); }
.previewCanvas { position: relative; flex: 1; min-height: 250px; overflow: hidden; border: 1px solid var(--color-line); border-radius: 11px; background-color: var(--color-canvas); background-image: radial-gradient(var(--color-grid) .65px,transparent .65px); background-size: 14px 14px; }
.previewToolbar { position: absolute; top: 12px; left: 12px; display: flex; align-items: center; gap: 5px; max-width: calc(100% - 24px); height: 25px; padding: 0 8px; border: 1px solid var(--color-line); border-radius: max(4px,calc(var(--preview-radius) * .55)); background: var(--color-surface); color: var(--color-body); font-size: 9px; }
.previewToolbar i { display: block; width: 3px; height: 3px; margin-inline-start: 4px; border-radius: 50%; background: var(--color-muted); }
.previewConnection { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; fill: none; stroke: var(--color-accent); stroke-width: 1.3; opacity: .45; }
.previewTextNode, .previewImageNode { position: absolute; overflow: visible; border: 1px solid var(--color-line); border-radius: min(12px,var(--preview-radius)); background: var(--color-surface); color: var(--color-ink); box-shadow: 0 3px 8px rgb(0 0 0 / .04); }
.previewTextNode { top: 67px; left: 16px; width: 61%; z-index: 1; }
.previewNodeHeading { display: flex; align-items: center; gap: 5px; height: 24px; padding: 0 8px; border-bottom: 1px solid var(--color-line); color: var(--color-body); font-size: calc(9px * var(--preview-font-scale)); }
.previewNodeHeading > i { width: 3px; height: 3px; margin-inline-start: auto; border-radius: 50%; background: var(--color-muted); }
.previewTextIcon { font-family: Georgia,serif; font-size: 13px; line-height: 1; }
.previewTextBody { display: flex; flex-direction: column; gap: 7px; padding: 12px 10px 14px; }
.previewTextBody strong { color: var(--color-ink); font-size: calc(11px * var(--preview-font-scale)); font-weight: 500; line-height: 1.6; }
.previewTextBody > span { color: var(--color-muted); font-size: calc(9px * var(--preview-font-scale)); line-height: 1.6; }
.previewPort { position: absolute; top: 12px; right: -3px; width: 5px; height: 5px; border: 1px solid var(--color-muted); border-radius: 50%; background: var(--color-surface); }
.previewImageNode { right: 14px; bottom: 31px; width: 50%; }
.previewImageNode > .previewPort { right: auto; left: -3px; }
.previewImageBody { display: grid; place-items: center; height: 55px; margin: 6px 6px 0; border-radius: min(7px,var(--preview-radius)); background: var(--color-soft); color: var(--color-muted); }
.previewAction { display: flex; align-items: center; justify-content: space-between; min-height: 22px; margin: 6px; padding: 0 7px; border-radius: min(7px,var(--preview-radius)); background: var(--color-accent); color: var(--color-accent-ink); font-size: calc(9px * var(--preview-font-scale)); }
.previewTools { position: absolute; display: flex; align-items: center; justify-content: center; gap: 9px; width: 70px; height: 23px; bottom: 10px; left: 50%; transform: translateX(-50%); border: 1px solid var(--color-line); border-radius: 7px; background: var(--color-surface); }
.previewTools i { width: 6px; height: 6px; border: 1px solid var(--color-muted); border-radius: 2px; }
.previewTools i.active { background: var(--color-accent); border-color: var(--color-accent); }
.previewSpecimens { display: flex; align-items: center; gap: 9px; min-height: 30px; margin-top: 12px; color: var(--color-body); }
.previewSpecimenTitle { font-size: calc(19px * var(--preview-font-scale)); letter-spacing: -.06em; line-height: 1.1; }
.previewSpecimenCopy { min-width: 0; flex: 1; color: var(--color-muted); font-size: calc(10px * var(--preview-font-scale)); line-height: 1.4; }
.previewSpecimenTag { padding: 3px 6px; border: 1px solid var(--color-line); border-radius: min(8px,var(--preview-radius)); color: var(--color-body); background: var(--color-surface); font-size: 9px; line-height: 1.3; }
@container (max-width: 600px) {
  .appearanceModes { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .modeThumbnail { height: 88px; }
  .appearanceWorkbench { grid-template-columns: minmax(0,1fr); }
  .appearancePreview { min-height: 300px; border-inline-start: 0; border-top: 1px solid var(--el-border-color); }
  .previewCanvas { min-height: 265px; }
  .previewTextNode { width: 50%; }
  .previewImageNode { width: 42%; }
}
@media (prefers-reduced-motion: reduce) { .appearanceMode { transition: none; } }
</style>
