import { computed, nextTick, ref, watch, type Ref } from "vue";
import type { GraphNode } from "@vue-flow/core";
import { IconArrowAutofitRight, IconPencil } from "@tabler/icons-vue";
import { translate } from "@miaoimg/i18n/vue";
import { useLinkedNode } from "../../linkedNode";

type VideoModel = { type?: string; providerId: string; modelId: string; mode?: unknown[] };
export type VideoModeEntry = { mode: "edit" | "extend"; label: string; icon: typeof IconPencil; model: string };

// 模型能编辑或延长已有视频时，在有视频的节点上直接给入口（和 LibTV 视频节点的续写、元素替换一样）：
// 新建第二个节点——连好这段视频、选好模式和支持该模式的模型的视频生成节点，不自动生成。
// 只有当前目录里确实有模型支持该模式时才显示。上传的视频节点和生成好的视频节点共用这一份。
export function useVideoModeEntries(options: {
  node: GraphNode;
  hasVideo: () => boolean;
  loadModels: () => Promise<VideoModel[]>;
  onError: (error: unknown) => void;
}) {
  const models = ref<VideoModel[]>([]) as Ref<VideoModel[]>;
  const creating = ref(false);
  const { createLinked } = useLinkedNode();
  watch(options.hasVideo, async (hasVideo) => {
    if (!hasVideo || models.value.length) return;
    models.value = (await options.loadModels().catch(() => [])).filter(item => item.type === "video");
  }, { immediate: true });
  const entries = computed<VideoModeEntry[]>(() => ([["edit", "编辑视频", IconPencil], ["extend", "延长视频", IconArrowAutofitRight]] as const).flatMap(([mode, label, icon]) => {
    const model = models.value.find(item => item.mode?.includes(mode));
    return model ? [{ mode, label, icon, model: JSON.stringify([model.providerId, model.modelId]) }] : [];
  }));
  async function create(entry: VideoModeEntry) {
    if (creating.value) return;
    creating.value = true;
    try {
      const created = await createLinked(options.node, "remote-videoGenerationNode", translate(entry.label));
      if (!created) return;
      await nextTick();
      // 顺序要和生成节点里的同步监听对上：先模型，再标记为明确选择，最后写模式。
      created.data.model = entry.model;
      created.data.modeChosen = true;
      created.data.mode = JSON.stringify(entry.mode);
    } catch (error) {
      options.onError(error);
    } finally {
      creating.value = false;
    }
  }
  return { entries, creating, create };
}
