<template>
  <div class="nodeErrorContent">
    <div class="errorDetail" tabindex="0">{{ message }}</div>
    <details class="explanation">
      <summary>{{ translate('详情') }}</summary>
      <div class="errorLabel">{{ translate('原因') }}</div>
      <div class="explanationText" tabindex="0">{{ translate(explanation.reason) }}</div>
      <div class="errorLabel nextStep">{{ translate('可以怎么做') }}</div>
      <div class="explanationText" tabindex="0">{{ translate(explanation.action) }}</div>
      <div v-if="explanation.billing" class="explanationHint">{{ translate(explanation.billing) }}</div>
      <div v-if="explanation.requestId" class="explanationHint">{{ translate('任务编号') }}：{{ explanation.requestId }}</div>
    </details>
  </div>
</template>

<script setup lang="ts">
import { translate } from "@miaoimg/i18n/vue";
defineProps<{ message: string; explanation: { reason?: string; action?: string; billing?: string; requestId?: string }; signal: AbortSignal }>();
</script>

<style lang="scss">
.nodeErrorMessage {
  width: max-content;
  max-width: min(520px, calc(100vw - 32px));

  .el-message__content {
    min-width: 0;
    flex: 1;
  }

  .nodeErrorContent {
    text-align: left;

    .errorLabel {
      margin-bottom: 4px;
      color: var(--el-text-color-secondary);
      font-size: 12px;
    }

    .errorDetail {
      max-height: 12vh;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .nextStep { margin-top: 10px; }

    .explanation {
      margin-top: 4px;
      padding-top: 0;
      border-top: 0;

      summary { width: fit-content; color: inherit; opacity: .75; font-size: 11px; cursor: pointer; }
      &[open] summary { margin-bottom: 8px; }

      .explanationText {
        max-height: 30vh;
        overflow: auto;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }

      .explanationHint {
        margin-top: 8px;
        color: var(--el-text-color-secondary);
        font-size: 12px;
      }
    }
  }
}
</style>
