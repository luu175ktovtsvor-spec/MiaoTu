<template>
  <div class="groupActions nodrag nopan" @pointerdown.stop @mousedown.stop @dblclick.stop>
    <el-tooltip :showArrow="false" :content="translate('整组生成')" placement="top" :hideAfter="0">
      <button type="button" class="groupAction" :disabled="busy" :aria-label="translate('整组生成')" @click.stop="runAll">
        <icon-loader-2 v-if="running" :size="14" class="spin" aria-hidden="true" />
        <icon-player-play v-else :size="14" aria-hidden="true" />
      </button>
    </el-tooltip>
    <el-tooltip :showArrow="false" :content="translate('批量下载')" placement="top" :hideAfter="0">
      <button type="button" class="groupAction" :disabled="busy" :aria-label="translate('批量下载')" @click.stop="downloadAll">
        <icon-loader-2 v-if="downloading" :size="14" class="spin" aria-hidden="true" />
        <icon-download v-else :size="14" aria-hidden="true" />
      </button>
    </el-tooltip>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useVueFlow, type GraphNode } from "@vue-flow/core";
import { ElMessage, ElMessageBox, ElTooltip } from "element-plus";
import { IconDownload, IconLoader2, IconPlayerPlay } from "@tabler/icons-vue";
import { zipSync } from "fflate";
import { translate } from "@miaoimg/i18n/vue";
import saveFile from "@/lib/saveFile";
import { useNodeToolsContext } from "../scaffold/nodeTools";
import { useNodeFiles } from "../scaffold/workspaceFiles";

const props = defineProps<{ groupId: string; label: string }>();
const flow = useVueFlow();
const getNodeTools = useNodeToolsContext();
const files = useNodeFiles();
const running = ref(false);
const downloading = ref(false);
const busy = computed(() => running.value || downloading.value);
const generateTools = ["node:generateImage", "node:generateVideo"];

// 组内全部节点（含嵌套分组里的），按画布从上到下、从左到右的阅读顺序。
function members() {
  const ids = new Set([props.groupId]);
  const result: GraphNode[] = [];
  for (let added = true; added;) {
    added = false;
    for (const node of flow.getNodes.value) {
      if (!ids.has(node.id) && node.parentNode && ids.has(node.parentNode)) {
        ids.add(node.id);
        result.push(node);
        added = true;
      }
    }
  }
  return result.sort((a, b) => a.computedPosition.y - b.computedPosition.y || a.computedPosition.x - b.computedPosition.x);
}

// 先逐个读取当前参数的报价，汇总后由用户确认，再依次启动；每个节点仍走自己的取回与防重复下单逻辑。
async function runAll() {
  if (busy.value) return;
  const tools = getNodeTools();
  const targets = [...tools.list(members().map(node => node.id), generateTools)];
  if (!targets.length) return void ElMessage.info(translate("分组里没有可生成的节点"));
  running.value = true;
  try {
    let points = 0;
    let unquoted = 0;
    for (const target of targets) {
      const config = await tools.call({ nodeId: target.nodeId, name: "node:getConfig", args: {} }) as { estimate?: { points?: number } | null } | null;
      if (typeof config?.estimate?.points === "number") points += config.estimate.points;
      else unquoted++;
    }
    const total = Math.round(points * 100) / 100;
    const message = translate("将生成 {0} 个节点，预计共 {1} 积分", { 0: targets.length, 1: total })
      + (unquoted ? translate("（另有 {0} 个节点使用本机额度或暂无报价）", { 0: unquoted }) : "")
      + translate("，以实际结算为准。");
    await ElMessageBox.confirm(message, translate("整组生成"), { confirmButtonText: translate("开始生成"), cancelButtonText: translate("取消") });
    const failures: string[] = [];
    for (const target of targets) {
      try { await tools.call({ nodeId: target.nodeId, name: target.name, args: {} }); }
      catch (error) { failures.push(`${target.nodeLabel}：${error instanceof Error ? error.message : String(error)}`); }
    }
    if (failures.length) ElMessage.error({ message: failures.join("\n"), duration: 6000 });
    else ElMessage.success(translate("已开始生成 {0} 个节点", { 0: targets.length }));
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error(error instanceof Error ? error.message : translate("整组生成失败"));
  } finally {
    running.value = false;
  }
}

function fileName(label: string, url: string, used: Set<string>) {
  const extension = url.split(/[\\/]/).at(-1)?.match(/\.[A-Za-z0-9]+$/)?.[0] ?? "";
  let base = (label || translate("未命名节点")).replace(/[\\/:*?"<>|]/g, "_").trim();
  // 节点名常带原文件扩展名（reference.png），不再重复追加。
  if (extension && base.toLowerCase().endsWith(extension.toLowerCase())) base = base.slice(0, -extension.length);
  let name = `${base}${extension}`;
  for (let index = 2; used.has(name); index++) name = `${base} (${index})${extension}`;
  used.add(name);
  return name;
}

// 组内图片、视频、音频的原始文件打包成「分组名.zip」；文本节点导出为 .txt。
async function downloadAll() {
  if (busy.value) return;
  downloading.value = true;
  try {
    const workspace = files.getWorkspaceFiles();
    const entries: Record<string, Uint8Array> = {};
    const used = new Set<string>();
    for (const node of members()) {
      const label = typeof node.data.label === "string" ? node.data.label : "";
      for (const output of Object.values(node.data.outputs ?? {}) as Array<{ dataType?: string; value?: unknown }>) {
        if (output?.dataType === "STRING" && typeof output.value === "string" && output.value.trim()) {
          entries[fileName(label, "x.txt", used)] = new TextEncoder().encode(output.value);
        } else if (["IMAGE", "VIDEO", "AUDIO"].includes(output?.dataType ?? "")) {
          const url = (output.value as { url?: string } | undefined)?.url;
          if (!url) continue;
          const content = await workspace.read(url);
          entries[fileName(label, url, used)] = new Uint8Array(content instanceof Blob ? await content.arrayBuffer() : content);
        }
      }
    }
    if (!Object.keys(entries).length) return void ElMessage.info(translate("分组里还没有可下载的内容"));
    // 媒体本身已压缩，只打包不再压缩，避免大视频卡住界面。
    const zip = zipSync(entries, { level: 0 });
    await saveFile(new Blob([zip], { type: "application/zip" }), `${(props.label || translate("分组")).replace(/[\\/:*?"<>|]/g, "_")}.zip`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : translate("批量下载失败"));
  } finally {
    downloading.value = false;
  }
}
</script>

<style lang="scss" scoped>
.groupActions {
  position: absolute;
  right: 0;
  bottom: calc(100% + 6px);
  display: flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--el-border-color);
  border-radius: var(--el-border-radius-base);
  background: var(--el-bg-color-overlay);
}

.groupAction {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: var(--el-border-radius-small);
  background: transparent;
  color: var(--el-text-color-regular);
  cursor: pointer;

  &:hover:not(:disabled) { background: var(--el-fill-color); color: var(--el-text-color-primary); }
  &:disabled { cursor: default; opacity: .6; }
}

.spin { animation: groupActionSpin 1s linear infinite; }
@keyframes groupActionSpin { to { transform: rotate(360deg); } }
</style>
