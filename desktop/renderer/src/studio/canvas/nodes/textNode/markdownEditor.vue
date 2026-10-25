<template>
  <section class="nodeMarkdownEditor" :class="{ inline }">
    <div v-if="!inline" class="editorToolbar" role="toolbar" :aria-label="translate('Markdown 编辑工具')">
      <button type="button" :title="translate('标题')" :aria-label="translate('标题')" :disabled="locked || sourceMode || !ready" @mousedown.prevent @click="run('heading')"><icon-typography :size="18" /></button>
      <button type="button" :title="translate('加粗')" :aria-label="translate('加粗')" :disabled="locked || sourceMode || !ready" @mousedown.prevent @click="run('bold')"><icon-bold :size="18" /></button>
      <button type="button" :title="translate('斜体')" :aria-label="translate('斜体')" :disabled="locked || sourceMode || !ready" @mousedown.prevent @click="run('italic')"><icon-italic :size="18" /></button>
      <button type="button" :title="translate('列表')" :aria-label="translate('列表')" :disabled="locked || sourceMode || !ready" @mousedown.prevent @click="run('list')"><icon-list :size="18" /></button>
      <button type="button" :title="translate('撤销')" :aria-label="translate('撤销')" :disabled="locked || sourceMode || !ready" @mousedown.prevent @click="run('undo')"><icon-arrow-back-up :size="18" /></button>
      <button type="button" :title="translate('重做')" :aria-label="translate('重做')" :disabled="locked || sourceMode || !ready" @mousedown.prevent @click="run('redo')"><icon-arrow-forward-up :size="18" /></button>
      <span class="toolbarSpacer" />
      <button type="button" @click="copyText">{{ translate('复制正文') }}</button>
      <button type="button" :aria-pressed="sourceMode" @click="sourceMode = !sourceMode">{{ sourceMode ? translate('富文本') : translate('原文') }}</button>
    </div>
    <feedbackNotice :message="error" @close="error = ''" />
    <textarea v-if="sourceMode" class="sourceEditor" :value="modelValue" :readonly="readonly" :disabled="disabled" :aria-label="ariaLabel || translate('编辑 Markdown 原文')" spellcheck="false" @input="updateSource" />
    <editor-content v-if="editor && !sourceMode" :editor="editor" class="richHost" />
    <p v-if="!inline" class="editorHint">{{ translate('富文本会规范化 Markdown；保留原始 HTML 写法请使用原文。') }}</p>
  </section>
</template>

<script setup lang="ts">
import feedbackNotice from '../../components/feedbackNotice.vue';
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { Editor, EditorContent } from "@tiptap/vue-3";
import { translate } from "@miaoimg/i18n/vue";
import { IconTypography, IconBold, IconItalic, IconList, IconArrowBackUp, IconArrowForwardUp } from "@tabler/icons-vue";
import type { MarkdownFiles } from "./markdownContent";
import markdownExtensions, { parseMarkdownContent, serializeMarkdown } from "./markdownExtensions";

const props = withDefaults(defineProps<{
  modelValue: string;
  path?: string;
  files?: MarkdownFiles;
  active?: boolean;
  readonly?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  writeClipboardText?: (text: string) => Promise<void>;
  // 嵌在节点里直接编辑：不带自己的工具栏，格式按钮由节点上方的浮动工具栏调用 command。
  inline?: boolean;
}>(), { active: true, inline: false });
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const sourceMode = ref(false);
const editor = shallowRef<Editor>();
const ready = computed(() => !!editor.value);
const error = ref("");
const locked = computed(() => !!(props.disabled || props.readonly));
let lastMarkdown = "";
type TextBlock = "paragraph" | "h1" | "h2" | "h3" | "ordered" | "bullet";
const activeBlock = ref<TextBlock>("paragraph");
function blockOf(current: { isActive(name: string, attributes?: Record<string, unknown>): boolean }): TextBlock {
  if (current.isActive("orderedList")) return "ordered";
  if (current.isActive("bulletList")) return "bullet";
  for (const level of [1, 2, 3] as const) if (current.isActive("heading", { level })) return `h${level}`;
  return "paragraph";
}

function destroyEditor() {
  editor.value?.destroy();
  editor.value = undefined;
}
function rebuild() {
  destroyEditor();
  if (!props.active || sourceMode.value) return;
  error.value = "";
  try {
    lastMarkdown = props.modelValue;
    editor.value = new Editor({
      extensions: markdownExtensions({ files: props.files, resource: { path: props.path || "" } }),
      content: parseMarkdownContent(props.modelValue),
      editable: !locked.value,
      editorProps: {
        attributes: { class: "textNodeMarkdown", "aria-label": props.ariaLabel || translate("编辑文本内容"), role: "textbox", "aria-multiline": "true" },
        transformPastedHTML: parseMarkdownContent,
        handlePaste(_view, event) {
          const current = editor.value;
          const clipboard = event.clipboardData;
          if (!current || locked.value || current.isActive("codeBlock") || clipboard?.getData("text/html")) return false;
          const text = clipboard?.getData("text/markdown") || clipboard?.getData("text/plain");
          return !!text && current.commands.insertContent(parseMarkdownContent(text));
        },
      },
      onTransaction({ editor: current }) { activeBlock.value = blockOf(current); },
      onUpdate({ editor: current }) {
        if (!props.active || sourceMode.value) return;
        lastMarkdown = serializeMarkdown(current);
        // 同步更新节点输出，关闭弹窗或保存画布时不等待防抖回调。
        emit("update:modelValue", lastMarkdown);
      },
    });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : translate("编辑器加载失败，可切换原文继续编辑");
  }
}

watch([() => props.active, sourceMode, () => props.files, () => props.path], rebuild, { immediate: true, flush: "post" });
watch(() => props.modelValue, value => {
  if (!editor.value || !props.active || value === lastMarkdown) return;
  try {
    editor.value.commands.setContent(parseMarkdownContent(value), { emitUpdate: false });
    lastMarkdown = value;
  } catch (cause) { error.value = cause instanceof Error ? cause.message : translate("正文更新失败"); }
});
watch(locked, value => editor.value?.setEditable(!value, false));
onBeforeUnmount(destroyEditor);

function run(action: "heading" | "bold" | "italic" | "list" | "undo" | "redo") {
  if (!editor.value || locked.value || !props.active) return;
  const chain = editor.value.chain().focus();
  if (action === "heading") chain.toggleHeading({ level: 2 }).run();
  else if (action === "bold") chain.toggleBold().run();
  else if (action === "italic") chain.toggleItalic().run();
  else if (action === "list") chain.toggleBulletList().run();
  else if (action === "undo") chain.undo().run();
  else chain.redo().run();
}
// 浮动工具栏用：段落样式、粗体、斜体、分割线。列表和标题互斥，先退出列表再改样式。
function command(action: TextBlock | "bold" | "italic" | "rule") {
  const current = editor.value;
  if (!current || locked.value || !props.active) return;
  const chain = current.chain().focus();
  if (action === "bold") return chain.toggleBold().run();
  if (action === "italic") return chain.toggleItalic().run();
  if (action === "rule") return chain.setHorizontalRule().run();
  if (action === "ordered") return chain.toggleOrderedList().run();
  if (action === "bullet") return chain.toggleBulletList().run();
  if (current.isActive("orderedList")) chain.toggleOrderedList();
  else if (current.isActive("bulletList")) chain.toggleBulletList();
  if (action === "paragraph") return chain.setParagraph().run();
  return chain.setHeading({ level: Number(action.slice(1)) as 1 | 2 | 3 }).run();
}
function focus() { editor.value?.commands.focus("end"); }
defineExpose({ command, focus, activeBlock, ready });

function updateSource(event: Event) {
  if (!locked.value && props.active) emit("update:modelValue", (event.target as HTMLTextAreaElement).value);
}
async function copyText() {
  try {
    if (props.writeClipboardText) await props.writeClipboardText(props.modelValue);
    else await navigator.clipboard.writeText(props.modelValue);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : translate("复制失败，请在原文中选择并复制"); }
}
</script>

<style scoped lang="scss">
.nodeMarkdownEditor {
  display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; overflow: hidden;
  .editorToolbar { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 0 12px; flex-shrink: 0;
    button { display: inline-flex; align-items: center; justify-content: center; min-width: 32px; min-height: 32px; border: 0; border-radius: 8px; padding: 4px 8px; color: var(--el-text-color-primary); background: transparent; font: inherit; cursor: pointer;
      &:hover, &[aria-pressed="true"] { background: var(--el-fill-color-light); }
      &:disabled { opacity: 0.45; cursor: default; }
    }
    .toolbarSpacer { flex: 1; }
  }
  .sourceEditor { flex: 1; min-height: 0; width: 100%; box-sizing: border-box; resize: none; padding: 20px max(20px, calc((100% - 780px) / 2)); border: 0; border-radius: 12px; color: var(--el-text-color-primary); background: var(--el-fill-color-blank); font: 14px/1.8 Consolas, monospace; }
  .richHost { flex: 1; min-height: 0; overflow: auto; border-radius: 12px; background: var(--el-fill-color-blank); overscroll-behavior: contain;
    :deep(.ProseMirror) { box-sizing: border-box; max-width: 820px; min-height: 100%; margin-inline: auto; padding: 20px; outline: none; white-space: pre-wrap; word-break: break-word; font-size: 15px; line-height: 1.8; }
    :deep(.ProseMirror-selectednode) { outline: 2px solid var(--el-color-primary); }
  }
  .editorHint { flex-shrink: 0; margin: 6px 0 0; color: var(--el-text-color-secondary); font-size: 11px; }
  &.inline .richHost { border: 0; background: transparent;
    :deep(.ProseMirror) { max-width: none; min-height: 94px; padding: 4px 6px; font-size: inherit; line-height: inherit; cursor: text; user-select: text; }
  }
}
</style>
