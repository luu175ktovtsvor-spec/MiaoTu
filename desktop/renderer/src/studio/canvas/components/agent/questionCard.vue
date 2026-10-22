<template>
  <el-card class="questionCard" shadow="never">
    <div class="questionHeader">
      <icon-message-question :size="18" aria-hidden="true" />
      <span class="questionTitle">{{ title }}</span>
      <el-tag size="small" :type="answer && !skipped ? 'success' : 'info'">{{ statusText }}</el-tag>
    </div>
    <p v-if="question" class="questionText">{{ question }}</p>
    <p v-if="tool.status === 'error'" class="submitError">{{ tool.result || translate('提问未完成，可以在输入框里继续。') }}</p>
    <template v-if="waiting">
      <template v-if="fields.length">
        <div v-for="field in fields" :key="field.id" class="field">
          <div class="fieldLabel">{{ field.label }}<span v-if="field.required" class="required"> *</span></div>
          <el-input v-if="field.type === 'input'" :model-value="textValue(field.id)" @update:model-value="values[field.id] = $event" :aria-label="field.label" :placeholder="field.placeholder" :disabled="submitting" />
          <el-input v-else-if="field.type === 'textarea'" :model-value="textValue(field.id)" @update:model-value="values[field.id] = $event" :aria-label="field.label" type="textarea" :autosize="{ minRows: 2, maxRows: 6 }" :placeholder="field.placeholder" :disabled="submitting" />
          <el-select v-else-if="field.type === 'select'" :model-value="textValue(field.id)" @update:model-value="values[field.id] = $event" :aria-label="field.label" :placeholder="field.placeholder" :disabled="submitting" clearable>
            <el-option v-for="option in field.options" :key="option" :label="option" :value="option" />
          </el-select>
          <el-radio-group v-else-if="field.type === 'radio'" :model-value="textValue(field.id)" @update:model-value="values[field.id] = $event" :aria-label="field.label" :disabled="submitting">
            <el-radio v-for="option in field.options" :key="option" :value="option">{{ option }}</el-radio>
          </el-radio-group>
          <el-checkbox-group v-else-if="field.type === 'checkbox'" :model-value="arrayValue(field.id)" @update:model-value="values[field.id] = $event" :aria-label="field.label" :disabled="submitting">
            <el-checkbox v-for="option in field.options" :key="option" :value="option">{{ option }}</el-checkbox>
          </el-checkbox-group>
          <el-switch v-else-if="field.type === 'switch'" :model-value="booleanValue(field.id)" @update:model-value="values[field.id] = $event" :aria-label="field.label" :disabled="submitting" />
          <el-input-number v-else-if="field.type === 'inputNumber'" :model-value="numberValue(field.id)" @update:model-value="values[field.id] = $event" :aria-label="field.label" :disabled="submitting" />
          <el-input v-else :model-value="textValue(field.id)" @update:model-value="values[field.id] = $event" :aria-label="field.label" :disabled="submitting" />
        </div>
      </template>
      <template v-else>
        <el-radio-group v-if="options.length" v-model="selected" class="questionOptions" :disabled="submitting" :aria-label="question || title">
          <el-radio v-for="option in options" :key="option" :value="option" border>{{ option }}</el-radio>
          <el-radio value="" border>{{ translate('自行填写') }}</el-radio>
        </el-radio-group>
        <el-input
          v-model="text"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 6 }"
          :disabled="submitting"
          :placeholder="options.length ? translate('也可以直接回答或补充说明') : translate('输入你的回答')"
          :aria-label="translate('回答问题')" />
      </template>
      <div class="questionActions">
        <el-button type="primary" :loading="submitting" :disabled="!directory || submitting || !canSubmit" @click="submitAnswer(false)">{{ translate('提交回答') }}</el-button>
        <el-button :disabled="!directory || submitting" @click="submitAnswer(true)">{{ translate('跳过') }}</el-button>
      </div>
      <p class="questionHint">{{ translate('也可以直接在下方输入框回答或补充，当前任务会继续。') }}</p>
      <p v-if="submitError" class="submitError" role="alert">{{ submitError }}</p>
    </template>
    <p v-else-if="answer" class="answerText">{{ answer }}</p>
  </el-card>
</template>

<script setup lang="ts">
import { translate } from "@miaoimg/i18n/vue";
import { computed, inject, reactive, ref, watch } from "vue";
import { assertWorkspaceScope, captureWorkspaceScope, workspaceHeaders } from "@/lib/workspaceRemote";
import type { AgentAnswerValue } from "../../agentTypes";
import { cloneQuestionDraft, questionDraftsKey } from "./questionDraft";
import { ElButton, ElCard, ElCheckbox, ElCheckboxGroup, ElInput, ElInputNumber, ElOption, ElRadio, ElRadioGroup, ElSelect, ElSwitch, ElTag } from "element-plus";
import { IconMessageQuestion } from "@tabler/icons-vue";

type QuestionField = { id: string; label: string; type: string; options: string[]; placeholder?: string; required?: boolean };
type ToolLike = {
  id?: string;
  name?: string;
  status?: string;
  args?: Record<string, unknown>;
  result?: string;
  question?: { callId?: string; title?: string; question?: string; options?: string[]; fields?: Record<string, unknown>[] };
};

const props = defineProps<{ tool: ToolLike; directory?: string }>();
const questionDrafts = inject(questionDraftsKey, undefined);
const answerScope = captureWorkspaceScope();

const title = computed(() => String(props.tool.question?.title || props.tool.args?.title || translate("请确认")));
const question = computed(() => String(props.tool.question?.question ?? props.tool.args?.question ?? ""));
const options = computed(() => {
  const values = props.tool.question?.options ?? props.tool.args?.options;
  return Array.isArray(values) ? [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0))] : [];
});
const fields = computed<QuestionField[]>(() => {
  const raw = props.tool.question?.fields ?? props.tool.args?.fields;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const field = item as Record<string, unknown>;
    return {
      id: String(field.id ?? field.field ?? ""),
      label: String(field.label ?? field.title ?? field.id ?? ""),
      type: String(field.type ?? "input"),
      options: Array.isArray(field.options) ? field.options.map(String) : [],
      placeholder: typeof field.placeholder === "string" ? field.placeholder : undefined,
      required: Boolean(field.required),
    };
  }).filter(field => field.id);
});

const selected = ref("");
const text = ref("");
const submitting = ref(false);
// Undefined means no receipt yet; an acknowledged answer may be empty.
const submittedAnswer = ref<string>();
const submittedSkipped = ref(false);
const submitError = ref("");
const values = reactive<Record<string, AgentAnswerValue>>({});
let boundCallId: string | undefined;
let boundToolId: string | undefined;
let restoringDraft = false;
const textValue = (id: string) => typeof values[id] === "string" || typeof values[id] === "number" ? values[id] as string | number : "";
const arrayValue = (id: string) => Array.isArray(values[id]) ? values[id] as (string | number)[] : [];
const booleanValue = (id: string) => values[id] === true;
const numberValue = (id: string) => typeof values[id] === "number" ? values[id] as number : undefined;
watch(fields, (list) => {
  for (const field of list) {
    if (!(field.id in values)) values[field.id] = field.type === "checkbox" ? [] : field.type === "switch" ? false : "";
  }
}, { immediate: true, flush: "sync" });
watch([() => props.tool.question?.callId, () => props.tool.status], ([callId, status]) => {
  if (status && status !== "running") {
    if (questionDrafts) {
      if (callId) delete questionDrafts[callId];
      else if (boundCallId && boundToolId === props.tool.id) delete questionDrafts[boundCallId];
    }
    boundCallId = undefined;
    boundToolId = undefined;
    return;
  }
  if (status !== "running" || !callId || callId === boundCallId) return;
  restoringDraft = true;
  try {
    boundCallId = callId;
    boundToolId = props.tool.id;
    const draft = questionDrafts?.[callId];
    selected.value = draft?.selected ?? "";
    text.value = draft?.text ?? "";
    for (const id of Object.keys(values)) delete values[id];
    if (draft) Object.assign(values, cloneQuestionDraft(draft).values);
    for (const field of fields.value) {
      if (!(field.id in values)) values[field.id] = field.type === "checkbox" ? [] : field.type === "switch" ? false : "";
    }
    submittedAnswer.value = undefined;
    submittedSkipped.value = false;
    submitting.value = false;
    submitError.value = "";
  } finally { restoringDraft = false; }
}, { immediate: true });

const toolResult = computed(() => {
  if (props.tool.status !== "success" || !props.tool.result) return undefined;
  try { return JSON.parse(props.tool.result) as { answer?: unknown; values?: unknown; skipped?: boolean }; } catch { return undefined; }
});
const skipped = computed(() => submittedSkipped.value || toolResult.value?.skipped === true);
const answer = computed(() => {
  if (skipped.value) return "";
  if (submittedAnswer.value !== undefined) return submittedAnswer.value;
  if (props.tool.status !== "success") return "";
  if (typeof toolResult.value?.answer === "string") return toolResult.value.answer;
  if (toolResult.value?.values) return formatAnswers(toolResult.value.values);
  return props.tool.result ?? "";
});
const waiting = computed(() => props.tool.status === "running" && !!props.tool.question?.callId && submittedAnswer.value === undefined && !skipped.value);
watch([selected, text, values], () => {
  if (!questionDrafts || restoringDraft || !waiting.value || !boundCallId || boundCallId !== props.tool.question?.callId) return;
  questionDrafts[boundCallId] = cloneQuestionDraft({ selected: selected.value, text: text.value, values, toolId: props.tool.id });
}, { deep: true, flush: "sync" });
const draftAnswer = computed(() => [selected.value, text.value.trim()].filter(Boolean).join("\n"));
const statusText = computed(() => {
  if (props.tool.status === "error") return translate("未完成");
  if (skipped.value) return translate("已跳过");
  if (submittedAnswer.value !== undefined || props.tool.status === "success") return translate("已回答");
  if (props.tool.status === "interrupted") return translate("已停止");
  return waiting.value ? translate("等待回答") : translate("提问记录");
});
const canSubmit = computed(() => {
  if (!fields.value.length) return draftAnswer.value.length > 0;
  return fields.value.every((field) => {
    if (!field.required) return true;
    const value = values[field.id];
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "boolean") return true;
    return value !== undefined && value !== null && String(value).trim().length > 0;
  });
});

function formatAnswers(value: unknown) {
  if (!value || typeof value !== 'object') return '';
  return Object.entries(value).map(([id, answer]) => {
    const label = fields.value.find(field => field.id === id)?.label || id;
    const text = Array.isArray(answer) ? answer.join('、') : typeof answer === 'boolean' ? translate(answer ? '是' : '否') : String(answer ?? '');
    return text ? `${label}：${text}` : '';
  }).filter(Boolean).join('\n');
}

async function submitAnswer(skip: boolean) {
  const callId = props.tool.question?.callId;
  if (!waiting.value || submitting.value || !props.directory || !callId) return;
  if (!skip && !canSubmit.value) return;
  submitting.value = true;
  submitError.value = "";
  try {
    assertWorkspaceScope(answerScope);
    const response = await fetch(callId.startsWith("q:") ? "/api/agent/native/answer" : "/api/agent/answer", {
      method: "POST",
      headers: { ...workspaceHeaders(answerScope.owner), "x-miaoimg-workspace": "1" },
      body: JSON.stringify({
        directory: props.directory,
        callId,
        ...(skip ? { skipped: true } : fields.value.length ? { values: { ...values } } : { answer: draftAnswer.value }),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.code !== 200) throw new Error(data.message || translate("提交回答失败"));
    if (boundCallId === callId) {
      submittedAnswer.value = String(data.data?.answer || (data.data?.values ? formatAnswers(data.data.values) : ""));
      submittedSkipped.value = data.data?.skipped === true;
    }
    if (questionDrafts) delete questionDrafts[callId];
  } catch (error) {
    if (boundCallId === callId) submitError.value = error instanceof Error ? error.message : "提交回答失败";
  } finally {
    if (boundCallId === callId) submitting.value = false;
  }
}
</script>

<style scoped>
.questionCard { min-width: 0; max-width: 100%; margin: 0; border-radius: 14px; border-color: var(--el-border-color-light); background: var(--el-fill-color-extra-light); box-shadow: none; }
.questionCard :deep(.el-card__body) { padding: 16px; }
.questionHeader { display: flex; align-items: center; gap: 8px; min-width: 0; }
.questionHeader > svg { flex-shrink: 0; color: var(--el-text-color-secondary); }
.questionTitle { min-width: 0; overflow-wrap: anywhere; }
.questionHeader :deep(.el-tag) { margin-left: auto; flex-shrink: 0; }
.questionText, .answerText, .errorText { margin: 12px 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 1.75; }
.questionOptions { display: flex; flex-direction: column; align-items: stretch; gap: 8px; width: 100%; margin-bottom: 12px; }
.questionOptions :deep(.el-radio) { width: 100%; height: auto; margin: 0; padding: 8px 12px; }
.questionCard :deep(.el-radio__label), .questionCard :deep(.el-checkbox__label) { min-width: 0; white-space: normal; overflow-wrap: anywhere; line-height: 1.6; }
.questionCard :deep(.el-radio), .questionCard :deep(.el-checkbox) { max-width: 100%; height: auto; min-height: 28px; }
.questionCard :deep(.el-radio__input), .questionCard :deep(.el-checkbox__input) { flex-shrink: 0; }
.field { min-width: 0; margin-bottom: 14px; }
.fieldLabel { margin-bottom: 6px; overflow-wrap: anywhere; font-size: 13px; line-height: 1.6; }
.field :deep(.el-select), .field :deep(.el-input-number) { max-width: 100%; }
.required { color: var(--el-color-danger); }
.questionActions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.questionActions :deep(.el-button + .el-button) { margin-left: 0; }
.questionHint { margin: 12px 0 0; overflow-wrap: anywhere; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; }
.submitError { margin: 10px 0 0; overflow-wrap: anywhere; color: var(--el-color-danger); font-size: 12px; line-height: 1.6; }
</style>
