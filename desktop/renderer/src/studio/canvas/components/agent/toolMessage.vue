<template>
  <component v-if="renderer" :is="renderer" :tool="tool" :directory="directory" @copy="emit('copy', $event)" />
  <el-text v-if="rendererError" type="danger">{{ translate('工具界面加载失败，请停止后重试：') }}{{ rendererError }}</el-text>
  <section v-if="tool.name !== 'askUser' || !renderer" class="toolCall" :class="{ outcomeUnknown: tool.outcomeUnknown }" :data-status="tool.status">
    <button class="toolToggle" type="button" :aria-expanded="!collapsed" @click="collapsed = !collapsed">
      <span class="toolHeader" :data-status="tool.status">
        <component :is="statusIcon" :size="15" class="statusIcon" :class="{ spinning: tool.status === 'running' }" />
        <span class="toolName">{{ toolLabel }}</span>
        <span class="toolState">{{ tool.outcomeUnknown ? translate('结果待确认') : tool.name === 'subAgent' && tool.status === 'success' ? translate('调用已返回') : toolStatusLabels[tool.status] }}</span>
        <icon-chevron-right :size="14" class="detailArrow" :class="{ expanded: !collapsed }" />
      </span>
      <span v-if="toolTarget" class="toolTarget">{{ toolTarget }}</span>
      <span v-if="outcome" class="toolOutcome" :title="outcome">{{ outcome }}</span>
    </button>
    <div v-if="!collapsed && detailLines.length" class="toolDetails">
      <span class="toolLabel">
        {{ translate("执行摘要") }}
        <el-button text size="small" :icon="IconCopy" :aria-label="translate('复制执行摘要')" @click="emit('copy', detailLines.join('\n'))" />
      </span>
      <ul class="toolDetailList">
        <li v-for="line in detailLines" :key="line">{{ line }}</li>
      </ul>
    </div>
    <div v-if="childTasks.length" class="childTaskList">
      <button v-for="child in childTasks" :key="child.file" type="button" class="childTaskButton" :data-status="child.status" @click="emit('openChild', child.file)">
        <span>{{ child.name }}</span><strong>{{ translate(childStatusLabels[child.status] || '查看进度') }}</strong>
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { toolActionLabel } from "./toolLabels";
import { computed, onErrorCaptured, ref, shallowRef, watch, type Component } from "vue";
import { loadToolComponent } from "@miaoimg/tools-scaffold/client";
import { IconCopy, IconTool, IconLoader2, IconCheck, IconAlertCircle, IconPlayerStop, IconChevronRight } from "@tabler/icons-vue";
import type { AgentSubAgent, AgentToolCall } from "@miaoimg/server/agent/types";
import { translate } from "@miaoimg/i18n/vue";
const { tool, directory, subAgents } = defineProps<{ tool: AgentToolCall; directory?: string; subAgents?: AgentSubAgent[] }>();
const emit = defineEmits<{ copy: [content: string]; openChild: [file: string] }>();
const renderer = shallowRef<Component>();
const rendererError = ref("");
watch(() => [tool.name, tool.question?.callId] as const, async ([name], _previous, onCleanup) => {
  let active = true;
  onCleanup(() => { active = false; });
  renderer.value = undefined;
  rendererError.value = "";
  if (name === "subAgent") return;
  try {
    const component = await loadToolComponent(name);
    if (active) {
      renderer.value = component;
      if (!component && tool.status === "running" && tool.question?.callId) rendererError.value = translate("该工具未提供可用的交互组件");
    }
  } catch (error) {
    if (active) rendererError.value = error instanceof Error ? error.message : String(error);
  }
}, { immediate: true });
onErrorCaptured(error => {
  if (!renderer.value) return;
  renderer.value = undefined;
  rendererError.value = error.message;
  return false;
});
const collapsed = defineModel<boolean>("collapsed", { default: true });
// 状态标签是界面文案，跟着语言走，所以是 computed。
const toolStatusLabels = computed<Record<string, string>>(() => ({
  running: translate("调用中…"), success: translate("已完成"), error: translate("调用失败"), interrupted: translate("已中断"),
}));
const toolLabel = computed(() => translate(toolActionLabel(tool)));
const statusIcon = computed(() => ({ running: IconLoader2, success: IconCheck, error: IconAlertCircle, interrupted: IconPlayerStop })[tool.status] || IconTool);
function parsed(value: unknown): Record<string, any> {
  if (typeof value === "string") { try { return JSON.parse(value); } catch { return {}; } }
  return value && typeof value === "object" ? value as Record<string, any> : {};
}
const toolTarget = computed(() => {
  const value = parsed(tool.args);
  const target = value.query || value.url || value.source || value.path || value.pattern || value.command || value.label || value.name || value.nodeId || (Array.isArray(value.nodeIds) ? translate("{0} 个节点", { 0: value.nodeIds.length }) : undefined);
  return typeof target === "string" ? target.slice(0, 180) : "";
});
const outcome = computed(() => {
  if (tool.outcomeUnknown) return translate("操作可能已经完成或部分执行，请先核对文件、画布或任务状态。");
  const value = parsed(tool.result);
  if (tool.status === "error") {
    const raw = typeof tool.result === "string" ? tool.result.trim() : "";
    const message = value.message || value.error || (raw && !/^[\[{]/.test(raw) ? raw : "");
    return String(message || translate("操作未完成，展开查看原因")).slice(0, 180);
  }
  if (tool.status !== "success") return "";
  if (tool.name === "importLocalFile") return translate("素材已导入项目，待放入画布");
  let detail = value;
  if (typeof value.summary?.content === "string") detail = parsed(value.summary.content);
  if (Array.isArray(detail.results)) return translate("找到 {0} 项", { 0: detail.results.length }) + (detail.complete === false ? translate(" · 部分范围未搜索") : "");
  return "";
});
const childStatusLabels: Record<string,string> = { inputRequired: '需要你的回答', completed: '已完成', cancelled: '已停止', error: '查看问题', limited: '查看结果', queued: '排队中' };
const childTasks = computed(() => {
  if (!['subAgent','delegate','waitSubAgents','getSubAgents'].includes(tool.name)) return [];
  const tasks = parsed(tool.result).tasks;
  return Array.isArray(tasks) ? tasks.filter((item: any) => typeof item.file === 'string').map((item: any) => ({ file: item.file, name: String(item.name || '子任务'), status: String(subAgents?.find(child => child.file === item.file)?.status || item.status || 'running') })) : [];
});
const detailLines = computed(() => {
  const lines: string[] = [];
  const args = parsed(tool.args);
  const result = parsed(tool.result);
  if (toolTarget.value) lines.push(`${translate("目标")}：${toolTarget.value}`);
  if (Array.isArray(args.nodeIds)) lines.push(`${translate("节点")}：${args.nodeIds.length}${translate(" 个")}`);
  if (Array.isArray(args.nodeIds) && args.nodeIds.length === 0) lines.push(`${translate("节点")}：${translate("已清空选择")}`);
  if (Array.isArray(args.moves)) lines.push(`${translate("移动")}：${args.moves.length}${translate(" 个节点")}`);
  if (Array.isArray(args.renames)) lines.push(`${translate("重命名")}：${args.renames.length}${translate(" 个节点")}`);
  if (Array.isArray(args.connections)) lines.push(`${translate("连线")}：${args.connections.length}${translate(" 条")}`);
  if (Array.isArray(args.tasks)) lines.push(`${translate("子任务")}：${args.tasks.length}${translate(" 个")}`);
  if (tool.status === "success") {
    if (Array.isArray(result.results)) lines.push(`${translate("结果")}：${translate("找到 {0} 项", { 0: result.results.length })}`);
    if (Array.isArray(result.items)) lines.push(`${translate("结果")}：${translate("返回 {0} 项", { 0: result.items.length })}`);
    if (Array.isArray(result.nodes)) lines.push(`${translate("结果")}：${translate("处理 {0} 个节点", { 0: result.nodes.length })}`);
    if (Array.isArray(result.tasks)) lines.push(`${translate("结果")}：${translate("已返回 {0} 个子任务", { 0: result.tasks.length })}`);
    if (Number.isFinite(Number(result.removedEdgeCount))) lines.push(`${translate("连线")}：${translate("移除 {0} 条", { 0: Number(result.removedEdgeCount) })}`);
    if (typeof result.path === "string" && result.path) lines.push(`${translate("文件")}：${result.path}`);
    if (typeof result.canvasId === "string" && result.canvasId) lines.push(`${translate("画布")}：${result.canvasId}`);
    if (typeof result.name === "string" && result.name) lines.push(`${translate("名称")}：${result.name}`);
    if (typeof tool.result === "string" && !Object.keys(result).length && tool.result.trim() && !/^[\[{]/.test(tool.result.trim())) lines.push(tool.result.trim().slice(0, 240));
  }
  if (tool.status === "error" && outcome.value) lines.push(outcome.value);
  if (tool.outcomeUnknown) lines.push(translate("已下发的操作需要重新读取状态确认"));
  return [...new Set(lines)].slice(0, 8);
});
</script>

<style scoped lang="scss">
.toolCall {
  min-width: 0;
  max-width: 100%;
  margin: 0;
  border: 1px solid var(--el-border-color-extra-light);
  border-radius: 10px;
  background: transparent;
  overflow: hidden;
  .toolToggle { display: flex; flex-direction: column; gap: 3px; min-width: 0; width: 100%; box-sizing: border-box; padding: 8px 10px; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; font: inherit; }
  .toolToggle:hover { background: var(--el-fill-color-extra-light); }
  .toolToggle:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: -2px; }
  .toolTarget, .toolOutcome { min-width: 0; padding-left: 21px; font-size: 11px; line-height: 1.5; color: var(--el-text-color-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; box-sizing: border-box; }
  &[data-status="error"] .toolOutcome, &[data-status="interrupted"] .toolOutcome, &.outcomeUnknown .toolOutcome { white-space: normal; overflow-wrap: anywhere; }
  &[data-status="running"] { border-color: var(--el-border-color-light); }
  &[data-status="error"] .toolOutcome, &[data-status="error"] .statusIcon { color: var(--el-color-danger); }
  .statusIcon { flex-shrink: 0; }
  .spinning { animation: toolSpin 1.5s linear infinite; }
  .detailArrow { margin-left: 2px; flex-shrink: 0; transition: transform .15s; &.expanded { transform: rotate(90deg); } }
  @keyframes toolSpin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinning { animation: none; } }

  .toolHeader {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    width: 100%;
    color: var(--el-text-color-primary);

    .toolName {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .toolState {
      flex-shrink: 0;
      margin-left: auto;
      color: var(--el-text-color-secondary);
      font-size: 11px;
    }

    &[data-status="error"] .toolState { color: var(--el-color-danger); }
  }

  .toolDetails {
    padding: 8px 10px 10px;
    border-top: 1px solid var(--el-border-color-extra-light);
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    font-size: 12px;

    .toolLabel {
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: var(--el-text-color-secondary);
    }

    .toolDetailList {
      display: grid;
      gap: 4px;
      margin: 0;
      padding-left: 18px;
      color: var(--el-text-color-primary);
      line-height: 1.5;
      overflow-wrap: anywhere;
    }
  }
}
</style>

<style scoped>
.childTaskList{display:grid;gap:6px;min-width:0;padding:0 10px 10px}.childTaskButton{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0;width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--el-border-color-light);border-radius:8px;background:var(--el-fill-color-blank);color:var(--el-text-color-primary);text-align:left;cursor:pointer}.childTaskButton>span{min-width:0;overflow-wrap:anywhere}.childTaskButton:hover{background:var(--el-fill-color-light)}.childTaskButton:focus-visible{outline:2px solid var(--el-color-primary);outline-offset:2px}.childTaskButton strong{flex-shrink:0;font-size:11px;font-weight:500;white-space:nowrap;color:var(--el-text-color-secondary)}.childTaskButton[data-status="inputRequired"]{border-color:var(--el-color-primary-light-5)}.childTaskButton[data-status="inputRequired"] strong{color:var(--el-color-primary)}
</style>
