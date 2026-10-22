<template>
  <div class="privacy">
    <settings-section>
      <settings-row :label="translate('匿名使用统计')" :description="translate('统计常用功能的使用情况，默认开启，可随时关闭。')">
        <el-switch
          :modelValue="privacySettings.dataCollectionEnabled"
          :aria-label="translate('匿名使用统计')"
          @change="(value) => settings.privacy = { ...privacySettings, dataCollectionEnabled: value === true }" />
      </settings-row>
    </settings-section>

    <settings-section :title="translate('统计内容')" :description="translate('不包含提示词、对话、文件内容、项目名称、路径、账号和密钥。')">
      <settings-row v-for="metric in metrics" :key="metric.label" :label="metric.label" :description="metric.description" />
    </settings-section>

    <settings-section :title="translate('匿名 ID')">
      <settings-row stacked>
        <code class="anonymousId">{{ privacySettings.anonymousId || translate('开启后自动生成') }}</code>
      </settings-row>
    </settings-section>
  </div>
</template>

<script setup lang="ts">
import { translate } from "@miaoimg/i18n/vue";
import settingsRow from "../components/settingsRow.vue";
import settingsSection from "../components/settingsSection.vue";
import { privacySettings, settings } from "@/stores/settings";

const metrics = [
  { get label() { return translate("访问与回访"); }, get description() { return translate("随机匿名标识、访问次数与时间"); } },
  { get label() { return translate("活跃度"); }, get description() { return translate("使用时长和交互次数，不含输入内容"); } },
  { get label() { return translate("运行环境"); }, get description() { return translate("软件版本、桌面或网页端、系统、浏览器和语言"); } },
  { get label() { return translate("功能使用"); }, get description() { return translate("引导、画布与文档的使用情况"); } },
  { get label() { return translate("使用规模"); }, get description() { return translate("项目、模型配置、节点与连线数量，以及节点类型"); } },
  { get label() { return translate("Agent 使用"); }, get description() { return translate("发送次数、完成情况和耗时"); } },
];
</script>

<style lang="scss" scoped>
.privacy {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.anonymousId {
  display: block;
  width: 100%;
  padding: 9px 12px;
  border-radius: var(--el-border-radius-base);
  background: var(--el-fill-color-light);
  color: var(--el-text-color-regular);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
  user-select: text;
}
</style>
