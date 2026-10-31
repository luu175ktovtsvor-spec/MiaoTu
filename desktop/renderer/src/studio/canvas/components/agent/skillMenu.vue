<template>
  <div ref="menuElement" v-click-outside:[clickOutsideExclude]="closeMenu" class="skillMenu" @keydown.capture="handleKeydown">
    <el-popover ref="popover" :visible="visible" :placement="placement" :width="384" :showArrow="false" :persistent="false" popperClass="agentSkillPopover" :popperStyle="{ padding: '6px', maxWidth: 'calc(100vw - 24px)', maxHeight: popupMaxHeight === undefined ? undefined : `${popupMaxHeight}px`, overflow: 'hidden' }" :popperOptions="{ strategy: 'fixed', modifiers: [{ name: 'flip', enabled: false }, { name: 'preventOverflow', options: { padding: 12, altAxis: true, rootBoundary: 'viewport', boundary: [] } }] }">
      <template #reference>
        <el-button class="skillButton" text circle :disabled="disabled" :aria-expanded="visible" :aria-controls="listId" :aria-label="translate('选择技能')" :title="translate('选择技能')" @mousedown.prevent @click="visible ? closeMenu() : buttonVisible = true"><icon-book :size="15" /></el-button>
      </template>
      <div v-if="visible" ref="popupElement" class="skillPopup" @keydown.capture="handleKeydown">
        <el-input v-model="search" class="skillSearch" :placeholder="translate('搜索技能')" :aria-label="translate('搜索技能')" clearable size="small" @keydown.stop />
        <el-scrollbar :maxHeight="`${listMaxHeight}px`">
          <div :id="listId" role="listbox" :aria-label="translate('技能指令')" :aria-busy="loading">
            <div v-if="loading || loadError || !filteredSkills.length" class="skillStatus" :role="loadError ? 'alert' : 'status'">{{ loading ? translate("正在加载技能…") : loadError || (skills.length ? translate("没有匹配的技能") : translate("暂无可用技能")) }}<el-button v-if="loadError && !loading" text type="primary" size="small" @click="loadSkills(true)">{{ translate('重试') }}</el-button></div>
            <button v-for="(skill, index) in filteredSkills" v-else :id="`${listId}-${index}`" :key="skill.id || skill.name" class="skillItem" :class="{ active: index === activeIndex }" type="button" role="option" :aria-selected="index === activeIndex" @mouseenter="activeIndex = index" @mousedown.prevent @click="selectSkill(skill.id || skill.name)">
              <span class="skillName"><icon-book :size="15" />{{ skillLabel(skill) }}<small>{{ translate(skill.local ? '本地技能' : skill.builtin ? '内置技能' : '工作区技能') }}</small></span>
              <span class="skillDescription">{{ skillText(skill) }}</span>
            </button>
          </div>
        </el-scrollbar>
      </div>
    </el-popover>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue";
import axios from "axios";
import { assertWorkspaceScope, captureWorkspaceScope } from "../../../../lib/workspaceRemote";
import { IconBook } from "@tabler/icons-vue";
import { ClickOutside as vClickOutside, type PopoverInstance } from "element-plus";
import { locale, translate } from "@miaoimg/i18n/vue";

const props = defineProps<{ directory?: string; sessionFile?: string; active: boolean; disabled: boolean; query?: string; editor?: HTMLElement }>();
const emit = defineEmits<{ select: [name: string]; dismiss: [] }>();
const listId = useId();
const buttonVisible = ref(false);
const visible = computed(() => props.active && !props.disabled && (buttonVisible.value || props.query !== undefined));
const skills = ref<{ id?: string; name: string; displayName?: string; displayNameEn?: string; description: string; descriptionEn?: string; local?: boolean; builtin?: boolean }[]>([]);
const loading = ref(false);
const loadError = ref("");
const activeIndex = ref(0);
const search = ref("");
const popupElement = ref<HTMLElement>();
const menuElement = ref<HTMLElement>();
const popover = ref<PopoverInstance>();
const placement = ref<"top-start" | "bottom-start">("top-start");
const listMaxHeight = ref(320);
const popupMaxHeight = ref<number>();
const clickOutsideExclude = computed(() => [props.editor, popupElement.value]);
let schedulePopupLayout: (() => void) | undefined;

function updatePopupLayout() {
  const button = menuElement.value?.querySelector("button");
  const popup = popupElement.value;
  if (!visible.value || !button || !popup) return;
  const bounds = button.getBoundingClientRect();
  const viewport = window.visualViewport;
  const viewportTop = viewport?.offsetTop ?? 0;
  const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
  const padding = 12, offset = 12;
  const above = Math.max(0, bounds.top - viewportTop - padding - offset);
  const below = Math.max(0, viewportBottom - bounds.bottom - padding - offset);
  // Choose from the space the user can actually see, including after a short
  // loading/error state grows into a long asynchronously loaded catalog.
  placement.value = above >= below ? "top-start" : "bottom-start";
  const available = placement.value === "top-start" ? above : below;
  const outer = popup.closest(".el-popper");
  const list = popup.querySelector(".el-scrollbar");
  const chrome = outer && list ? Math.max(0, outer.getBoundingClientRect().height - list.getBoundingClientRect().height) : 0;
  popupMaxHeight.value = Math.floor(available);
  listMaxHeight.value = Math.max(0, Math.min(320, Math.floor(available - chrome)));
  // Element Plus exposes the underlying instance through Popover -> Popper.
  // Update only after Vue applies placement and the new scroll height.
  void nextTick(() => { if (visible.value) void popover.value?.popperRef?.popperInstanceRef?.update(); });
}

watch([visible, popupElement, menuElement, () => props.editor], ([open, popup, menu, editor], _previous, onCleanup) => {
  if (!open || !popup || !menu) return;
  let frame = 0, disposed = false;
  const schedule = () => {
    if (disposed || frame) return;
    frame = requestAnimationFrame(() => { frame = 0; if (!disposed) updatePopupLayout(); });
  };
  schedulePopupLayout = schedule;
  const resize = new ResizeObserver(schedule);
  for (const element of [popup, menu, editor?.closest(".messageInput"), menu.closest(".floatingAgent")]) if (element) resize.observe(element);
  // A freely dragged panel changes position without changing its dimensions.
  const movement = new MutationObserver(schedule);
  const panel = menu.closest(".floatingAgent");
  if (panel) movement.observe(panel, { attributes: true, attributeFilter: ["style", "class"] });
  window.addEventListener("resize", schedule);
  window.addEventListener("scroll", schedule, true);
  window.visualViewport?.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("scroll", schedule);
  schedule();
  onCleanup(() => {
    disposed = true;
    cancelAnimationFrame(frame);
    resize.disconnect(); movement.disconnect();
    window.removeEventListener("resize", schedule);
    window.removeEventListener("scroll", schedule, true);
    window.visualViewport?.removeEventListener("resize", schedule);
    window.visualViewport?.removeEventListener("scroll", schedule);
    if (schedulePopupLayout === schedule) schedulePopupLayout = undefined;
  });
}, { flush: "post" });
// 技能标签跟随界面语言：中文界面用 frontmatter 的中文名，其余语言用 displayName_en。
const chineseLabels = computed(() => locale.value.startsWith("zh"));
function skillLabel(skill: { name: string; displayName?: string; displayNameEn?: string }) {
  return (chineseLabels.value ? skill.displayName : skill.displayNameEn) || skill.displayName || skill.name;
}
function skillText(skill: { description: string; descriptionEn?: string }) {
  return (chineseLabels.value ? skill.description : skill.descriptionEn) || skill.description;
}
const filteredSkills = computed(() => {
  const query = (props.query ?? search.value).toLowerCase();
  return skills.value.filter(skill => `skill:${skill.id || skill.name} ${skill.name} ${skill.displayName || ""} ${skill.displayNameEn || ""} ${skill.description} ${skill.descriptionEn || ""}`.toLowerCase().includes(query));
});

watch([filteredSkills, loading, loadError, search], async () => { await nextTick(); schedulePopupLayout?.(); }, { flush: "post" });

function closeMenu() {
  buttonVisible.value = false;
  search.value = "";
  emit("dismiss");
}

function selectSkill(name: string) {
  emit("select", name);
  closeMenu();
}

function handleKeydown(event: KeyboardEvent) {
  if (!visible.value || event.isComposing || event.keyCode === 229) return;
  const inSearch = Boolean((event.target as HTMLElement)?.closest(".skillSearch"));
  if (inSearch && !["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(event.key)) return;
  if (event.key === "Tab" && (event.shiftKey || loading.value || loadError.value || !filteredSkills.value.length)) return closeMenu();
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  if (!["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === "Escape") return closeMenu();
  if (loading.value || loadError.value || !filteredSkills.value.length) return;
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    activeIndex.value = (activeIndex.value + (event.key === "ArrowDown" ? 1 : -1) + filteredSkills.value.length) % filteredSkills.value.length;
  } else selectSkill(filteredSkills.value[activeIndex.value]!.id || filteredSkills.value[activeIndex.value]!.name);
}

watch(filteredSkills, () => { activeIndex.value = 0; });
watch([visible, activeIndex, filteredSkills, loading, loadError], async () => {
  await nextTick();
  const editor = props.editor?.querySelector('[role="textbox"]');
  editor?.setAttribute("aria-haspopup", "listbox");
  editor?.setAttribute("aria-expanded", String(visible.value));
  editor?.setAttribute("aria-controls", listId);
  if (visible.value && !loading.value && !loadError.value && filteredSkills.value.length) {
    const id = `${listId}-${activeIndex.value}`;
    editor?.setAttribute("aria-activedescendant", id);
    document.getElementById(id)?.scrollIntoView({ block: "nearest" });
  } else editor?.removeAttribute("aria-activedescendant");
});

let loadedScope = "";
let loadedAt = 0;
let controller: AbortController | undefined;
let pending: Promise<void> | undefined;
let refreshRevision = 0;

async function loadSkills(force = false) {
  if (!props.directory || !props.active || props.disabled) return;
  const scope = captureWorkspaceScope();
  if (!scope.owner) return;
  const key = JSON.stringify([scope.owner, scope.project, props.directory, props.sessionFile]);
  if (loadedScope !== key) {
    controller?.abort();
    pending = undefined;
    loadedScope = key;
    loadedAt = 0;
    refreshRevision++;
    skills.value = [];
    loadError.value = "";
  }
  if (force) { refreshRevision++; loadedAt = 0; }
  if (pending) return pending;
  if (!force && loadedAt && Date.now() - loadedAt < 30000) return;
  const requestController = new AbortController();
  controller = requestController;
  // 有列表时继续显示，刷新放到后台；关闭菜单不取消刚发出的目录读取。
  loading.value = !skills.value.length;
  loadError.value = "";
  const params = { directory: props.directory, sessionFile: props.sessionFile };
  pending = (async () => {
    try {
      // 开关变化可能发生在旧目录读取期间；合并刷新，但不能复用变更前的结果。
      for (;;) {
        const requestedRevision = refreshRevision;
        try {
          const { data } = await axios.get("/api/agent/skills", {
            params, signal: requestController.signal, timeout: 30_000,
            headers: { "x-miaoimg-workspace": "1" },
          });
          assertWorkspaceScope(scope);
          if (requestController.signal.aborted || loadedScope !== key) return;
          if (requestedRevision !== refreshRevision) continue;
          if (data?.code !== 200 || !Array.isArray(data.data) || data.data.some(skill => !skill || typeof skill.name !== "string" || typeof skill.description !== "string" || (skill.id !== undefined && typeof skill.id !== "string"))) throw new Error("Invalid skill catalog");
          skills.value = data.data;
          loadedAt = Date.now();
          return;
        } catch (error) {
          if (requestController.signal.aborted || loadedScope !== key || axios.isCancel(error)) return;
          if (requestedRevision !== refreshRevision) continue;
          loadError.value = translate("加载技能失败，请重试");
          return;
        }
      }
    } finally {
      if (controller === requestController) {
        loading.value = false;
        controller = undefined;
        pending = undefined;
      }
    }
  })();
  return pending;
}

watch([() => props.directory, () => props.sessionFile, () => props.active, () => props.disabled], () => {
  if (props.active && !props.disabled) void loadSkills();
}, { immediate: true });
watch(visible, open => {
  if (open) void loadSkills(true);
  else closeMenu();
});
const refreshSkills = () => { if (props.active && !props.disabled) void loadSkills(true); };
window.addEventListener("miaoimg:skills-changed", refreshSkills);
onBeforeUnmount(() => {
  controller?.abort();
  window.removeEventListener("miaoimg:skills-changed", refreshSkills);
});

defineExpose({ handleKeydown });
</script>

<style lang="scss" scoped>
.skillMenu {
  flex-shrink: 0;

  .skillButton {
    width: 24px;
    height: 24px;
    padding: 0;
  }
}

.skillPopup {
  min-width: 0;
  font-size: 13px;

  .skillSearch { margin-bottom: 6px; }

  .skillStatus {
    padding: 12px;
    color: var(--el-text-color-secondary);
  }

  .skillItem {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 100%;
    padding: 8px;
    border: none;
    border-radius: var(--el-border-radius-base);
    background: transparent;
    color: var(--el-text-color-primary);
    font: inherit;
    text-align: left;
    overflow-wrap: anywhere;
    cursor: pointer;

    &.active, &:focus-visible {
      background: var(--el-fill-color-light);
    }

    .skillName {
      display: flex;
      align-items: center;
      gap: 6px;
      small { flex-shrink: 0; margin-left: auto; color: var(--el-text-color-secondary); }
    }

    .skillDescription {
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 3;
      overflow: hidden;
      color: var(--el-text-color-secondary);
      font-size: 12px;
    }
  }
}
</style>
