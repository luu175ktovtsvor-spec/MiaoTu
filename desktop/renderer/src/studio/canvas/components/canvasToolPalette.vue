<template>
  <el-dialog v-model="visible" class="canvasToolPaletteDialog" :title="translate('全部功能')" width="min(960px, calc(100vw - 32px))" align-center append-to-body destroy-on-close @opened="searchInput?.focus()" @closed="closed">
    <div class="functionPalette nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @wheel.stop @keydown.stop @keydown.esc.stop.prevent="cancel">
      <div class="paletteSearch">
        <el-button v-if="picking" text @click="picking = undefined; query = ''">{{ translate('返回') }}</el-button>
        <el-input ref="searchInput" v-model="query" clearable :prefix-icon="IconSearch" :placeholder="translate(picking ? '搜索画布节点' : '搜索功能')" :aria-label="translate(picking ? '搜索画布节点' : '搜索功能')" />
      </div>
      <div v-if="picking" class="resourcePicker">
        <h3>{{ translate('选择资源') }} · {{ translate(picking.label) }}</h3>
        <div class="paletteGrid">
          <button v-for="node in matchingSources" :key="node.id" class="paletteTool sourceChoice" type="button" @click="chooseSource(node, picking)">
            <span class="toolIcon"><component :is="picking.icon" :size="20" /></span>
            <span>{{ nodeLabel(node) }}</span>
          </button>
        </div>
        <p v-if="!matchingSources.length" class="emptyPalette">{{ translate('无可用资源') }}</p>
      </div>
      <div v-else v-loading="loading" class="paletteGroups" :aria-busy="loading">
        <section v-if="recentTools.length && !query.trim()">
          <h3>{{ translate('最近使用') }}</h3>
          <div class="paletteGrid"><button v-for="tool in recentTools" :key="tool.id" class="paletteTool" type="button" :disabled="!sources(tool).length" @click="chooseTool(tool)"><span class="toolIcon"><component :is="tool.icon" :size="20" /></span><span>{{ translate(tool.label) }}</span></button></div>
        </section>
        <section v-for="group in groups" :key="group.label">
          <h3>{{ translate(group.label) }}</h3>
          <div class="paletteGrid">
            <button v-for="tool in group.tools" :key="tool.id" class="paletteTool" type="button" :disabled="!sources(tool).length" :title="sources(tool).length ? translate(tool.label) : translate('无可用资源')" @click="chooseTool(tool)">
              <span class="toolIcon"><component :is="tool.icon" :size="20" /></span>
              <span>{{ translate(tool.label) }}<small v-if="!sources(tool).length">{{ translate('无可用资源') }}</small></span>
            </button>
          </div>
        </section>
        <section v-if="canCreateDirector && directorMatches"><h3>{{ translate(directorTool.group) }}</h3><div class="paletteGrid"><button class="paletteTool" type="button" @click="chooseDirector"><span class="toolIcon"><component :is="directorTool.icon" :size="20" /></span><span>{{ translate(directorTool.label) }}</span></button></div></section>
        <p v-if="!loading && !groups.length && !(canCreateDirector && directorMatches)" class="emptyPalette">{{ translate('未找到匹配功能') }}</p>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from "vue";
import { useVueFlow, type GraphNode } from "@vue-flow/core";
import { ElButton, ElDialog, ElInput, ElLoading } from "element-plus";
import { IconSearch } from "@tabler/icons-vue";
import { translate } from "@miaoimg/i18n/vue";
import { canvasTools, directorTool, type CanvasTool } from "../canvasToolCatalogue";
import { useCanvasToolRegistry } from "../canvasToolRegistry";
import { showNodeError } from "../scaffold/showNodeError";

const { canCreateDirector = false } = defineProps<{ canCreateDirector?: boolean }>();
const vLoading = ElLoading.directive;
const emit = defineEmits<{ director: [] }>();
const registry = useCanvasToolRegistry();
const flow = useVueFlow();
const visible = ref(false), loading = ref(false), executing = ref(false), query = ref("");
const searchInput = ref<InstanceType<typeof ElInput>>();
const picking = shallowRef<CanvasTool>();
const queued = shallowRef<{ scope: string; tool?: CanvasTool; node?: GraphNode; director?: boolean }>();
let openingRequest = 0;
const term = computed(() => query.value.trim().toLocaleLowerCase());
const permittedTools = computed(() => canvasTools.filter(tool => !tool.capability || tool.capability(registry?.models.value ?? [])));
const matches = (tool: { label: string; group: string }) => !term.value || `${translate(tool.label)} ${translate(tool.group)} ${tool.label}`.toLocaleLowerCase().includes(term.value);
const groups = computed(() => [...new Set(permittedTools.value.map(tool => tool.group))].map(label => ({ label, tools: permittedTools.value.filter(tool => tool.group === label && matches(tool)) })).filter(group => group.tools.length));
const recentTools = computed(() => (registry?.recent.value ?? []).flatMap(id => permittedTools.value.filter(tool => tool.id === id)));
const directorMatches = computed(() => matches(directorTool));
const candidateMap = computed(() => new Map(permittedTools.value.map(tool => [tool.id, registry?.candidates(tool.id) ?? []])));
const sources = (tool: CanvasTool) => candidateMap.value.get(tool.id) ?? [];
const nodeLabel = (node: GraphNode) => String(node.data.label || translate("未命名节点"));
const matchingSources = computed(() => picking.value ? sources(picking.value).filter(node => !term.value || nodeLabel(node).toLocaleLowerCase().includes(term.value)) : []);

async function open() {
  if (!registry || !registry.active() || !registry.scope() || executing.value) return;
  const request = ++openingRequest;
  const scope = registry.scope();
  query.value = ""; picking.value = undefined; queued.value = undefined; visible.value = true; loading.value = true;
  try { await registry.refresh(); }
  catch (error) { if (request === openingRequest && visible.value && registry.scope() === scope && registry.active()) showNodeError(error, translate("模型读取失败")); }
  finally { if (request === openingRequest) loading.value = false; }
}
function chooseTool(tool: CanvasTool) {
  const candidates = sources(tool);
  const selected = candidates.filter(node => node.selected);
  if (selected.length === 1) return chooseSource(selected[0]!, tool);
  picking.value = tool; query.value = "";
  void nextTick(() => searchInput.value?.focus());
}
function chooseSource(node: GraphNode, tool: CanvasTool) {
  if (!registry?.available(node, tool.id)) return;
  queued.value = { scope: registry.scope(), node, tool }; visible.value = false;
}
function chooseDirector() {
  if (!registry || !canCreateDirector) return;
  queued.value = { scope: registry.scope(), director: true }; visible.value = false;
}
function cancel() { openingRequest++; queued.value = undefined; visible.value = false; loading.value = false; }
async function closed() {
  const task = queued.value; queued.value = undefined; picking.value = undefined; query.value = "";
  if (!task || !registry?.active() || registry.scope() !== task.scope) return;
  if (task.director) { if (canCreateDirector) emit("director"); return; }
  if (!task.node || !task.tool) return;
  executing.value = true;
  try {
    if (await registry.run(task.node, task.tool.id) && registry.active() && registry.scope() === task.scope)
      registry.remember(task.tool.id);
  }
  catch (error) {
    if (registry.active() && registry.scope() === task.scope && flow.findNode(task.node.id) === task.node)
      showNodeError(error, translate("功能暂不可用，请重新选择"));
  }
  finally { executing.value = false; }
}
watch(() => registry && [registry.scope(), registry.active()], (value, previous) => {
  // A choice remains queued while the dialog closes. Invalidate it even when
  // already hidden, including a same-tick A → empty → B → empty → A switch.
  if (!registry?.active() || !registry.scope() || value?.[0] !== previous?.[0]) cancel();
}, { flush: "sync" });
defineExpose({ open, busy: executing });
</script>

<style scoped lang="scss">
.functionPalette { max-height: min(70vh, 720px); overflow-y: auto; padding: 0 6px 10px; }
.paletteSearch { display: flex; gap: 10px; padding: 0 0 20px; position: sticky; top: 0; z-index: 1; background: var(--el-dialog-bg-color, var(--el-bg-color)); }
.paletteGroups section + section { margin-top: 26px; }
h3 { margin: 0 0 12px; font-size: 12px; font-weight: 500; color: var(--el-text-color-secondary); }
.paletteGrid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 8px 18px; }
.paletteTool { display: flex; align-items: center; gap: 12px; width: 100%; min-width: 0; min-height: 58px; padding: 7px; border: 1px solid transparent; border-radius: 9px; background: transparent; color: var(--el-text-color-primary); text-align: left; cursor: pointer; font: inherit; font-size: 12px; }
.paletteTool:hover:not(:disabled) { background: var(--el-fill-color-light); border-color: var(--el-border-color-light); }
.paletteTool:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 1px; }
.paletteTool:disabled { cursor: default; opacity: .5; }
.toolIcon { display: grid; place-items: center; flex-shrink: 0; width: 38px; height: 38px; border-radius: 10px; background: var(--el-fill-color); }
.paletteTool > span:last-child { overflow-wrap: anywhere; }
.paletteTool small { display: block; margin-top: 4px; color: var(--el-text-color-secondary); font-size: 10px; }
.sourceChoice { border-color: var(--el-border-color-lighter); }
.emptyPalette { padding: 28px; text-align: center; color: var(--el-text-color-secondary); }
@media(max-width:700px) { .paletteGrid { grid-template-columns: repeat(2,minmax(0,1fr)); gap: 6px; } }
@media(max-width:420px) { .paletteGrid { grid-template-columns: 1fr; } }
</style>
