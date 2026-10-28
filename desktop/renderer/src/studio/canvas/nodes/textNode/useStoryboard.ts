import { computed, inject, nextTick } from "vue";
import { useNode, useVueFlow, type GraphNode } from "@vue-flow/core";
import { translate } from "@miaoimg/i18n/vue";
import { createCanvasSelectionOperations } from "../../canvasSelectionOperations";

export const STORYBOARD_MAX_SHOTS = 30;

// 有编号或列表项时每项一个分镜（后续非列表行并入上一项）；否则按空行分段。去掉 Markdown 标记。
export function splitShots(markdown: string) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const item = /^\s*(?:[-*+]\s+|\d+[.、)）]\s*|第\s*\d+\s*[镜幕场]\s*[:：、]?\s*|(?:分镜|镜头|shot)\s*\d+\s*[:：、.]?\s*)/i;
  const clean = (value: string) => value.replace(item, "").replace(/^#+\s*/, "").replace(/[*_`>]/g, "").trim();
  const result: string[] = [];
  if (lines.filter(line => item.test(line)).length >= 2) {
    for (const line of lines) {
      if (item.test(line)) result.push(clean(line));
      else if (line.trim() && result.length && !/^#/.test(line.trim())) result[result.length - 1] += ` ${clean(line)}`;
    }
  } else {
    for (const block of markdown.split(/\n\s*\n/)) {
      const text = block.split("\n").map(clean).filter(Boolean).join(" ");
      if (text && !/^#/.test(block.trim())) result.push(text);
    }
  }
  return result.filter(Boolean);
}

// 「生成分镜」按钮与 Agent 的 createStoryboard 共用：每条分镜新建一个图片生成节点放进同一分组，
// 连入本文本节点的图片连到每个分镜；只填提示词，不提交生成。
export function useStoryboard(label: () => string) {
  const { id, node } = useNode();
  const flow = useVueFlow();
  const batchHistory = inject<(action: () => Promise<void>) => Promise<void>>("batchCanvasHistory", action => action());
  const { groupNodes } = createCanvasSelectionOperations(flow);
  // 连入本文本节点的图片（角色、场景参考）会连到每个分镜节点。
  const references = computed(() => flow.getEdges.value.filter(edge => edge.target === id
    && (flow.findNode(edge.source)?.data.outputs?.[edge.sourceHandle ?? ""] as { dataType?: string } | undefined)?.dataType === "IMAGE"));

  async function createStoryboard(list: string[], ratio: string) {
    const [width = 0, height = 0] = ratio.split(":").map(Number);
    const outputWidth = width > 0 && height > 0 ? Math.max(320, 360 * width / height + 2) : 362;
    const outputHeight = 410;
    const columns = Math.min(4, list.length);
    const origin = { x: node.computedPosition.x + (node.dimensions.width || 320) + 120, y: node.computedPosition.y };
    // 整块分镜区域避开已有节点：与谁重叠就挪到它下方，直到没有重叠。
    const block = { width: columns * (outputWidth + 40) + 48, height: Math.ceil(list.length / columns) * (outputHeight + 40) + 64 };
    for (let moved = true, guard = 0; moved && guard < 200; guard++) {
      moved = false;
      for (const other of flow.getNodes.value) {
        if (other.parentNode) continue;
        const position = other.computedPosition;
        const width = other.dimensions.width || 0;
        const height = other.dimensions.height || 0;
        if (position.x < origin.x + block.width && position.x + width > origin.x - 24 && position.y < origin.y + block.height && position.y + height > origin.y - 64) {
          origin.y = position.y + height + 104;
          moved = true;
        }
      }
    }
    const ids = list.map(() => crypto.randomUUID());
    const sources = references.value.map(edge => ({ source: edge.source, sourceHandle: edge.sourceHandle }));
    let groupId = "";
    await batchHistory(async () => {
      flow.addNodes(list.map((prompt, index) => ({
        id: ids[index]!,
        type: "remote-imageGenerationNode",
        position: { x: origin.x + (index % columns) * (outputWidth + 40), y: origin.y + Math.floor(index / columns) * (outputHeight + 40) },
        data: {
          label: `${label() || translate("分镜")} · ${translate("分镜 {0}", { 0: index + 1 })}`,
          mediaExportSize: { width: outputWidth, height: outputHeight },
          model: "", size: "", ratio, prompt,
          promptModel: prompt.split("\n").map(text => [{ type: "Write", text }]),
        },
      })));
      flow.addEdges(ids.flatMap(target => sources.map(source => ({ id: crypto.randomUUID(), ...source, target, targetHandle: "in" }))));
      await nextTick();
      // 分组需要节点已渲染出尺寸。
      const created = () => ids.map(item => flow.findNode(item)).filter((item): item is GraphNode => Boolean(item));
      // 窗口在后台时（Agent / MCP 调用）requestAnimationFrame 不触发，改用定时器等待。
      for (let frame = 0; frame < 60 && created().some(item => !item.dimensions.width || !item.dimensions.height); frame++) await new Promise(resolve => document.hidden ? setTimeout(resolve, 16) : requestAnimationFrame(resolve));
      groupId = groupNodes(created(), `${label() || translate("文本")} · ${translate("分镜")}`)[0] ?? "";
    });
    return { groupId, nodeIds: ids };
  }
  return { references, createStoryboard };
}
