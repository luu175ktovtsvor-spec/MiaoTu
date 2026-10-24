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
    <div v-if="!collapsed" class="toolDetails">
      <template v-for="(data, index) in [args, result]" :key="index">
        <template v-if="data">
          <span class="toolLabel">
            {{ index === 0 ? translate("参数") : translate("结果") }}
            <el-button v-if="!data.markdown" text size="small" :icon="IconCopy" :aria-label="index === 0 ? translate('复制工具参数') : translate('复制工具结果')" @click="emit('copy', data.content)" />
          </span>
          <messageMarkdown v-if="data.markdown" class="toolData" :class="{ toolError: index === 1 && tool.status === 'error' }" :content="data.markdown" :codeOptions="toolCodeOptions" />
          <pre v-else class="toolData toolPlain" :class="{ toolError: index === 1 && tool.status === 'error' }" tabindex="0" :aria-label="index === 0 ? translate('工具参数') : translate('工具结果')">{{ data.content }}</pre>
        </template>
      </template>
    </div>
    <div v-if="childTasks.length" class="childTaskList">
      <button v-for="child in childTasks" :key="child.file" type="button" class="childTaskButton" :data-status="child.status" @click="emit('openChild', child.file)">
        <span>{{ child.name }}</span><strong>{{ translate(childStatusLabels[child.status] || '查看进度') }}</strong>
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { canvasOperations } from "../../toolRuntimeCompat";
import { computed, defineAsyncComponent, onErrorCaptured, ref, shallowRef, watch, type Component } from "vue";
import { loadToolComponent } from "@miaoimg/tools-scaffold/client";
import { IconCopy, IconTool, IconLoader2, IconCheck, IconAlertCircle, IconPlayerStop, IconChevronRight } from "@tabler/icons-vue";
import type { AgentSubAgent, AgentToolCall } from "@miaoimg/server/agent/types";
import { translate } from "@miaoimg/i18n/vue";
const messageMarkdown = defineAsyncComponent(() => import("../messageMarkdown.vue"));

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
const toolLabels: Record<string, string> = {
  webSearch: "搜索网页", webFetch: "读取网页", browser: "操作浏览器", read: "读取本地文件", write: "写入本地文件", edit: "修改本地文件",
  ls: "查看文件夹", find: "查找文件", grep: "搜索文件内容", bash: "在电脑上运行命令", powershell: "在电脑上运行命令",
  importLocalFile: "导入本地素材", exportWorkspaceFile: "导出工作区文件", localToolInfo: "检查电脑上的软件",
  listSkills: "查看可用技能", readSkill: "读取创作方法", getCanvas: "查看画布", getCanvasNodes: "查看画布节点", getAppState: "查看工作区",
  nodeTools: "操作画布节点", getNodeTools: "查看节点能力", addNode: "添加节点", deleteNodes: "删除节点", moveNodes: "移动节点", renameNodes: "重命名节点",
  addCanvas: "新建画布", switchCanvas: "切换画布", renameCanvas: "重命名画布", findCanvasNodes: "查找画布节点", getCanvasEdges: "查看画布连线",
  connectNodes: "连接节点", deleteEdges: "删除连线", selectNodes: "选中节点", arrangeCanvas: "整理画布", fitCanvas: "适应视图",
  editDocument: "修改文档", readDocument: "读取文档", openDocument: "打开文档", getDocument: "读取文档", writeDocument: "修改文档",
  inspectVideo: "查看视频画面", inspectReference: "查看参考素材", probeMedia: "读取媒体信息", ffmpeg: "处理媒体", ffprobe: "读取媒体信息",
  messageSubAgent: "补充子任务", waitSubAgents: "等待子任务", stopSubAgent: "停止子任务", getSubAgents: "查看子任务", delegate: "委派团队成员", teamResources: "读取团队资料", askUser: "提问", report: "上报进展", subAgent: "执行子任务", listWorkspaceFiles: "查看工作区文件", readWorkspaceFile: "读取工作区文件", writeWorkspaceFile: "写入工作区文件", searchInspirationLibrary: "检索案例",
};
Object.assign(toolLabels, Object.fromEntries(canvasOperations.map(tool => [tool.name, tool.label])));
const nodeActions: Record<string, string> = { "node:setText": "写入文本", "node:getConfig": "读取节点配置", "node:setConfig": "更新节点配置", "node:processVideo": "剪辑视频", "node:processAudio": "处理音频", "node:splitImageGrid": "图片宫格切分", "node:editImageMarks": "编辑图片标记", "node:saveOutputAsAsset": "保存素材", "node:prepareImageVariation": "创建图片编辑节点" };
Object.assign(nodeActions, { 'node:setDirectorEditor': '打开或关闭导演台', 'node:addDirectorMannequin': '添加关节人偶', 'node:setDirectorOptions': '设置导演台环境', 'node:selectDirectorPlan': '切换动画方案', 'node:editDirectorAnchors': '编辑镜头关键帧', 'node:exportDirectorImage': '导出关键帧图片', 'node:controlDirectorView': '操作导演台预览', 'node:editDirector': '修改导演场景与动画', 'node:readDirector': '读取导演台' });
const toolLabel = computed(() => translate((tool.name === "nodeTools" && nodeActions[parsed(tool.args).name]) || toolLabels[tool.name] || "操作工具"));
Object.assign(nodeActions, { 'node:focusNode': '聚焦节点', 'node:setImagePreview': '查看图片大图', 'node:setTextEditor': '打开或关闭文本编辑器' });
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
  if (tool.status === "error") return String(value.message || value.error || (typeof tool.result === "string" ? tool.result : translate("操作未完成，展开查看原因"))).slice(0, 180);
  if (tool.status !== "success") return "";
  if (tool.name === "importLocalFile") return translate("素材已导入项目，待放入画布");
  let detail = value;
  if (typeof value.summary?.content === "string") detail = parsed(value.summary.content);
  if (Array.isArray(detail.results)) return translate("找到 {0} 项", { 0: detail.results.length }) + (detail.complete === false ? translate(" · 部分范围未搜索") : "");
  return "";
});
const toolCodeOptions = { maxHeight: 240, lineNumbers: false };
const childStatusLabels: Record<string,string> = { inputRequired: '需要你的回答', completed: '已完成', cancelled: '已停止', error: '查看问题', limited: '查看结果', queued: '排队中' };
const childTasks = computed(() => {
  if (!['subAgent','delegate','waitSubAgents','getSubAgents'].includes(tool.name)) return [];
  const tasks = parsed(tool.result).tasks;
  return Array.isArray(tasks) ? tasks.filter((item: any) => typeof item.file === 'string').map((item: any) => ({ file: item.file, name: String(item.name || '子任务'), status: String(subAgents?.find(child => child.file === item.file)?.status || item.status || 'running') })) : [];
});
const args = computed(() => formatToolData(tool.args));
const result = computed(() => formatToolData(tool.result));

function formatToolData(value: unknown) {
  if (value === undefined) return;
  try {
    const content = JSON.stringify(typeof value === "string" ? JSON.parse(value) : value, null, 2) ?? "";
    // ACT: 超过 16K 字符只渲染完整文本，限制高亮与 token DOM 开销；更大数据量可改为虚拟行。
    return { content, markdown: content.length <= 16_384 ? `~~~json\n${content}\n~~~` : undefined };
  } catch {
    return { content: String(value), markdown: undefined };
  }
}
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

    .toolData {
      margin: 0 0 6px;
      font-size: 12px;
      line-height: 1.5;

      :deep([data-stream-markdown="code-block"]) {
        margin: 0;
      }

      :deep([data-stream-markdown="code-block-content"]) {
        overscroll-behavior: contain;
        pre {
          white-space: pre;
          overflow-wrap: normal;
        }
      }

      &.toolError :deep([data-stream-markdown="code-block"]) { border-color: var(--el-color-danger-light-5); }

      &.toolPlain {
        min-width: 0;
        max-width: 100%;
        max-height: 240px;
        padding: 12px;
        overflow: auto;
        overscroll-behavior: contain;
        white-space: pre;
        overflow-wrap: normal;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        color: var(--el-text-color-primary);
        background: var(--el-fill-color-light);
        border: 1px solid var(--el-border-color-lighter);
        border-radius: var(--ui-radius);

        &.toolError { border-color: var(--el-color-danger-light-5); }
      }
    }
  }
}
</style>

<style scoped>
.childTaskList{display:grid;gap:6px;min-width:0;padding:0 10px 10px}.childTaskButton{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0;width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--el-border-color-light);border-radius:8px;background:var(--el-fill-color-blank);color:var(--el-text-color-primary);text-align:left;cursor:pointer}.childTaskButton>span{min-width:0;overflow-wrap:anywhere}.childTaskButton:hover{background:var(--el-fill-color-light)}.childTaskButton:focus-visible{outline:2px solid var(--el-color-primary);outline-offset:2px}.childTaskButton strong{flex-shrink:0;font-size:11px;font-weight:500;white-space:nowrap;color:var(--el-text-color-secondary)}.childTaskButton[data-status="inputRequired"]{border-color:var(--el-color-primary-light-5)}.childTaskButton[data-status="inputRequired"] strong{color:var(--el-color-primary)}
</style>
