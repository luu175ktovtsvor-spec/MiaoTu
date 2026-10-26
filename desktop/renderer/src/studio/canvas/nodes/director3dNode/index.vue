<template>
  <nodeSkeleton v-bind="nodeProps" style="width: 320px">
    <button v-loading="modelLoading" type="button" class="directorContent nopan" :style="{ aspectRatio }" :disabled="modelLoading" :title="modelError || undefined" :aria-label="translate('打开导演台')" @dblclick.stop @click.stop="openEditor">
      <img v-if="preview" class="scenePreview" :src="preview" :alt="translate('最后镜头')" draggable="false" />
      <div v-else class="emptyPreview">
        <icon-cube3d-sphere :size="38" stroke="1.2" />
      </div>
    </button>
  </nodeSkeleton>
  <sceneEditor v-if="editing" v-model:anchors="anchors" v-model:prompt="prompt" v-model:model="model" v-model:lighting="lighting" v-model:sceneSettings="sceneSettings" v-model:aspectRatio="aspectRatio"
    :scene="scene" :result="selectedPlan" :models="models" :modelsLoading="modelsLoading" :addingMannequin="addingMannequin"
    :plans="plans" :selectedPlanId="data.selectedPlanId ?? ''" :tasks="tasks"
    :exportingVideo="exportingVideo" :exportingImage="exportingImage" :exportProgress="exportProgress"
    @exportVideo="exportVideo" @exportImage="exportImage" @addMannequin="addMannequin().catch(() => {})"
    @selectPlan="data.selectedPlanId = $event" @loadModels="loadModels" @generate="generate" @editInstruction="setPrompt" @close="editing = false">
    <template #input>
      <referenceItem v-if="refList.length" v-model="refList" @preview="setReferencePreview" @remove="removeReference" />
      <promptInput v-model="promptModel" v-model:text="prompt" :references="referenceMentions" />
    </template>
  </sceneEditor>
</template>

<script setup lang="ts">
import { isNodeOutput, type NodeOutput } from "@miaoimg/nodes-scaffold/values";
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { useVueFlow } from "@vue-flow/core";
import { IconCube3dSphere } from "@tabler/icons-vue";
import { translate } from "@miaoimg/i18n/vue";
import { ElLoading, ElMessage } from "element-plus";
import { nodeSkeleton, nodeTools, useNode, uploadNodeFile, useNodeReferences, z, type NodeHandle, type NodeData, type NodeAiModel } from "@miaoimg/nodes-scaffold/runtime";
import promptInput from "@miaoimg/nodes-scaffold/promptInput";
import referenceItem from "@miaoimg/nodes-scaffold/referenceItem";
import sceneEditor from "./sceneEditor.vue";
import { capturePreview, cameraViewSchema, sceneSchema, createEmptyScene, createMannequinObject, createStage, disposeStage, getSceneLighting, type LightingSettings, type SceneDocument, type SceneSettings } from "./scene";
import { createDirectorDraft, operationSchema } from "./agentTools";
import { directorPrompt } from "./agentPrompt";
import { anchorSchema, prepareMotion, sampleMotion, type CameraAnchor } from "./motion";
import { directorPlanSchema, prepareSceneAnimation, type DirectorPlan, type DirectorGeneration } from "./sceneAnimation";
import { renderImage, renderVideo, inspectScene } from "./renderMedia";
import { beginMediaExport } from "../../scaffold/mediaExport";
import { captureMediaPublication } from "../../scaffold/mediaPublication";
import type { CanvasMediaTask } from "../../../../../../canvas-delivery.ts";

type PromptModel = NonNullable<InstanceType<typeof promptInput>["$props"]["modelValue"]>;
const modelDocumentSchema = z.strictObject({
  version: z.literal(1),
  scene: sceneSchema,
  plans: z.array(directorPlanSchema.safeExtend({ id: z.string().min(1), instruction: z.string().optional() })),
});
type ModelDocument = z.infer<typeof modelDocumentSchema>;
defineOptions({
  inheritAttrs: false,
  icon: IconCube3dSphere,
  handles: [{ id: "in", type: "target", dataType: ["STRING", "IMAGE", "VIDEO"], label: "文本、图片、视频输入" }] satisfies NodeHandle[],
});
const { node, nodeProps, previewReady, ai, files, nodeEvent } = useNode({ label: "导演台" });
const vLoading = ElLoading.directive;
const { addNodes, findNode, getNodes, nodeTypes, removeNodes } = useVueFlow();
const exportingVideo = ref(false);
const exportingImage = ref("");
const exportProgress = ref(0);
const exportController = new AbortController();
nodeEvent.on("delete", () => { if (exportingVideo.value || exportingImage.value) throw new Error(translate("正在导出，请完成后再删除导演节点")); });
const data = computed(() => node.data as typeof node.data & {
  modelPath?: string;
  modelSnapshot?: ModelDocument;
  lighting?: LightingSettings;
  sceneSettings?: SceneSettings;
  prompt?: string;
  promptModel?: PromptModel;
  model?: string;
  anchors?: CameraAnchor[];
  selectedPlanId?: string;
  aspectRatio?: string;
});
const { refList, referenceMentions, preparePromptReferences, setReferencePreview, removeReference } = useNodeReferences();
const promptModel = computed({ get: () => data.value.promptModel ?? [], set: (value: PromptModel) => { data.value.promptModel = value; } });
const anchors = computed({ get: () => data.value.anchors ?? [], set: (value: CameraAnchor[]) => { data.value.anchors = value; } });
const prompt = computed({ get: () => data.value.prompt ?? "", set: (value: string) => { data.value.prompt = value; } });
const model = computed({ get: () => data.value.model ?? "", set: (value: string) => { data.value.model = value; } });
// ACT: 场景和动画只在节点内部持有，画布数据仅保存文件引用，避免拖动时遍历大量关键帧。
const modelDocument = shallowRef<ModelDocument>({ version: 1, scene: createEmptyScene(), plans: [] });
const plans = computed(() => modelDocument.value.plans);
const selectedPlan = computed(() => plans.value.find(plan => plan.id === data.value.selectedPlanId));
const scene = computed(() => modelDocument.value.scene);
const lighting = computed({ get: () => ({ ...getSceneLighting(scene.value), ...data.value.lighting }), set: (value: LightingSettings) => { data.value.lighting = value; } });
const sceneSettings = computed({ get: () => ({ gridVisible: true, skyVisible: true, ...data.value.sceneSettings }), set: (value: SceneSettings) => { data.value.sceneSettings = value; } });
const aspectRatioSchema = z.enum(["16:9", "9:16", "4:3", "1:1"]);
const aspectRatio = computed({
  get: () => aspectRatioSchema.safeParse(data.value.aspectRatio).data ?? "16:9",
  set: (value: string) => { data.value.aspectRatio = aspectRatioSchema.parse(value); },
});
const sceneAspect = computed(() => {
  const [width, height] = aspectRatio.value.split(":").map(Number);
  return width! / height!;
});
const editing = ref(false);
const tasks = ref<DirectorGeneration[]>([]);
const modelsLoading = ref(false);
const models = ref<NodeAiModel[]>([]);
const selectedModel = computed(() => models.value.find(item => JSON.stringify([item.providerId, item.modelId]) === model.value));
const preview = ref("");
let previewVersion = 0;
const modelLoading = ref(true);
const modelError = ref("");
const addingMannequin = ref(false);
let modelSaving = Promise.resolve();
let modelFileRevision: string | null = null;
let disposed = false;
const generationControllers = new Set<AbortController>();
onBeforeUnmount(() => { disposed = true; exportController.abort(new Error(translate("导演节点已关闭，导出已停止"))); generationControllers.forEach(controller => controller.abort()); });

function getModelPath() {
  if (!node.id || /[\\/]/.test(node.id) || node.id === "." || node.id === "..") throw new Error(translate("节点 ID 不能作为文件夹名称"));
  return `assets/${node.id}/model.json`;
}

async function writeModel(workspaceFiles: ReturnType<typeof files.getWorkspaceFiles>, value: ModelDocument) {
  const path = getModelPath();
  const content = JSON.stringify(value);
  try {
    modelFileRevision = await workspaceFiles.writeText(path, content, modelFileRevision);
  } catch (error) {
    const status = (error as { response?: { status?: number } }).response?.status;
    if (status !== 409) throw error;
    // 新节点迁移可能已写入却没收到回执；只确认完全相同的内容，绝不覆盖已有不同模型。
    if (modelFileRevision === null) {
      const snapshot = await workspaceFiles.readTextSnapshot(path);
      if (snapshot.text === content) { modelFileRevision = snapshot.revision; return path; }
      throw new Error(translate("节点目录已有不同的模型文件，未覆盖；请保留当前画布后检查模型文件"));
    }
    modelError.value = translate("导演台模型已在其他页面修改，本次未覆盖；请重新打开导演台加载最新内容");
    throw new Error(modelError.value);
  }
  return path;
}

async function loadModel() {
  modelLoading.value = true;
  modelError.value = "";
  try {
    const { modelPath, modelSnapshot } = data.value;
    if (!modelPath && !modelSnapshot) return;
    const workspaceFiles = files.getWorkspaceFiles();
    if (modelPath && modelPath !== getModelPath()) throw new Error(translate("导演台模型文件路径无效"));
    const snapshot = modelPath && !modelSnapshot ? await workspaceFiles.readTextSnapshot(modelPath) : undefined;
    const value = modelDocumentSchema.parse(modelSnapshot ?? JSON.parse(snapshot!.text));
    if (disposed) return;
    modelFileRevision = snapshot?.revision ?? null;
    // 复制、跨画布粘贴时只传递一次快照，写入新节点目录成功后才移除快照。
    if (modelSnapshot) {
      const path = await writeModel(workspaceFiles, value);
      if (disposed) return;
      data.value.modelPath = path;
      delete data.value.modelSnapshot;
    }
    modelDocument.value = value;
    if (!selectedPlan.value) data.value.selectedPlanId = value.plans[0]?.id;
  } catch (error) {
    modelError.value = error instanceof Error ? error.message : translate("模型文件读取失败");
    if (!disposed) ElMessage.error(translate("导演台加载失败：{0}", { 0: modelError.value }));
  } finally {
    modelLoading.value = false;
  }
}

let modelReady = loadModel();
function ensureModelLoaded(retry = false) {
  if (retry && modelError.value) modelReady = loadModel();
  return modelReady;
}
async function openEditor() {
  await ensureModelLoaded(true);
  if (!disposed && !modelError.value) editing.value = true;
}

function assertDirectorIdle(signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (disposed || modelLoading.value || modelError.value) throw new Error(modelError.value || '导演台尚未就绪');
  if (addingMannequin.value || exportingVideo.value || exportingImage.value || tasks.value.some(task => !task.error)) throw new Error('导演台正在生成或导出，请等待完成');
}
async function addMannequin(signal?: AbortSignal) {
  await modelReady;
  assertDirectorIdle(signal);
  addingMannequin.value = true;
  const object = createMannequinObject(crypto.randomUUID());
  try {
    const workspaceFiles = files.getWorkspaceFiles();
    const saving = modelSaving.then(async () => {
      signal?.throwIfAborted();
      if (disposed) throw new Error('导演节点已关闭');
      const current = scene.value;
      const mannequins = current.objectList.filter(item => item.objType === "mannequin");
      object.position.x = mannequins.length ? Math.max(...mannequins.map(item => item.position.x)) + 1 : 0;
      const nextScene: SceneDocument = { ...current, objectList: [...current.objectList, object] };
      if (!current.objectList.length) {
        nextScene.sceneConfig = {
          ...current.sceneConfig,
          camera: { ...current.sceneConfig.camera, position: { x: 3, y: 2.2, z: 4 } },
          controls: { target: { x: 0, y: 0.9, z: 0 } },
        };
      }
      const value: ModelDocument = { ...modelDocument.value, scene: sceneSchema.parse(nextScene) };
      const path = await writeModel(workspaceFiles, value);
      if (disposed) throw new Error('导演节点已关闭');
      modelDocument.value = value;
      data.value.modelPath = path;
    });
    modelSaving = saving.catch(() => {});
    await saving;
    return { object: JSON.parse(JSON.stringify(object)), objectCount: scene.value.objectList.length };
  } catch (error) {
    if (!disposed) ElMessage.error(error instanceof Error ? error.message : translate("人偶添加失败"));
    throw error;
  } finally {
    addingMannequin.value = false;
  }
}

nodeEvent.on("copy", async () => {
  await nodeEvent.emit("save");
  if (modelError.value) throw new Error(translate("导演台当前无法复制：{0}", { 0: modelError.value }));
  return { modelPath: undefined, modelSnapshot: modelDocument.value };
});

nodeEvent.on("save", async (reason) => {
  await modelReady;
  let pending: Promise<void>;
  do {
    pending = modelSaving;
    await pending;
  } while (pending !== modelSaving);
  if (reason === "reload" && (exportingVideo.value || exportingImage.value || tasks.value.some(task => !task.error))) {
    throw new Error(translate("导演台正在生成或导出，请完成后再刷新节点"));
  }
});

async function exportToCanvas(kind: "image" | "video", key: string, aspect: number, render: (signal: AbortSignal) => Promise<File>, externalSignal?: AbortSignal) {
  const operation = new AbortController();
  const signal = AbortSignal.any([operation.signal, exportController.signal, ...(externalSignal ? [externalSignal] : [])]);
  signal.throwIfAborted();
  if (kind === "video" ? exportingVideo.value : exportingImage.value) return;
  const type = `remote-${kind}Node`;
  if (!nodeTypes?.value?.[type]) return void ElMessage.error(translate("请先启用{0}节点插件", { 0: kind === "image" ? translate("图片") : translate("视频") }));
  if (kind === "video") { exportingVideo.value = true; exportProgress.value = 0; }
  else exportingImage.value = key;
  const id = crypto.randomUUID();
  let exportNode: ReturnType<typeof findNode<NodeData & CanvasMediaTask>>;
  let exportLease: ReturnType<typeof beginMediaExport> | undefined;
  let checkExportPublication: ReturnType<typeof captureMediaPublication> | undefined;
  let discarded = false;
  let uploadedPath: string | undefined;
  let stopWatching = () => {};
  let workspaceFiles: ReturnType<typeof files.getWorkspaceFiles> | undefined;
  function ownsPlaceholder() {
    if (!exportNode || !checkExportPublication || findNode(id) !== exportNode || exportLease && !exportLease.owns()) return false;
    try { checkExportPublication?.(); return true; }
    catch { return false; }
  }
  function addExportNode(label: string) {
    // 素材在弹窗后方加载时，节点可能仍只有占位尺寸。提前保留最终预览和标题的空间，
    // 并随节点保存，重开画布后继续导出也不能把新素材压在旧素材上。
    const width = kind === "image" ? 360 * aspect + 2 : Math.min(640, Math.max(240, 240 * aspect));
    const height = (kind === "image" ? 362 : width / aspect) + 48;
    const x = node.computedPosition.x + (node.dimensions.width || 320) + 80;
    let y = node.computedPosition.y;
    for (const other of [...getNodes.value].sort((a, b) => a.computedPosition.y - b.computedPosition.y)) {
      const position = other.computedPosition;
      const reservedData = other.data as NodeData & { directorExportSize?: { width: number; height: number }; mediaExportSize?: { width: number; height: number } };
      const reserved = reservedData.mediaExportSize || reservedData.directorExportSize;
      const otherWidth = Math.max(other.dimensions.width || 320, reserved?.width || 0);
      const otherHeight = Math.max(other.dimensions.height || 300, reserved?.height || 0);
      if (position.x < x + width && position.x + otherWidth > x && position.y < y + height && position.y + otherHeight > y) {
        y = position.y + otherHeight + 32;
      }
    }
    addNodes({ id, type, position: { x, y }, data: { label, outputs: {}, directorExportSize: { width, height } } });
    return findNode<NodeData & CanvasMediaTask>(id)!;
  }
  try {
    workspaceFiles = files.getWorkspaceFiles();
    if (kind === "video") {
      exportNode = addExportNode(selectedPlan.value?.name ?? "视频");
      exportLease = beginMediaExport(exportNode, () => exportProgress.value);
      checkExportPublication = captureMediaPublication(exportNode, findNode, () => exportNode!.data.outputs);
      stopWatching = watch(() => [findNode(id), exportNode?.type, exportNode?.data.outputs, exportNode?.data.taskRequestId,
        exportNode?.data.taskOutputPath, exportNode?.data.taskExtraNodeIds], () => {
        if (!ownsPlaceholder()) {
          discarded = true;
          operation.abort(new Error(translate("导出节点已变化，原素材已保留")));
        }
      }, { deep: true, flush: "sync" });
    }
    const file = await render(signal);
    signal.throwIfAborted();
    if (discarded) return;
    const path = await uploadNodeFile(workspaceFiles, id, file, undefined, signal, receipt => { uploadedPath = receipt.path; });
    uploadedPath = path;
    signal.throwIfAborted();
    if (discarded) return;
    if (findNode(node.id) !== node || !nodeTypes?.value?.[type]) throw new Error(translate("画布节点已变化，请重新导出"));
    if (!exportNode) {
      exportNode = addExportNode(file.name.replace(/\.[^.]+$/, ""));
      checkExportPublication = captureMediaPublication(exportNode, findNode, () => exportNode!.data.outputs);
    }
    if (!ownsPlaceholder()) throw new Error(translate("导出节点已变化，原素材已保留"));
    stopWatching();
    // 更新已有输出对象，让已挂载的视频节点及连接它的节点同步收到结果。
    (exportNode.data.outputs ??= {})[kind] = {
      dataType: kind === "image" ? "IMAGE" : "VIDEO", value: { url: path, mimeType: file.type },
    };
    if (kind === "video") exportProgress.value = 100;
    ElMessage.success(translate("{0}已导出到画布", { 0: kind === "image" ? translate("图片") : translate("视频") }));
    return { ok: true as const, nodeId: id, path, mimeType: file.type, aspect };
  } catch (error) {
    const detail = error instanceof Error ? error.message : translate("导出失败，请重试");
    const message = uploadedPath ? `${detail}；${translate("素材已保留")}：${uploadedPath}` : detail;
    if (!disposed && !discarded) ElMessage.error(message);
    if (ownsPlaceholder()) removeNodes(id);
    return { ok: false as const, error: message,
      ...(uploadedPath ? { savedPath: uploadedPath } : {}) };
  } finally {
    stopWatching();
    exportLease?.finish();
    // A completed upload is user material even if its node was subsequently
    // changed. The file API owns incomplete staging; never remove this tree.
    if (kind === "video") exportingVideo.value = false;
    else exportingImage.value = "";
  }
}

function exportVideo(aspect: number) {
  const plan = selectedPlan.value;
  if (!plan) return;
  return exportToCanvas("video", "video", aspect, signal => renderVideo(scene.value, plan, aspect, signal, value => { exportProgress.value = value; }, lighting.value, sceneSettings.value));
}

function exportImage(anchor: CameraAnchor, aspect: number, time: number, signal?: AbortSignal) {
  const name = `关键帧${anchors.value.findIndex(item => item.id === anchor.id) + 1}`;
  return exportToCanvas("image", anchor.id, aspect, async signal => {
    const file = await renderImage(scene.value, anchor, aspect, time, signal, selectedPlan.value, lighting.value, sceneSettings.value);
    return new File([file], `${name}.png`, { type: file.type });
  }, signal);
}

async function loadModels() {
  if (modelsLoading.value) return;
  modelsLoading.value = true;
  try {
    await refreshModels();
  } catch (error) {
    if (!disposed) ElMessage.error(error instanceof Error ? error.message : translate("模型加载失败"));
  } finally {
    modelsLoading.value = false;
  }
}

async function refreshModels() {
  const available = await ai.getModels({ tools: true });
  if (disposed) throw new Error("导演台已关闭");
  models.value = available;
  // 首次使用按实时目录默认值选择；已选模型失效时不偷偷换模型。
  if (!model.value && available[0]) model.value = JSON.stringify([available[0].providerId, available[0].modelId]);
  return available;
}

async function renderPreview(scene: SceneDocument, plan: DirectorPlan | undefined, lighting: LightingSettings, settings: SceneSettings, aspect = sceneAspect.value) {
  const runtime = await createStage(document.createElement("canvas"), scene, undefined, aspect, lighting, settings);
  let player: ReturnType<typeof prepareSceneAnimation> | undefined;
  try {
    if (plan) {
      player = prepareSceneAnimation(runtime, plan);
      player.setTime(plan.duration);
      sampleMotion(runtime.camera, prepareMotion(plan.cameraFrames), plan.duration);
    }
    return capturePreview(runtime);
  } finally {
    player?.dispose();
    disposeStage(runtime);
  }
}

const planPreviews = new WeakMap<DirectorPlan, { scene: SceneDocument; lighting: LightingSettings; settings: SceneSettings; aspect: number; image: string }>();
let previewWork: Promise<string> | undefined;
watch([scene, selectedPlan, lighting, sceneSettings, modelLoading, previewReady, sceneAspect, editing], async ([value, plan, light, settings, loading, ready, aspect, editorOpen]) => {
  const version = ++previewVersion;
  if (!ready || loading || modelError.value) { preview.value = ""; return; }
  // The editor already renders this scene. Refresh its covered thumbnail once
  // on close instead of creating a second renderer for each lighting change.
  if (editorOpen) return;
  try {
    // A superseded WebGL initialization still owns resources until it settles.
    // Wait for it, then render only the latest pending state for this node.
    await previewWork?.catch(() => {});
    if (disposed || version !== previewVersion) return;
    const cached = plan && planPreviews.get(plan);
    previewWork = cached?.scene === value && cached.aspect === aspect && JSON.stringify(cached.lighting) === JSON.stringify(light) && JSON.stringify(cached.settings) === JSON.stringify(settings) ? Promise.resolve(cached.image) : renderPreview(value, plan, light, settings, aspect);
    const image = await previewWork;
    if (plan) planPreviews.set(plan, { scene: value, lighting: light, settings, aspect, image });
    if (!disposed && version === previewVersion) preview.value = image;
  } catch (error) {
    if (!disposed && version === previewVersion) ElMessage.error(error instanceof Error ? error.message : translate("预览生成失败"));
  }
}, { immediate: true });

function setPrompt(value: string) {
  prompt.value = value;
  promptModel.value = value ? value.split("\n").map(text => [{ type: "Write", text }]) : [];
}

type DirectorRunOutcome = { ok: boolean; error?: string; planId?: string; sceneChanged?: boolean; objects?: number };
async function generate(externalSignal?: AbortSignal): Promise<DirectorRunOutcome> {
  await modelReady;
  externalSignal?.throwIfAborted();
  try { await refreshModels(); } catch (error) { return { ok: false, error: error instanceof Error ? error.message : translate("模型加载失败") }; }
  if (modelLoading.value || modelError.value || addingMannequin.value) return { ok: false, error: translate("导演台正在加载或已被其他操作占用，请稍后再试") };
  const choice = selectedModel.value;
  if (!choice) return { ok: false, error: translate("请先在导演台里选择用于规划的模型") };
  try { preparePromptReferences(); } catch (error) {
    const message = error instanceof Error ? error.message : translate("提示词参考无效");
    ElMessage.error(message);
    return { ok: false, error: message };
  }
  const requirement = prompt.value.trim();
  if (!requirement) return { ok: false, error: translate("请先输入提示词") };
  if (refList.value.some(item => item.value === undefined)) {
    const message = translate("引用节点暂无内容，请先补充引用内容");
    ElMessage.error(message);
    return { ok: false, error: message };
  }
  // 首次创建基础模型期间只接收一个请求，后续动画可并行生成。
  if (!scene.value.objectList.length && tasks.value.some(task => !task.error)) return { ok: false, error: translate("上一个任务还在生成，请稍后再试") };
  const baseScene = scene.value;
  const basePlanId = data.value.selectedPlanId ?? "";
  const task = { id: crypto.randomUUID(), instruction: requirement, status: translate("正在连接 Agent…") };
  const controller = new AbortController();
  const cancel = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) cancel();
  else externalSignal?.addEventListener("abort", cancel, { once: true });
  generationControllers.add(controller);
  const setStatus = (status: string) => { if (!disposed) tasks.value = tasks.value.map(item => item.id === task.id ? { ...item, status } : item); };
  let toolError = "";
  tasks.value = [...tasks.value, task];
  setPrompt("");
  try {
    const workspaceFiles = files.getWorkspaceFiles();
    const mediaReferences = refList.value
      .filter((item): item is typeof item & Extract<NodeOutput, { dataType: "STRING" | "IMAGE" | "VIDEO" }> => isNodeOutput(item) && (item.dataType === "STRING" || item.dataType === "IMAGE" || item.dataType === "VIDEO"))
      .map(item => item.dataType === "STRING" ? { dataType: item.dataType, value: item.value } : { dataType: item.dataType, value: { ...item.value } });
    const references = anchors.value.map((value, index) => {
      const { camera, controls } = anchorSchema.parse(value);
      return { order: index + 1, camera, controls };
    });
    const basePlan = selectedPlan.value;
    const draft = createDirectorDraft(
      JSON.parse(JSON.stringify(baseScene)),
      basePlan ? directorPlanSchema.parse({ name: basePlan.name, duration: basePlan.duration, tracks: basePlan.tracks, cameraFrames: basePlan.cameraFrames }) : undefined,
      JSON.parse(JSON.stringify(plans.value)),
    );
    const directory = mediaReferences.some(item => item.dataType !== "STRING") ? (await workspaceFiles.list()).directory : undefined;
    if (disposed) return;
    await ai.generate({
      references: mediaReferences,
      providerId: choice.providerId,
      modelId: choice.modelId,
      systemPrompt: directorPrompt,
      prompt: JSON.stringify({ instruction: requirement, references, selectedPlanId: basePlanId, document: draft.summary() }),
      directory,
      tools: [...draft.tools, {
        name: "inspectDocument",
        description: "查看当前草稿的真实渲染画面，按 timestamps 采样 1–4 个时刻。先用 editDocument 补齐合法方案。检查人物数量、构图、关节姿态、朝向和参考动作的差异，必要时继续修改；每次修改后重新回看。仅本机渲染，不调用图片或视频生成模型。",
        parameters: z.toJSONSchema(z.strictObject({ timestamps: z.array(z.number().min(0)).min(1).max(4) })),
        execute(args, signal) {
          const { timestamps } = z.strictObject({ timestamps: z.array(z.number().min(0)).min(1).max(4) }).parse(args);
          const { scene, plan } = draft.read();
          return inspectScene(scene, plan, timestamps, sceneAspect.value, signal, { ...getSceneLighting(scene), ...data.value.lighting }, sceneSettings.value);
        },
      }],
      signal: controller.signal,
      onEvent(event) {
        if (event.type === "status") setStatus(translate(event.message));
        else if (event.type === "text" || event.type === "reasoning") setStatus(translate("Agent 正在规划下一步…"));
        else if (event.type === "toolStart") setStatus(translate(event.name === "editDocument" ? "正在修改场景与动画…" : "正在读取与校验草稿…"));
        else if (event.type === "toolEnd") {
          if (event.isError) toolError = String(event.result || translate("工具执行失败"));
          setStatus(event.isError ? translate("工具返回原因，Agent 正在修正…") : translate("草稿操作完成，继续校验…"));
        }
      },
    });
    if (disposed) return;
    if (!draft.edited) throw new Error(toolError ? translate("草稿修改失败：{0}", { 0: toolError }) : translate("模型本轮没有调用 editDocument 修改草稿，请重试。"));
    const result = draft.read();
    setStatus(translate("正在渲染动画预览…"));
    const nextScene = draft.sceneChanged ? result.scene : baseScene;
    const plan = { ...result.plan, id: task.id, instruction: requirement };
    // 工具仅编辑草稿；完成后验证实际渲染，成功落盘才替换当前方案。
    const previewLighting = { ...getSceneLighting(nextScene), ...data.value.lighting };
    const previewSettings = sceneSettings.value;
    const previewAspect = sceneAspect.value;
    const image = await renderPreview(nextScene, plan, previewLighting, previewSettings, previewAspect);
    if (disposed) return;
    // 动画请求可以并行生成，同一模型文件顺序保存，写入成功后才替换当前场景。
    const saving = modelSaving.then(async () => {
      if (disposed) return;
      if (scene.value !== baseScene) throw new Error(translate("基础模型已被另一条指令更新，请基于当前模型重试。"));
      const objects = new Map(nextScene.objectList.map(object => [object.threeJsonId, object]));
      const previousPlans = draft.sceneChanged
        ? plans.value.map(item => ({ ...item, tracks: item.tracks.filter(track => objects.has(track.objectId) && (!track.joint || objects.get(track.objectId)?.objType === "mannequin")) }))
        : plans.value;
      const value: ModelDocument = { version: 1, scene: nextScene, plans: [...previousPlans, plan] };
      setStatus(translate("正在保存场景与动画方案…"));
      const path = await writeModel(workspaceFiles, value);
      if (disposed) return;
      planPreviews.set(plan, { scene: nextScene, lighting: previewLighting, settings: previewSettings, aspect: previewAspect, image });
      modelDocument.value = value;
      data.value.modelPath = path;
      if ((data.value.selectedPlanId ?? "") === basePlanId) data.value.selectedPlanId = plan.id;
    });
    modelSaving = saving.catch(() => {});
    await saving;
    tasks.value = tasks.value.filter(item => item.id !== task.id);
    return { ok: true, planId: plan.id, sceneChanged: draft.sceneChanged, objects: nextScene.objectList.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : translate("生成失败，请重试");
    if (!disposed) {
      tasks.value = tasks.value.map(item => item.id === task.id ? { ...item, error: message } : item);
      // Preserve the failed instruction without replacing a newer draft the user is typing.
      if (!prompt.value.trim()) setPrompt(requirement);
    }
    return { ok: false, error: message };
  } finally {
    externalSignal?.removeEventListener("abort", cancel);
    generationControllers.delete(controller);
  }
}

// ── 给画布 Agent 的节点能力 ────────────────────────────────────────────────
// 节点自己的 AI 流程走的是内存草稿（createDirectorDraft 的 readDocument / editDocument，
// 改完立刻渲染校验）；画布 Agent 不在那条流程里，所以这里把同一份「校验过的编辑器」
// 接到**已经落盘**的文档上：读现状、批量改场景与动画方案、写提示词、触发导演台自己的生成。
// 注册后以 node:<名字> 暴露给 Agent（见 scaffold/nodeTools.ts）。

function sceneSnapshot(): SceneDocument { return JSON.parse(JSON.stringify(scene.value)) as SceneDocument; }
nodeTools.register({
  name: 'setDirectorEditor', description: '打开或关闭此导演台编辑器；模型文件加载失败或保存冲突后，重新打开可加载最新内容再继续编辑。打开后重新 getNodeTools 可发现 controlDirectorView，用于操作当前预览镜头、播放进度和捕捉关键帧。不调用模型。',
  parameters: z.strictObject({ open: z.boolean() }),
  async execute({ open }, { signal }) {
    signal?.throwIfAborted();
    await ensureModelLoaded(open); assertDirectorIdle(signal);
    editing.value = open;
    await nextTick(); signal?.throwIfAborted();
    return { editorOpen: editing.value };
  },
});
nodeTools.register({
  name: 'addDirectorMannequin', description: '在现有 3D 场景中添加内置关节人偶，复用界面添加人偶功能；没有动画方案也能使用。不调用模型。',
  parameters: z.strictObject({}), execute(_args, { signal }) { return addMannequin(signal); },
});
nodeTools.register({
  name: 'setDirectorOptions', description: '设置导演台实际预览和导出共用的灯光、网格及天空；省略字段保持原值。当前值用 readDirector 读取。不调用模型。',
  parameters: z.strictObject({
    lighting: z.strictObject({ globalEnabled: z.boolean().optional(), globalIntensity: z.number().min(0).max(100).optional(), sunEnabled: z.boolean().optional(), azimuth: z.number().min(0).max(360).optional(), elevation: z.number().min(-90).max(90).optional(), color: z.string().regex(/^#[\da-f]{6}$/i).optional(), intensity: z.number().min(0).max(100).optional() }).optional(),
    settings: z.strictObject({ gridVisible: z.boolean().optional(), skyVisible: z.boolean().optional() }).optional(),
  }),
  async execute(args, { signal }) {
    await modelReady; assertDirectorIdle(signal);
    if (args.lighting) lighting.value = { ...lighting.value, ...args.lighting };
    if (args.settings) sceneSettings.value = { ...sceneSettings.value, ...args.settings };
    return { lighting: lighting.value, settings: sceneSettings.value };
  },
});
nodeTools.register({
  name: 'selectDirectorPlan', description: '切换到已保存的导演动画方案，planId 必须来自 readDirector 返回的 plans；保留其他历史方案，不重新生成。',
  parameters: z.strictObject({ planId: z.string().min(1).max(100) }),
  async execute({ planId }, { signal }) {
    await modelReady; assertDirectorIdle(signal);
    if (!plans.value.some(plan => plan.id === planId)) throw new Error('历史方案不存在，请重新读取');
    data.value.selectedPlanId = planId;
    return { selectedPlanId: planId, plan: JSON.parse(JSON.stringify(selectedPlan.value)) };
  },
});
nodeTools.register({
  name: 'editDirectorAnchors', description: '管理导演台参考镜头关键帧：add 新增（不传 view 使用已保存场景镜头，捕捉编辑器当前镜头用 controlDirectorView）；update/remove 使用已有 anchorId；reorder 提供全部现有 anchorIds 的新顺序。view 采用真实 camera/controls 结构，time 为秒；不生成动画。',
  parameters: z.strictObject({ action: z.enum(['add','update','remove','reorder']), anchorId: z.string().min(1).optional(), anchorIds: z.array(z.string().min(1)).max(100).optional(), view: cameraViewSchema.optional(), time: z.number().min(0).max(300).optional() }),
  async execute(args, { signal }) {
    await modelReady; assertDirectorIdle(signal);
    const current = anchors.value;
    let changed: CameraAnchor | undefined;
    if (args.action === 'reorder') {
      const ids = args.anchorIds;
      if (!ids || ids.length !== current.length || new Set(ids).size !== ids.length || ids.some(id => !current.some(anchor => anchor.id === id))) throw new Error('anchorIds 必须包含全部现有关键帧且不重复');
      anchors.value = ids.map(id => current.find(anchor => anchor.id === id)!);
    } else if (args.action === 'add') {
      if (current.length >= 100) throw new Error('最多记录 100 个关键帧');
      changed = anchorSchema.parse({ ...(args.view ?? scene.value.sceneConfig), time: args.time ?? 0 });
      anchors.value = [...current, changed];
    } else {
      const anchor = current.find(anchor => anchor.id === args.anchorId);
      if (!anchor) throw new Error('关键帧不存在，请先 readDirector');
      if (args.action === 'remove') anchors.value = current.filter(item => item.id !== anchor.id);
      else {
        changed = anchorSchema.parse({ ...anchor, ...args.view, time: args.time ?? anchor.time });
        anchors.value = current.map(item => item.id === anchor.id ? changed! : item);
      }
    }
    return { anchor: changed, anchorIds: anchors.value.map(anchor => anchor.id), count: anchors.value.length };
  },
});
nodeTools.register({
  name: 'exportDirectorImage', description: '将一个已有导演关键帧按当前灯光、天空、比例和可选动画时间渲染为 PNG，并添加到画布。anchorId 来自 readDirector；没有动画方案也可导出静态场景。不调用图片或视频模型。',
  parameters: z.strictObject({ anchorId: z.string().min(1), time: z.number().min(0).max(300).optional() }),
  async execute({ anchorId, time }, { signal }) {
    await modelReady; assertDirectorIdle(signal);
    const anchor = anchors.value.find(anchor => anchor.id === anchorId);
    if (!anchor) throw new Error('关键帧不存在，请先读取导演台');
    const position = time ?? anchor.time ?? 0;
    if (selectedPlan.value && position > selectedPlan.value.duration) throw new Error('时间超过当前方案时长');
    const result = await exportImage(anchor, sceneAspect.value, position, signal);
    if (!result) throw new Error('关键帧导出未完成');
    if (result.ok === false) throw new Error(result.error || '关键帧导出未完成');
    return result;
  },
});
nodeTools.register({
  name: "exportDirectorVideo",
  description: "将已保存的当前白模方案在本机渲染为 MP4，并放入新的画布视频节点。沿用已保存画面比例，无需视频生成模型。导出耗时接近片长，窗口需保持可见；返回实际文件路径和节点 ID。",
  parameters: z.strictObject({}),
  async execute(_args, { signal }) {
    await modelReady;
    if (modelError.value) throw new Error(modelError.value);
    if (exportingVideo.value || exportingImage.value || tasks.value.some(task => !task.error)) throw new Error("导演台正在生成或导出，请等待当前任务完成");
    const plan = selectedPlan.value;
    if (!plan) throw new Error("当前导演台还没有可导出的动画方案");
    const aspect = sceneAspect.value;
    const result = await exportToCanvas("video", "video", aspect, renderSignal => renderVideo(sceneSnapshot(), plan, aspect, renderSignal, value => { exportProgress.value = value; }, lighting.value, sceneSettings.value), signal);
    if (!result) throw new Error("导出已取消，未创建视频");
    if (result.ok === false) throw new Error(result.error || "导出已取消，未创建视频");
    return { ...result, duration: plan.duration };
  },
});
nodeTools.register({
  name: "setDirectorAspect",
  description: "设置并保存导演台画面比例，预览、回看和导出共用这个比例。不改变动画、素材或镜头参数。",
  parameters: z.strictObject({ aspectRatio: aspectRatioSchema }),
  execute(args) { aspectRatio.value = args.aspectRatio; return { aspectRatio: aspectRatio.value }; },
});
nodeTools.register({
  name: "getDirectorModels",
  description: "读取当前管理员开放、当前账号可用的导演台文本规划模型和当前选择。只查询配置，不调用模型。",
  parameters: z.strictObject({}),
  async execute() { const available = await refreshModels(); return { models: available, selected: selectedModel.value ?? null }; },
});
nodeTools.register({
  name: "setDirectorModel",
  description: "设置导演台使用的文本规划模型，providerId 和 modelId 必须取自 getDirectorModels 的实时结果。不发起生成。",
  parameters: z.strictObject({ providerId: z.string().min(1), modelId: z.string().min(1) }),
  async execute({ providerId, modelId }) {
    const available = await refreshModels();
    if (!available.some(item => item.providerId === providerId && item.modelId === modelId)) throw new Error("这个文本模型当前不可用，请重新读取可用模型");
    model.value = JSON.stringify([providerId, modelId]);
    return { providerId, modelId };
  },
});
nodeTools.register({
  name: "inspectScene",
  description: "查看当前导演台场景的真实渲染画面，用于核对人数、姿态、构图与参考动作。有动画时选择方案时长内的 timestamps；没有动画方案时用 [0] 查看静态场景。不调用生图或视频模型。修改后应回看，再决定是否交付。",
  parameters: z.strictObject({ timestamps: z.array(z.number().min(0)).min(1).max(4) }),
  async execute({ timestamps }, context) {
    await modelReady;
    if (modelError.value) throw new Error(modelError.value);
    const plan = selectedPlan.value;
    return inspectScene(sceneSnapshot(), plan, timestamps, sceneAspect.value, context?.signal, lighting.value, sceneSettings.value);
  },
});
function planForDraft(plan?: DirectorPlan) {
  return plan ? directorPlanSchema.parse({ name: plan.name, duration: plan.duration, tracks: plan.tracks, cameraFrames: plan.cameraFrames }) : undefined;
}

nodeTools.register({
  name: "readDirector",
  description: "读取这个 3D 导演台的现状：场景物体（人偶/道具/舞台，含稳定 ID、名称、类型与位置）、镜头与灯光、已保存的动画方案、镜头锚点和当前提示词。改之前先读；section=scene / plan 返回完整 JSON，summary（默认）只给概览；schema 返回场景、方案与编辑操作的真实 JSON Schema。现有数据等待模型文件加载后返回，读取失败会报错，可用 setDirectorEditor 重试打开。",
  parameters: z.strictObject({
    section: z.enum(["summary", "scene", "plan", "prompt", "schema"]).optional(),
    planId: z.string().min(1).max(100).optional(),
  }),
  async execute({ section = "summary", planId }, { signal }) {
    signal?.throwIfAborted();
    if (section === "schema") return { scene: z.toJSONSchema(sceneSchema), plan: z.toJSONSchema(directorPlanSchema), operation: z.toJSONSchema(operationSchema) };
    // Mounting registers tools before the saved model has finished loading.
    // Never expose the temporary empty document as the user's saved scene.
    await ensureModelLoaded();
    signal?.throwIfAborted();
    if (disposed) throw new Error(translate("导演台已关闭"));
    if (modelError.value) throw new Error(modelError.value);
    if (section === "prompt") return { prompt: prompt.value, anchors: JSON.parse(JSON.stringify(anchors.value)) };
    if (section === "scene") return { scene: sceneSnapshot() };
    if (section === "plan") {
      const plan = planId ? plans.value.find(item => item.id === planId) : selectedPlan.value;
      if (!plan) {
        if (planId) throw new Error(`没有这个方案：${planId}`);
        return { plan: null, message: "这个导演台尚未创建动画方案" };
      }
      return { plan: JSON.parse(JSON.stringify(plan)) };
    }
    return {
      prompt: prompt.value,
      anchors: JSON.parse(JSON.stringify(anchors.value)),
      objects: scene.value.objectList.map(item => ({ id: item.threeJsonId, name: item.name ?? "", type: item.objType, position: item.position })),
      camera: JSON.parse(JSON.stringify(scene.value.sceneConfig.camera)),
      lights: scene.value.sceneConfig.lights.length,
      plans: plans.value.map(item => ({ id: item.id, name: item.name, duration: item.duration, tracks: item.tracks.length, cameraFrames: item.cameraFrames.length, instruction: item.instruction ?? "" })),
      selectedPlanId: data.value.selectedPlanId ?? "",
      aspectRatio: aspectRatio.value,
      settings: JSON.parse(JSON.stringify(sceneSettings.value)),
      lighting: JSON.parse(JSON.stringify(lighting.value)),
      editorOpen: editing.value,
      loading: modelLoading.value,
      tasks: tasks.value.map(({ id, status, error }) => ({ id, status, error })),
      error: modelError.value,
    };
  },
});

nodeTools.register({
  name: "editDirector",
  description: "批量修改 3D 导演台的场景与动画方案并落盘，用的是节点自己那套校验。operations 是相对路径的 add / replace / remove：objectId 选已有物体（物体 threeJsonId），再加 joint 选人偶的某个关节轨道。加物体用 scene 的 ['objectList','-']，加轨道用 plan 的 ['tracks','-']，'-' 表示追加。整批里任何一步非法就整批不生效；看字段结构先用 readDirector 的 section=schema，scene / plan 返回现有数据。替换整条 frames 时，每帧都必须包含 rotation（{x,y,z}），不能只写 position。",
  parameters: z.strictObject({ operations: z.array(operationSchema).min(1).max(100) }),
  async execute({ operations }, { signal }) {
    await modelReady;
    await modelSaving;
    assertDirectorIdle(signal);
    const draft = createDirectorDraft(sceneSnapshot(), planForDraft(selectedPlan.value), JSON.parse(JSON.stringify(plans.value)));
    const editor = draft.tools.find(tool => tool.name === "editDocument")!;
    const result = editor.execute({ operations }) as { valid: boolean; issues: string[]; applied: number };
    const parsedPlan = directorPlanSchema.safeParse(draft.raw().plan);
    const editsPlan = operations.some(operation => operation.section === 'plan');
    if (editsPlan && (!result.valid || !parsedPlan.success)) {
      const issues = [...result.issues, ...(parsedPlan.success ? [] : parsedPlan.error.issues.map(issue => `plan.${issue.path.join(".")}：${issue.message}`))];
      return { applied: result.applied, valid: false, issues, saved: false };
    }
    const nextScene = draft.sceneChanged ? sceneSchema.parse(draft.raw().scene) : scene.value;
    const previous = plans.value;
    const baseId = data.value.selectedPlanId ?? "";
    const planId = previous.some(item => item.id === baseId) ? baseId : crypto.randomUUID();
    const plan = parsedPlan.success ? { ...parsedPlan.data, id: planId, instruction: previous.find(item => item.id === planId)?.instruction } : undefined;
    const objects = new Map(nextScene.objectList.map(object => [object.threeJsonId, object]));
    const nextPlans = (plan ? previous.some(item => item.id === planId) ? previous.map(item => item.id === planId ? plan : item) : [...previous, plan] : previous)
      .map(item => draft.sceneChanged ? { ...item, tracks: item.tracks.filter(track => objects.has(track.objectId)) } : item);
    const saving = modelSaving.then(async () => {
      signal?.throwIfAborted();
      if (disposed) throw new Error('导演节点已关闭');
      const value: ModelDocument = { version: 1, scene: nextScene, plans: nextPlans };
      const path = await writeModel(files.getWorkspaceFiles(), value);
      if (disposed) throw new Error('导演节点已关闭');
      modelDocument.value = value;
      data.value.modelPath = path;
      if (plan) data.value.selectedPlanId = planId;
    });
    modelSaving = saving.catch(() => {});
    await saving;
    return { applied: result.applied, valid: true, issues: [], saved: true, planId: plan?.id ?? null, planReady: Boolean(plan), sceneChanged: draft.sceneChanged, objects: nextScene.objectList.length, plans: nextPlans.length };
  },
});

nodeTools.register({
  name: "setDirectorPrompt",
  description: "写入 3D 导演台的提示词，也就是它自己生成动画时用的那段要求。只改文字，不触发生成。",
  parameters: z.strictObject({ text: z.string().max(4000) }),
  execute({ text }) { setPrompt(text); return { prompt: prompt.value }; },
});

nodeTools.register({
  name: "runDirector",
  description: "让 3D 导演台按提示词生成一版动画方案并渲染预览：它会调用文本模型规划，耗时且产生模型调用，只在用户明确要求生成时使用。传 instruction 会先写进提示词再生成。",
  parameters: z.strictObject({ instruction: z.string().max(4000).optional() }),
  async execute({ instruction }, { signal }) {
    if (tasks.value.some(task => !task.error)) throw new Error("这个导演台已有任务正在执行，请等待该任务结果，不要重复生成");
    if (instruction !== undefined) setPrompt(instruction);
    const result = await generate(signal);
    if (!result?.ok) throw new Error(result?.error || "导演台未完成修改，原方案已保留");
    return result;
  },
});
</script>

<style scoped lang="scss">
.directorContent {
  display: block;
  width: 100%;
  padding: 0;
  border: 0;
  cursor: pointer;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color-light);
  border-radius: var(--el-border-radius-base);
  &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }

  .scenePreview {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .emptyPreview {
    display: flex;
    height: 100%;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: var(--el-text-color-placeholder);
  }

}
</style>
