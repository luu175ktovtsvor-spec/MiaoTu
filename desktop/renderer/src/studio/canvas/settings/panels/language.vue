<template>
  <div class="language">
    <button class="systemCard" type="button" :aria-pressed="uiSettings.language === 'system'" @click="pick('system')">
      <span class="systemIcon"><icon-device-desktop :size="20" aria-hidden="true" /></span>
      <span class="systemText">
        <strong>{{ translate('跟随系统') }}</strong>
        <small :lang="systemLocale" dir="auto">{{ systemName }}</small>
      </span>
      <span class="check" aria-hidden="true"><icon-check v-if="uiSettings.language === 'system'" :size="16" :strokeWidth="2.5" /></span>
    </button>

    <section class="languageGroup">
      <h3>{{ translate('常用语言') }}</h3>
      <div class="quickGrid" role="radiogroup" :aria-label="translate('常用语言')">
        <button
          v-for="item in primaryLocales"
          :key="item.code"
          class="languageCard quickCard"
          type="button"
          role="radio"
          :aria-checked="uiSettings.language === item.code"
          @click="pick(item.code)">
          <span class="name" :lang="item.code" dir="auto">{{ item.code === 'zh-CN' ? translate('中文') : item.name }}</span>
          <span class="check" aria-hidden="true"><icon-check v-if="uiSettings.language === item.code" :size="16" :strokeWidth="2.5" /></span>
        </button>
      </div>
    </section>
    <section v-if="otherLocales.length" class="languageGroup">
      <h3>{{ translate('更多语言') }}</h3>
      <div class="grid" role="radiogroup" :aria-label="translate('更多语言')">
        <button
          v-for="item in otherLocales"
          :key="item.code"
          class="languageCard"
          type="button"
          role="radio"
          :aria-checked="uiSettings.language === item.code"
          @click="pick(item.code)">
          <span class="name" :lang="item.code" dir="auto">{{ item.name }}</span>
          <span class="check" aria-hidden="true"><icon-check v-if="uiSettings.language === item.code" :size="16" :strokeWidth="2.5" /></span>
        </button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, shallowRef } from 'vue';
import { IconCheck, IconDeviceDesktop } from '@tabler/icons-vue';
import { detectLocale, supportedLocales, type Locale } from '@miaoimg/i18n';
import { translate } from '@miaoimg/i18n/vue';
import { uiSettings, updateUiSettings } from '@/stores/settings';

const systemLocale = shallowRef(detectLocale(navigator.languages));
const followSystemLanguage = () => { systemLocale.value = detectLocale(navigator.languages); };
onMounted(() => window.addEventListener('languagechange', followSystemLanguage));
onBeforeUnmount(() => window.removeEventListener('languagechange', followSystemLanguage));
const systemName = computed(() => supportedLocales.find(item => item.code === systemLocale.value)?.name);
const primaryLocales = supportedLocales.filter(item => item.code === 'zh-CN' || item.code === 'en');
const otherLocales = supportedLocales.filter(item => item.code !== 'zh-CN' && item.code !== 'en');

function pick(language: Locale | 'system') {
  updateUiSettings({ language });
}
</script>

<style lang="scss" scoped>
.language {
  display: flex;
  flex-direction: column;
  gap: var(--settings-gap-section);
  min-width: 0;
}

.systemCard,
.languageCard {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  background: var(--el-bg-color-overlay);
  color: var(--el-text-color-primary);
  font: inherit;
  text-align: start;
  cursor: pointer;
  transition: border-color 0.18s, background-color 0.18s;

  &:hover { border-color: var(--el-color-primary-light-5); background: var(--el-fill-color-extra-light); }
  &[aria-pressed='true'],
  &[aria-checked='true'] { border-color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
  &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }

  .check { display: grid; place-items: center; flex-shrink: 0; width: 16px; color: var(--el-color-primary); }
}

.systemCard {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;

  .systemIcon { display: grid; place-items: center; flex-shrink: 0; width: 30px; height: 30px; border-radius: 8px; background: var(--el-fill-color-light); color: var(--el-text-color-regular); }
  .systemText {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    strong { font-size: 13px; font-weight: 500; line-height: 1.45; }
    small { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.4; }
  }
}

.languageGroup {
  min-width: 0;
  h3 {
    // 分组标题到下面语言卡；卡片自身内边距与两组网格布局不动
    margin: 0 0 var(--settings-gap-block);
    color: var(--el-text-color-secondary);
    font-size: 12px;
    font-weight: 600;
    line-height: 1.5;
  }
}

.quickGrid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

// 常用语言（.quickCard）与更多语言（.grid 里的卡）是同一张卡的两种排布，
// 卡片本身的尺寸和内边距放在这里共用，别再嵌进 .grid —— 那样只有「更多语言」拿得到。
.languageCard {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 42px;
  padding: 10px 14px;

  .name { min-width: 0; font-size: 13px; line-height: 1.5; font-weight: 500; overflow-wrap: anywhere; }
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 8px;
}

@media (max-width: 420px) {
  .quickGrid { grid-template-columns: 1fr; }
}

@media (prefers-reduced-motion: reduce) {
  .systemCard,
  .languageCard { transition: none; }
}
</style>
