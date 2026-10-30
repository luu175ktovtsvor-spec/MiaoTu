import { computed, inject, nextTick, onScopeDispose, reactive, watch, type Ref } from "vue";
import { useVueFlow, type GraphNode } from "@vue-flow/core";
import { translate } from "@miaoimg/i18n/vue";
import { useNodeFiles, useNodeFfmpeg, type NodeMediaValue } from "@miaoimg/nodes-scaffold/runtime";
import { captureWorkspaceScope, assertWorkspaceScope, subscribeWorkspaceScope } from "@/lib/workspaceRemote";
import { validateConnection } from "../../scaffold/connection";
import type { NodeHandle } from "../../scaffold/connection";
import type { NodeMediaModel } from "../../scaffold/nodeAi";
import type { CanvasToolExtension } from "../../useMediaPaletteActions";
import { useCanvasToolRegistry } from "../../canvasToolRegistry";
import { videoIntent, videoEditModels, type VideoIntentToolId } from "../../videoIntentCatalogue";
import { durationsForMode, inheritedFields, resolutionsForMode } from "../../scaffold/mediaParameters";
import { preparedVideoEditData, validSemanticRange, videoEditDefaults, videoEditEligibility, type EditMediaMetadata } from "./videoEditIntentContract";
import type { SegmentRemakeDraft } from "./segmentRemake";

type Reference = { key: string; node: GraphNode; handle: string; kind: "image" | "audio"; file: NodeMediaValue; label: string };
const modelKey = (model: NodeMediaModel) => JSON.stringify([model.providerId, model.modelId]);
export function useVideoIntentActions(options: { node: GraphNode; file: () => NodeMediaValue | undefined; disabled: () => boolean; loadModels: () => Promise<NodeMediaModel[]>; onError: (error: unknown) => void }) {
  const flow = useVueFlow(), registry = useCanvasToolRegistry(), files = useNodeFiles(), ffmpeg = useNodeFfmpeg();
  const active = inject<Ref<boolean> | undefined>("canvasUiActive", undefined);
  const getCanvasSignal = inject<(() => AbortSignal) | undefined>("canvasOperationSignal", undefined);
  const batch = inject<(action: () => Promise<void>) => Promise<void>>("batchCanvasHistory", action => action());
  const state = reactive({ visible: false, loading: false, referenceLoading: false, preparing: false, models: [] as NodeMediaModel[], intent: "video:edit" as VideoIntentToolId,
    model: "", prompt: "", referenceKeys: [] as string[], source: undefined as EditMediaMetadata | undefined, referenceMetadata: {} as Record<string, EditMediaMetadata>, duration: undefined as number | undefined, resolution: "", start: 0, end: 0 });
  const lifetime = new AbortController();
  let operation = new AbortController(), referencesOperation = new AbortController(), opening = 0;
  let boundSignal = operation.signal;
  let assertSource: (() => void) | undefined;
  const usable = () => !lifetime.signal.aborted && active?.value !== false && !options.disabled() && Boolean(options.file()?.url) && flow.findNode(options.node.id) === options.node;
  const remakeModels = (models: NodeMediaModel[]) => models.filter(model => model.type === "video" && model.modelId === "seedance-2.5" && model.mode?.includes("edit"));
  const remakeAvailable = computed(() => remakeModels(registry?.models.value.length ? registry.models.value : state.models).length > 0);
  const references = computed<Reference[]>(() => {
    const seen = new Set<string>();
    return flow.getNodes.value.flatMap(node => Object.entries(node.data.outputs || {}).flatMap(([handle, output]: [string, any]) => {
      if (!output || !["IMAGE", "AUDIO"].includes(output.dataType) || !output.value?.url || !node.data.handles?.some((item: NodeHandle) => item.id === handle && item.type === "source")) return [];
      const identity = JSON.stringify([output.dataType, output.value.url]);
      if (seen.has(identity)) return []; seen.add(identity);
      return [{ key: JSON.stringify([node.id, handle, output.value.url]), node, handle, kind: output.dataType === "IMAGE" ? "image" as const : "audio" as const,
        file: { ...output.value }, label: String(node.data.label || (output.dataType === "IMAGE" ? translate("图片") : translate("音频"))) }];
    }));
  });
  const selectedReferences = computed(() => state.referenceKeys.flatMap(key => { const reference = references.value.find(item => item.key === key); return reference ? [reference] : []; }));
  const missingReference = computed(() => state.referenceKeys.length !== selectedReferences.value.length);
  const inputs = computed(() => ({ source: state.source, images: selectedReferences.value.filter(item => item.kind === "image").map(item => state.referenceMetadata[item.key]).filter(Boolean), audios: selectedReferences.value.filter(item => item.kind === "audio").map(item => state.referenceMetadata[item.key]).filter(Boolean) }));
  const choices = computed(() => videoEditModels(state.models).filter(model => !videoEditEligibility(model, inputs.value)));
  const choice = computed(() => choices.value.find(model => modelKey(model) === state.model));
  watch(choices, models => { if (!models.length) state.model = ""; });
  const modelError = computed(() => {
    if (state.loading || state.referenceLoading || !state.source) return "";
    if (!videoEditModels(state.models).length) return translate("当前没有支持此操作的视频模型");
    if (!choices.value.length) return translate("没有兼容当前素材的编辑模型，请调整素材后重试");
    if (state.model && !choice.value) return translate("所选模型不支持当前素材，请重新选择模型");
    if (choices.value.length) return "";
    return "";
  });
  const modelHelp = computed(() => {
    const lines: string[] = [];
    if (state.source) lines.push(translate("原视频：{0} × {1}，{2} 像素", { 0: state.source.width!, 1: state.source.height!, 2: state.source.width! * state.source.height! }));
    for (const model of videoEditModels(state.models)) {
      const invalid = videoEditEligibility(model, inputs.value);
      const reason = invalid ? translate(invalid.key, Object.fromEntries(Object.entries(invalid.params || {}).map(([key,value])=>[key,typeof value === "string"?translate(value):value]))) : "";
      lines.push(`${model.label}${reason ? ` · ${reason}` : ""}`);
      const videoPolicy = {...(model.referenceInputs?.video || {}),...(model.parameterRules?.referenceInputsByMode?.edit?.video || {})} as Record<string,any>;
      if (videoPolicy.minPixels) lines.push(translate("最低总像素：{0}", { 0: videoPolicy.minPixels }));
      const counts = model.parameterRules?.referencesByMode?.edit;
      lines.push(translate("附加图片上限：{0}；附加音频上限：{1}", { 0: counts?.image?.[1] ?? model.referenceLimits?.image ?? 0, 1: counts?.audio?.[1] ?? model.referenceLimits?.audio ?? 0 }));
      const formats = model.referenceInputs?.audio?.formats;
      if (formats?.length) lines.push(translate("参考音频格式：{0}", { 0: formats.join(" / ").toUpperCase() }));
      if (model.parameterRules?.hintsByMode?.edit) lines.push(translate(model.parameterRules.hintsByMode.edit));
    }
    return lines;
  });
  const durations = computed(() => choice.value ? durationsForMode(choice.value, "edit") : []);
  const resolutions = computed(() => choice.value ? resolutionsForMode(choice.value, "edit", state.duration, videoEditDefaults(choice.value, state.source?.duration || 0).parameters) : []);
  const inherited = computed(() => inheritedFields(choice.value, "edit"));
  const prompt = computed(() => {
    const intent = videoIntent(state.intent)!;
    const range = state.intent === "video:retake-segment" ? { start: state.start, end: state.end } : undefined;
    return [translate("编辑目标：{0}", { 0: translate(intent.label) }), ...(range ? [translate("仅对 {0}–{1} 秒的内容进行语义编辑，其它内容尽量保持不变。", { 0: range.start, 1: range.end })] : []), state.prompt.trim(), translate("尽量保留未要求修改的内容，以及原视频的时长与画面比例。")].join("\n");
  });
  const promptError = computed(() => choice.value?.parameterRules?.maxPromptCharacters && [...prompt.value.trim()].length > choice.value.parameterRules.maxPromptCharacters ? translate("编辑描述超过当前模型的字符上限") : "");
  const canPrepare = computed(() => usable() && !state.loading && !state.referenceLoading && !state.preparing && Boolean(choice.value && state.prompt.trim() && state.source)
    && durations.value.includes(state.duration!) && resolutions.value.includes(state.resolution) && !promptError.value && !missingReference.value && selectedReferences.value.length === Object.keys(state.referenceMetadata).length
    && (state.intent !== "video:retake-segment" || validSemanticRange(state.start, state.end, state.source!.duration!)));
  const busy = computed(() => state.loading || state.referenceLoading || state.preparing);
  function close() { state.visible = false; state.loading = false; state.referenceLoading = false; opening++; operation.abort(); referencesOperation.abort(); }
  const stopWorkspace = subscribeWorkspaceScope(close);
  onScopeDispose(() => { lifetime.abort(); stopWorkspace(); close(); });
  watch(() => active?.value, value => { if (value === false) close(); }, { flush: "sync" });
  watch(() => registry?.scope(), close, { flush: "sync" });
  watch(() => JSON.stringify(options.node.data.outputs?.video), () => { if (state.visible || state.loading || state.preparing) close(); }, { flush: "sync" });
  watch(() => options.node.selected && usable(), async selected => {
    if (!selected) return;
    const scope = captureWorkspaceScope(), signal = getCanvasSignal?.(), source = JSON.stringify(options.node.data.outputs?.video);
    try {
      const models = await options.loadModels();
      signal?.throwIfAborted(); assertWorkspaceScope(scope);
      if (options.node.selected && usable() && JSON.stringify(options.node.data.outputs?.video) === source) state.models = models;
    } catch { /* A directory outage must not alter the source or its saved data. */ }
  }, { immediate: true });
  async function metadata(file: NodeMediaValue, kind: EditMediaMetadata["kind"], signal: AbortSignal): Promise<EditMediaMetadata> {
    const workspace = files.getWorkspaceFiles();
    if (!workspace.stat) throw new Error(translate("当前工作区尚不支持素材元信息，请更新后重试"));
    const stat = await workspace.stat(file.url, signal); signal.throwIfAborted();
    const factory = await ffmpeg(signal), command = factory(file.url);
    const cancel = () => command.kill(); signal.addEventListener("abort", cancel, { once: true });
    try {
      const probe = await new Promise<any>((resolve, reject) => command.ffprobe((error, data) => error ? reject(error) : resolve(data)));
      signal.throwIfAborted();
      const stream = probe.streams?.find((item: any) => item.codec_type === (kind === "audio" ? "audio" : "video") && !item.disposition?.attached_pic);
      if (!stream) throw new Error(translate("无法读取素材信息"));
      const [numerator, denominator = 1] = String(stream.avg_frame_rate || stream.r_frame_rate || "0/1").split("/").map(Number);
      return { kind, duration: kind === "image" ? undefined : Number(stream.duration || probe.format?.duration), sizeBytes: stat.size, width: stream.width, height: stream.height,
        fps: denominator ? numerator / denominator : 0, format: stat.mime === "video/quicktime" ? "mov" : stat.mime === "video/mp4" ? "mp4" : probe.format?.format_name, codec: stream.codec_name, mimeType: stat.mime || file.mimeType, revision: stat.revision };
    } finally { signal.removeEventListener("abort", cancel); }
  }
  function chooseModel() {
    const model = choice.value; if (!model || !state.source) return;
    const defaults = videoEditDefaults(model, state.source.duration!); state.duration = defaults.duration; state.resolution = defaults.resolution;
  }
  watch(() => state.duration, () => { if (choice.value && !resolutions.value.includes(state.resolution)) state.resolution = resolutions.value[0] || ""; });
  watch(() => [...state.referenceKeys], async () => {
    referencesOperation.abort(); referencesOperation = new AbortController();
    state.referenceMetadata = {};
    if (!state.visible || !state.referenceKeys.length) { state.referenceLoading = false; return; }
    const current = referencesOperation, signal = AbortSignal.any([boundSignal, current.signal]);
    state.referenceLoading = true;
    try {
      const selected = [...selectedReferences.value];
      const settled = await Promise.allSettled(selected.map(async item => [item.key, await metadata(item.file, item.kind, signal)] as const));
      signal.throwIfAborted(); assertSource?.();
      const results = settled.map(item => { if (item.status === "rejected") throw item.reason; return item.value; });
      state.referenceMetadata = Object.fromEntries(results);
    } catch (error) { if (!signal.aborted) options.onError(error); }
    finally { if (current === referencesOperation) state.referenceLoading = false; }
  });
  async function open(id: string, assertBinding?: () => void) {
    const intent = videoIntent(id); if (!intent || busy.value || !usable()) return;
    operation.abort(); operation = new AbortController(); referencesOperation.abort();
    const token = ++opening, scope = captureWorkspaceScope(), binding = registry?.scope(), source = JSON.stringify(options.node.data.outputs?.video);
    const canvasSignal = getCanvasSignal?.();
    const signal = boundSignal = AbortSignal.any([operation.signal, lifetime.signal, ...(canvasSignal ? [canvasSignal] : [])]);
    assertSource = () => {
      signal.throwIfAborted(); assertWorkspaceScope(scope); assertBinding?.();
      if (!usable() || registry && registry.scope() !== binding || JSON.stringify(options.node.data.outputs?.video) !== source) throw new Error(translate("原视频已变化或正在处理，请重新操作"));
    };
    state.intent = intent.id; state.prompt = intent.prompt ? translate(intent.prompt) : ""; state.referenceKeys = []; state.referenceMetadata = {}; state.source = undefined; state.model = "";
    state.visible = intent.id !== "video:retake-segment"; state.loading = true;
    try {
      const sourceFile = { ...options.file()! };
      const modelTask = registry ? registry.refresh().then(() => registry.models.value) : options.loadModels();
      const [models, sourceMetadata] = await Promise.all([modelTask, metadata(sourceFile, "video", signal)]);
      if (token !== opening) return; assertSource();
      state.models = [...models]; state.source = sourceMetadata; state.start = 0; state.end = Math.min(5, sourceMetadata.duration || 0);
      if (intent.id === "video:retake-segment") {
        const model = remakeModels(models).find(model => modelKey(model) === options.node.data.model) || remakeModels(models)[0];
        if (!model) throw new Error(translate("Seedance 2.5 暂不可用，请稍后重试"));
        await createRemakeNode(model, sourceFile, sourceMetadata, signal);
        return;
      }
      state.model = choices.value[0] ? modelKey(choices.value[0]) : ""; chooseModel();
    } catch (error) { if (!signal.aborted && token === opening) options.onError(error); }
    finally { if (token === opening) state.loading = false; }
  }
  async function createRemakeNode(model: NodeMediaModel, sourceFile: NodeMediaValue, sourceMetadata: EditMediaMetadata, signal: AbortSignal) {
    if (!Number.isFinite(sourceMetadata.duration) || sourceMetadata.duration! < 4) throw new Error(translate("原视频至少需要 4 秒"));
    if (!sourceMetadata.revision || ![sourceMetadata.width, sourceMetadata.height, sourceMetadata.fps].every(value => Number.isFinite(value) && value! > 0)) throw new Error(translate("无法读取素材信息"));
    // The original may be longer/larger than one admitted segment. Validate
    // unchanged geometry here; the exporter normalizes unsupported FPS; the exporter must validate the actual
    // MP4 codec, file size and selected duration before a paid submission.
    const policy = { ...(model.referenceInputs?.video || {}), ...(model.parameterRules?.referenceInputsByMode?.edit?.video || {}) } as Record<string, any>;
    const { maxBytes: _maxBytes, exclusiveMaxBytes: _exclusiveMaxBytes, formats: _formats, mimes: _mimes, codecs: _codecs, minFps: _minFps, maxFps: _maxFps, ...segmentPolicy } = policy;
    const segmentModel: NodeMediaModel = { ...model, referenceInputs: { ...model.referenceInputs, video: segmentPolicy }, parameterRules: {
      ...model.parameterRules, referenceInputsByMode: { ...model.parameterRules?.referenceInputsByMode, edit: { ...model.parameterRules?.referenceInputsByMode?.edit, video: segmentPolicy } },
    } };
    const invalid = videoEditEligibility(segmentModel, { source: { ...sourceMetadata, duration: Math.min(30, sourceMetadata.duration!) }, images: [], audios: [] });
    if (invalid) throw new Error(translate(invalid.key, Object.fromEntries(Object.entries(invalid.params || {}).map(([key, value]) => [key, typeof value === "string" ? translate(value) : value]))));
    const type = "remote-videoGenerationNode";
    if (!flow.nodeTypes?.value?.[type]) throw new Error(translate("请先启用视频生成节点插件"));
    const draft: SegmentRemakeDraft = { version: 1, source: { nodeId: options.node.id, handle: "video", file: sourceFile, revision: sourceMetadata.revision,
      duration: sourceMetadata.duration!, width: sourceMetadata.width!, height: sourceMetadata.height!, fps: sourceMetadata.fps! }, ranges: [] };
    const data = { ...videoEditDefaults(model, Math.min(30, sourceMetadata.duration!)), label: `${options.node.data.label || translate("视频")} · ${translate("片段重拍")}`,
      model: modelKey(model), mode: JSON.stringify("edit"), modeChosen: true, prompt: "", promptModel: [[{ type: "Write", text: "" }]], segmentRemakeDraft: draft };
    state.preparing = true;
    let created: GraphNode | undefined, committed = false;
    try {
      const workspace = files.getWorkspaceFiles();
      const latest = await workspace.stat!(sourceFile.url, signal); assertSource?.();
      if (latest.revision !== sourceMetadata.revision) throw new Error(translate("素材已变化，请重新选择后操作"));
      await batch(async () => {
        assertSource?.();
        const id = crypto.randomUUID(), source = options.node;
        const x = source.computedPosition.x + Math.max(source.dimensions.width || 0, 480) + 80;
        let y = source.computedPosition.y;
        for (const other of [...flow.getNodes.value].sort((a, b) => a.computedPosition.y - b.computedPosition.y)) {
          const p = other.computedPosition, width = Math.max(other.dimensions.width || 0, 480), height = Math.max(other.dimensions.height || 0, 400);
          if (p.x < x + 520 && p.x + width > x && p.y < y + 400 && p.y + height > y) y = p.y + height + 40;
        }
        flow.addNodes({ id, type, position: { x, y }, data }); created = flow.findNode(id);
        try {
          await nextTick(); assertSource?.();
          if (!created || flow.findNode(id) !== created) throw new Error(translate("目标节点已变化，请重新操作"));
          const inputs = (created.data.handles || []).filter((handle: NodeHandle) => handle.type === "target");
          const connection = inputs.map((input: NodeHandle) => ({ source: source.id, sourceHandle: "video", target: id, targetHandle: input.id }))
            .find(connection => validateConnection(connection, { sourceNode: source, targetNode: created!, nodes: flow.getNodes.value, edges: flow.getEdges.value }));
          if (!connection) throw new Error(translate("素材无法完整连接到编辑节点，请重新操作"));
          assertSource?.(); flow.addEdges([{ ...connection, id: crypto.randomUUID() }]);
          flow.removeSelectedElements(); flow.addSelectedNodes([created]);
        } catch (error) { if (created && flow.findNode(id) === created) flow.removeNodes(id, true, false); throw error; }
      });
      assertSource?.(); committed = true;
      if (!signal.aborted && created && flow.findNode(created.id) === created) {
        await nextTick(); assertSource?.();
        // The editor is outside the node's measured video box. Include it in
        // framing so the timeline and send button stay in the initial viewport.
        const p = created.computedPosition, ratio = sourceMetadata.width! / sourceMetadata.height!;
        const previewHeight = Math.min(640, Math.max(320, 350 * ratio)) / ratio;
        await flow.fitBounds({ x: p.x - 40, y: p.y - 40, width: Math.max(created.dimensions.width || 0, 660) + 80,
          height: Math.max(created.dimensions.height || 0, previewHeight) + 620 }, { padding: 0.1, duration: 200 });
      }
    } catch (error) {
      if (!committed && created && flow.findNode(created.id) === created) flow.removeNodes(created.id, true, false);
      throw error;
    } finally { state.preparing = false; }
  }
  async function prepare() {
    if (!canPrepare.value || !choice.value || !state.source) return;
    const sourceFile = { ...options.file()! }, selected = [...selectedReferences.value], model = choice.value, sourceMetadata = state.source;
    const intent = videoIntent(state.intent)!, range = state.intent === "video:retake-segment" ? { start: state.start, end: state.end } : undefined;
    state.preparing = true;
    const signal = boundSignal;
    let created: GraphNode | undefined;
    let committed = false;
    try {
      assertSource?.();
      const workspace = files.getWorkspaceFiles();
      const compare = async (file: NodeMediaValue, metadata: EditMediaMetadata) => { const stat = await workspace.stat!(file.url, signal); if (stat.revision !== metadata.revision) throw new Error(translate("素材已变化，请重新选择后操作")); };
      await Promise.all([compare(sourceFile, sourceMetadata), ...selected.map(item => compare(item.file, state.referenceMetadata[item.key]))]);
      assertSource?.();
      const invalid = videoEditEligibility(model, inputs.value); if (invalid) throw new Error(translate(invalid.key, Object.fromEntries(Object.entries(invalid.params || {}).map(([key, value]) => [key, typeof value === "string" ? translate(value) : value]))));
      const type = "remote-videoGenerationNode";
      if (!flow.nodeTypes?.value?.[type]) throw new Error(translate("请先启用视频生成节点插件"));
      const assertReferences = () => {
        assertSource?.();
        if (selected.some(item => flow.findNode(item.node.id) !== item.node || item.node.data.outputs?.[item.handle]?.value?.url !== item.file.url)) throw new Error(translate("参考素材已更新，请重新选择后操作"));
      };
      const data = preparedVideoEditData({ model, label: `${options.node.data.label || translate("视频")} · ${translate(intent.label)}`, prompt: prompt.value, sourceSeconds: sourceMetadata.duration!, duration: state.duration, resolution: state.resolution, range, intent: intent.id });
      await batch(async () => {
        assertReferences();
        const id = crypto.randomUUID(), source = options.node;
        const x = source.computedPosition.x + Math.max(source.dimensions.width || 0, 480) + 80;
        let y = source.computedPosition.y;
        for (const other of [...flow.getNodes.value].sort((a, b) => a.computedPosition.y - b.computedPosition.y)) {
          const p = other.computedPosition, width = Math.max(other.dimensions.width || 0, 480), height = Math.max(other.dimensions.height || 0, 400);
          if (p.x < x + 520 && p.x + width > x && p.y < y + 400 && p.y + height > y) y = p.y + height + 40;
        }
        flow.addNodes({ id, type, position: { x, y }, data });
        created = flow.findNode(id);
        try {
          await nextTick(); assertReferences();
          if (!created || flow.findNode(id) !== created) throw new Error(translate("目标节点已变化，请重新操作"));
          const bindings = [{ node: source, handle: "video" }, ...selected];
          const inputs = (created.data.handles || []).filter((handle: NodeHandle) => handle.type === "target");
          const connections = bindings.map(item => inputs.map((input: NodeHandle) => ({ source: item.node.id, sourceHandle: item.handle, target: id, targetHandle: input.id })).find(connection => validateConnection(connection, { sourceNode: item.node, targetNode: created!, nodes: flow.getNodes.value, edges: flow.getEdges.value })));
          if (connections.some(item => !item)) throw new Error(translate("素材无法完整连接到编辑节点，请重新操作"));
          assertReferences(); flow.addEdges(connections.map(connection => ({ ...connection!, id: crypto.randomUUID() })));
          flow.removeSelectedElements(); flow.addSelectedNodes([created]);
        } catch (error) { if (created && flow.findNode(id) === created) flow.removeNodes(id, true, false); throw error; }
      });
      assertSource?.(); committed = true; state.visible = false;
      if (!signal.aborted && created && flow.findNode(created.id) === created) await flow.fitView({ nodes: [created.id], padding: 0.4, maxZoom: 1, duration: 200 });
    } catch (error) {
      if (!committed && created && flow.findNode(created.id) === created) flow.removeNodes(created.id, true, false);
      if (!signal.aborted) options.onError(error);
    }
    finally { state.preparing = false; }
  }
  const extension: CanvasToolExtension = { available: tool => Boolean(videoIntent(tool) && usable() && (tool === "video:retake-segment" ? remakeAvailable.value : videoEditModels(registry?.models.value.length ? registry.models.value : state.models).length)), ready: tool => Boolean(videoIntent(tool) && usable()), run: (tool, context) => open(tool, context.assertCurrent) };
  return { state, extension, open, close, prepare, chooseModel, references, selectedReferences, choices, choice, durations, resolutions, inherited, canPrepare, busy, modelError, modelHelp, promptError, modelKey,
    get remakeAvailable() { return remakeAvailable.value; }, definition: computed(() => videoIntent(state.intent)!), defaultHint: "视频模型会重新生成画面，未提及的内容和声音也可能改变。先准备编辑节点，确认后再生成。" };
}
export type VideoIntentController = ReturnType<typeof useVideoIntentActions>;
