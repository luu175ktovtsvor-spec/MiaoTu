<template>
  <div class="messageMarkdown">
    <markdown
      v-for="(chunk, index) in chunks"
      :key="index + '-' + !!definitions"
      v-memo="[chunk, streaming && index === chunks.length - 1, codeOptions, directory, markdownLocale]"
      class="markdownChunk"
      :content="chunk"
      :mode="streaming && index === chunks.length - 1 ? 'streaming' : 'static'"
      :enableAnimate="false"
      :shikiOptions="shikiOptions"
      :codeOptions="codeOptions"
      :mermaidOptions="mermaidOptions"
      :linkOptions="{ safetyCheck: false }"
      :cdnOptions="cdnOptions"
      :components="markdownOverlays"
      :nodeRenderers="nodeRenderers"
      :parseMarkdownIntoBlocks="definitions ? keepChunk : undefined"
      :locale="markdownLocale" />
  </div>
</template>

<script setup lang="ts">
import { computed, h } from "vue";
import { COMPONENT_RENDERERS, Markdown, parseMarkdownIntoBlocks } from "vue-stream-markdown";
import { MarkdownAstParser } from "@markmend/ast";
import type { CodeOptions, ImageNodeRendererProps, LinkNodeRendererProps, MermaidOptions, ShikiOptions } from "vue-stream-markdown";
import "vue-stream-markdown/index.css";
import "vue-stream-markdown/theme.css";
import markdownOverlays from "./markdownOverlays";
import markdownImage from "./markdownImage.vue";
import safeMathRenderer from "./safeMathRenderer.vue";
import { markdownLocale } from "@/lib/i18n";
import useWorkspaceFiles, { workspacePlaybackUrl } from "@/lib/workspaceFiles";

const { content, streaming = false, codeOptions, directory } = defineProps<{ content: string; streaming?: boolean; codeOptions?: CodeOptions; directory?: string }>();
const renderImage = (image: ImageNodeRendererProps) => h(markdownImage, { image, directory: directory! });
const renderLink = (link: LinkNodeRendererProps) => {
  let node = link.node;
  // Agent 交付的相对文件路径属于当前工作区，先解析成带账号、项目范围的地址。
  // 外部链接仍交给 Markdown 原有的地址检查，不放宽协议或路径限制。
  if (directory && node.url && !/^(?:[a-z][a-z\d+.-]*:|[\\/]|#)/i.test(node.url)) {
    try {
      const path = decodeURIComponent(node.url.split(/[?#]/, 1)[0]!);
      if (path && !/^(?:[a-z][a-z\d+.-]*:|[\\/])/i.test(path) && !/[\\\x00-\x1f]/.test(path) && !path.split("/").includes("..")) {
        const url = workspacePlaybackUrl(useWorkspaceFiles(directory).url(path));
        node = { ...node, url: new URL(url, window.location.origin).href };
      }
    } catch { /* 无效编码继续由原链接组件拦截。 */ }
  }
  return h(COMPONENT_RENDERERS.link, { ...link, node });
};
const nodeRenderers = computed(() => ({
  math: safeMathRenderer,
  inlineMath: safeMathRenderer,
  ...(directory ? { image: renderImage, link: renderLink } : {}),
}));
const shikiOptions: ShikiOptions = { theme: ["github-light", "github-dark"] };
const mermaidOptions: MermaidOptions = { config: { securityLevel: "strict" } };
const cdnOptions = { shiki: false } as const;
const keepChunk = (value: string) => [value];
const blocks = computed(() => parseMarkdownIntoBlocks(content));
const definitionParser = new MarkdownAstParser({ mode: "static" });
const isDefinition = (block: string) => /^ {0,3}\[(?!\^)[^\]\n]+\]:/.test(block)
  && definitionParser.markdownToAst(block).children.every(node => node.type === "definition");
const definitions = computed(() => blocks.value.length > 1 ? blocks.value.filter(isDefinition).join("\n\n") : "");
const chunks = computed(() => {
  if (blocks.value.length < 2) return blocks.value;
  const groups: string[] = [];
  let current = "";
  // ACT: 不拆语法块，稳定组不重渲染；单个语法块仍完整交给库处理。
  for (const block of blocks.value) {
    if (isDefinition(block)) continue;
    if (current && current.length + block.length > 8192) {
      groups.push(current);
      current = "";
    }
    current += block;
  }
  if (current) groups.push(current);
  // 定义放在组前，避免落入末尾尚未闭合的代码块。
  return definitions.value ? groups.map(group => `${definitions.value}\n\n${group}`) : groups;
});
</script>

<style scoped lang="scss">
.messageMarkdown {
  min-width: 0;

  :deep([data-stream-markdown="code-block"]) {
    border-radius: 12px;
    overflow: clip;
    background: var(--el-fill-color-light);
    box-shadow: none;
  }

  .markdownChunk {
    --background: var(--el-bg-color);
    --foreground: var(--el-text-color-primary);
    --muted: var(--el-fill-color-light);
    --muted-foreground: var(--el-text-color-secondary);
    --border: var(--el-border-color-lighter);
    --primary: var(--el-color-primary);
    font-size: inherit;
    line-height: inherit;

    & + .markdownChunk {
      margin-top: 12px;
    }
  }
}
</style>
