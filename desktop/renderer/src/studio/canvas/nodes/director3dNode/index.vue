<template>
  <nodeSkeleton v-bind="nodeProps" style="width: 320px">
    <button v-loading="modelLoading" type="button" class="directorContent nopan" :style="{ aspectRatio }" :disabled="modelLoading" :title="modelError || undefined" :aria-label="translate('打开导演台')" @dblclick.stop @click.stop="openEditor">
      <img v-if="preview" class="scenePreview" :src="preview" :alt="translate('最后镜头')" draggable="false" />
      <div v-else class="emptyPreview">
        <icon-cube3d-sphere :size="38" stroke="1.2" />
      </div>
    </button>
  </nodeSkeleton>
  <sceneEditor ref="editorView" v-if="editing" v-model:aiMode="aiMode" v-model:selectedObjectId="selectedObjectId" v-model:anchors="anchors" v-model:prompt="prompt" v-model:model="model" v-model:lighting="lighting" v-model:sceneSettings="sceneSettings" v-model:aspectRatio="aspectRatio"
    :documentUnavailable="!!modelError" :documentLoading="modelLoading" :scene="scene" :result="selectedPlan" :models="models" :modelsLoading="modelsLoading" :addingMannequin="addingMannequin"
    :mediaReferenceCount="refList.length" :plans="plans" :selectedPlanId="data.selectedPlanId ?? ''" :tasks="tasks"
    :exportingVideo="exportingVideo" :exportingImage="exportingImage" :exportProgress="exportProgress" :panoramaName="data.panorama?.url ? translate('全景背景') : ''" :editTimeline="editTimeline" :managePlan="managePlan" :canUndo="undoStack.length > 0" :canRedo="redoStack.length > 0"
    @exportVideo="exportVideo" @exportImage="exportImage" @addMannequin="addMannequin(undefined, $event).catch(() => {})" @updateObject="updateObject" @addObjects="addObjects" @removeObject="removeObject" @duplicateObject="duplicateObject" @ungroupAsset="ungroupAsset" @history="restoreHistory" @createMotion="createCameraMotion" @uploadPanorama="uploadPanorama" @clearPanorama="delete data.panorama"
    @addReference="directorPromptInput?.openReferenceMenu()" @selectPlan="data.selectedPlanId = $event" @loadModels="loadModels" @generate="generateFromUi" @cancelTask="cancelGeneration" @dismissTask="dismissGeneration" @editInstruction="setPrompt" @close="editing = false">
    <template #references><referenceItem v-model="refList" @preview="setReferencePreview" @remove="removeReference" /></template>
    <template #input>
      <promptInput ref="directorPromptInput" compact :placeholder="aiMode === 'scene' ? '描述场景或角色调整' : '描述模型动作和运镜要求'" v-model="promptModel" v-model:text="prompt" :references="referenceMentions" :canvas-references="canvasReferenceMentions" :reference-kinds="referenceKinds" :connect-reference="connectReference" />
    </template>
  </sceneEditor>
</template>

<script setup lang="ts">
import { assemblyObjectPatch, editStageAsset, removeStageObject, stageAssemblies, stageAssetEditSchema } from './stageGroups';
import { offsetStageObjects } from './stageGroups';
import { defaultStageSettings, sceneBackground } from './stageRuntime';
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
import { capturePreview, cameraViewSchema, sceneSchema, createEmptyScene, createMannequinObject, disposeStage, getSceneLighting, type LightingSettings, type ObjectPatch, type SceneDocument, type SceneSettings } from "./scene";
import { actorColors, createProp, createSet, localizeStageObjects, propPresets, setPresets, posePresets, applyActorPosePreset } from "./stageLibrary";
import { beginDirectorTrace, finishDirectorTrace, type DirectorTraceEvent } from "./directorTrace";
import { prepareDirectorTask, DirectorTaskError } from "./directorTask";
import { publicError } from "@/lib/publicError";
import { createDirectorDraft, operationSchema, directorModeSchema, type DirectorMode } from "./agentTools";
import { directorPrompt } from "./agentPrompt";
import { anchorSchema, prepareMotion, sampleMotion, type CameraAnchor } from "./motion";
import { directorPlanSchema, directorReferenceHistorySchema, directorGenerationSchema, isDirectorGenerationPending, prepareSceneAnimation, type DirectorPlan, type DirectorGeneration } from "./sceneAnimation";
import { createStage } from './stageRuntime';
import { bodyTypeIds, bodyTypes, type BodyType } from './mannequin';
import { aspectRatios } from './cameraPresets';
import { stageAspect } from './stageDraft';
import { renderImage, renderVideo, inspectScene, resolveSceneCamera, resolveSceneCameraSnapshots } from "./renderMedia";
import { beginMediaExport } from "../../scaffold/mediaExport";
import { captureMediaPublication } from "../../scaffold/mediaPublication";
import type { CanvasMediaTask } from "../../../../../../canvas-delivery.ts";

type PromptModel = NonNullable<InstanceType<typeof promptInput>["$props"]["modelValue"]>;
import { manageSavedPlans, uniquePlanName, planDisplayNames, planManagementSchema, type PlanManagementRequest } from './planManagement';
import { applyTimelinePosePreset, createManualPlan, editTimelinePlan, timelineRequestSchema, type TimelineRequest } from './timeline';
import { sceneDeletionReceipt, detachDeletedCameraTargets, type CameraSnapshotRequest } from './cameraReconciliation';
import { validateCameraTargets } from './cameraTracking';
import { cameraAnchorsSchema } from './cameraDraft';
const modelDocumentSchema = z.strictObject({
  version: z.literal(1),
  anchors: cameraAnchorsSchema.optional(),
  scene: sceneSchema,
  plans: z.array(directorPlanSchema.safeExtend({ id: z.string().min(1), instruction: z.string().optional(), source: z.enum(["camera","manual"]).optional(), summary: z.string().optional() })),
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
  panorama?: { url: string; mimeType: string };
  prompt?: string;
  promptModel?: PromptModel;
  model?: string;
  anchors?: CameraAnchor[];
  selectedPlanId?: string;
  aspectRatio?: string;
  aiMode?: DirectorMode;
  directorActivity?: DirectorGeneration[];
});
const { refList, referenceMentions, canvasReferenceMentions, referenceKinds, connectReference, preparePromptReferences, setReferencePreview, removeReference, referenceHistory } = useNodeReferences();
const directorPromptInput=ref<InstanceType<typeof promptInput>>();
const promptModel = computed({ get: () => data.value.promptModel ?? [], set: (value: PromptModel) => { data.value.promptModel = value; } });
const anchors = computed({ get: () => data.value.anchors ?? [], set: (value: CameraAnchor[]) => {
  void saveAnchors(value).catch(error => { if (!disposed) ElMessage.error(error instanceof Error ? error.message : translate('机位保存失败')); });
} });
const prompt = computed({ get: () => data.value.prompt ?? "", set: (value: string) => { data.value.prompt = value; } });
const model = computed({ get: () => data.value.model ?? "", set: (value: string) => { data.value.model = value; } });
// ACT: 场景和动画只在节点内部持有，画布数据仅保存文件引用，避免拖动时遍历大量关键帧。
const modelDocument = shallowRef<ModelDocument>({ version: 1, scene: createEmptyScene(), plans: [] });
const plans = computed(() => modelDocument.value.plans);
const planLabels=computed(()=>planDisplayNames(plans.value));
const selectedPlan = computed(() => plans.value.find(plan => plan.id === data.value.selectedPlanId));
const aiMode = computed<DirectorMode>({
  get: () => directorModeSchema.safeParse(data.value.aiMode).data ?? (plans.value.length ? 'animation' : 'scene'),
  set: mode => { data.value.aiMode = directorModeSchema.parse(mode); if (mode === 'scene') data.value.selectedPlanId = ''; },
});
// A selected animation is also the LLM's edit target, regardless of how it was selected.
watch(selectedPlan,plan=>{if(plan)data.value.aiMode='animation';},{immediate:true,flush:'sync'});
const scene = computed(() => modelDocument.value.scene);
const lighting = computed({ get: () => ({ ...getSceneLighting(scene.value), ...data.value.lighting }), set: (value: LightingSettings) => { data.value.lighting = value; } });
const panoramaUrl = files.useFileUrl(() => data.value.panorama, () => ElMessage.error(translate('全景背景读取失败')));
const sceneSettings = computed({ get: () => ({ ...defaultStageSettings, ...data.value.sceneSettings, panoramaUrl: panoramaUrl.value }), set: (value: SceneSettings) => { const { panoramaUrl: _url, ...settings } = value; data.value.sceneSettings = settings; } });
async function uploadPanorama(file: File) {
  try {
    assertDirectorIdle();
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 32 * 1024 * 1024) throw new Error(translate('请选择 32 MB 以内的 PNG、JPG 或 WebP 全景图'));
    const bitmap = await createImageBitmap(file);
    const valid = Math.abs(bitmap.width / bitmap.height - 2) < 0.02 && bitmap.width <= 16384 && bitmap.width * bitmap.height <= 32_000_000;
    bitmap.close();
    if (!valid) throw new Error(translate('全景图需要 2:1 比例，且不超过 3200 万像素'));
    addingMannequin.value = true;
    const path = await files.uploadFile(file);
    if (!disposed) data.value.panorama = { url: path, mimeType: file.type };
  } catch (error) { if (!disposed) ElMessage.error(error instanceof Error ? error.message : translate('全景背景读取失败')); }
  finally { addingMannequin.value = false; }
}
const aspectRatioSchema = z.enum(aspectRatios);
const aspectRatio = computed({
  get: () => aspectRatioSchema.safeParse(data.value.aspectRatio).data ?? "16:9",
  set: (value: string) => { data.value.aspectRatio = aspectRatioSchema.parse(value); },
});
const sceneAspect = computed(() => {
  const [width, height] = aspectRatio.value.split(":").map(Number);
  return width! / height!;
});
const editing = ref(false);
const editorView = ref<InstanceType<typeof sceneEditor>>();
const selectedObjectId = ref('');
const selectedObjectIds = () => scene.value.objectList.some(o => o.threeJsonId === selectedObjectId.value || o.assembly?.id === selectedObjectId.value) ? [selectedObjectId.value] : [];
const savedActivities = z.array(directorGenerationSchema).safeParse(data.value.directorActivity ?? []);
const tasks = ref<DirectorGeneration[]>((savedActivities.success ? savedActivities.data : []).slice(-20).map(task => isDirectorGenerationPending(task) ? { ...task, state: 'interrupted', error: translate('上次操作未确认，请先检查当前场景'), traces: task.traces.map(trace => trace.status === 'running' ? { ...trace, status: 'interrupted', outcomeUnknown: trace.name === 'applyDirectorCandidate' } : trace) } : task));
watch(tasks, value => { data.value.directorActivity = JSON.parse(JSON.stringify(value.slice(-20))); }, { deep: true, immediate: true });
const modelsLoading = ref(false);
const models = ref<NodeAiModel[]>([]);
const selectedModel = computed(() => models.value.find(item => JSON.stringify([item.providerId, item.modelId]) === model.value));
const preview = ref("");
let previewVersion = 0;
const modelLoading = ref(true);
const modelError = ref("");
const addingMannequin = ref(false);
type DirectorHistoryEntry = { document: ModelDocument; selectedPlanId: string; anchors: CameraAnchor[] };
const undoStack = shallowRef<DirectorHistoryEntry[]>([]);
const redoStack = shallowRef<DirectorHistoryEntry[]>([]);
function currentHistoryEntry(): DirectorHistoryEntry { return { document: JSON.parse(JSON.stringify(modelDocument.value)), selectedPlanId: data.value.selectedPlanId ?? '', anchors: JSON.parse(JSON.stringify(anchors.value)) }; }
function rememberModel() {
  undoStack.value = [...undoStack.value.slice(-29), currentHistoryEntry()];
  redoStack.value = [];
}
let modelSaving = Promise.resolve();
let modelFileRevision: string | null = null;
let disposed = false;
const generationControllers = new Map<string, AbortController>();
onBeforeUnmount(() => { disposed = true; exportController.abort(new Error(translate("导演节点已关闭，导出已停止"))); generationControllers.forEach(controller => controller.abort()); });

function getModelPath() {
  if (!node.id || /[\\/]/.test(node.id) || node.id === "." || node.id === "..") throw new Error(translate("节点 ID 不能作为文件夹名称"));
  return `assets/${node.id}/model.json`;
}

async function saveAnchors(value: CameraAnchor[]) {
  const parsed=cameraAnchorsSchema.parse(value);
  if(JSON.stringify(parsed)===JSON.stringify(anchors.value))return;
  if(disposed||modelLoading.value||modelError.value)throw new Error(modelError.value||translate('导演台尚未就绪'));
  const previous=currentHistoryEntry();
  rememberModel(); data.value.anchors=parsed;
  const saving=modelSaving.then(async()=>{
    if(disposed||modelError.value)throw new Error(modelError.value||translate('导演台已关闭'));
    const next={...modelDocument.value};
    const path=await writeModel(files.getWorkspaceFiles(),next,parsed);
    if(!disposed){modelDocument.value=next;data.value.modelPath=path;}
  });
  modelSaving=saving.catch(()=>{});
  try{await saving;}catch(error){
    if(!disposed){data.value.anchors=JSON.parse(JSON.stringify(modelDocument.value.anchors??previous.anchors));modelError.value=translate('机位保存结果未确认，请重新打开导演台检查');}
    throw error;
  }
}

const preparedModels=new WeakSet<ModelDocument>();
async function prepareModel(value:ModelDocument,savedAnchors:CameraAnchor[],signal?:AbortSignal) {
  signal?.throwIfAborted();
  const previous=modelDocument.value,oldPlans=new Map(previous.plans.map(p=>[p.id,p]));
  const requests:CameraSnapshotRequest[]=[{view:value.scene.sceneConfig,time:0},...savedAnchors.map(anchor=>({view:anchor,time:anchor.time??0,plan:selectedPlan.value})),...value.plans.flatMap(plan=>plan.cameraFrames.map(frame=>({view:frame.view,time:frame.time,plan:oldPlans.get(plan.id)})))];
  const repaired=await detachDeletedCameraTargets(previous.scene,value.scene,requests,items=>resolveSceneCameraSnapshots(previous.scene,items,sceneAspect.value,signal,lighting.value,sceneSettings.value));
  let offset=1+savedAnchors.length;
  if(repaired.views[0]!==value.scene.sceneConfig){const view=repaired.views[0]!;value.scene={...value.scene,sceneConfig:{...value.scene.sceneConfig,camera:view.camera,controls:view.controls}};}
  value.anchors=cameraAnchorsSchema.parse(savedAnchors.map((anchor,index)=>({...anchor,...repaired.views[1+index]})));
  value.plans=value.plans.map(plan=>{const frames=plan.cameraFrames.map(frame=>{const view=repaired.views[offset++]!;return view===frame.view?frame:{...frame,view};});return frames.some((f,i)=>f!==plan.cameraFrames[i])?{...plan,cameraFrames:frames}:plan;});
  validateCameraTargets(value.scene,[value.scene.sceneConfig,...value.anchors,...value.plans.flatMap(p=>p.cameraFrames.map(f=>f.view))]);
  signal?.throwIfAborted();preparedModels.add(value);
}
async function writeModel(workspaceFiles: ReturnType<typeof files.getWorkspaceFiles>, value: ModelDocument, savedAnchors:CameraAnchor[]=anchors.value) {
  if(!preparedModels.has(value))await prepareModel(value,savedAnchors);
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
    const workspaceFiles = files.getWorkspaceFiles(), path = modelPath ?? getModelPath();
    if (path !== getModelPath()) throw new Error(translate("导演台模型文件路径无效"));
    let snapshot: Awaited<ReturnType<typeof workspaceFiles.readTextSnapshot>> | undefined;
    if (!modelSnapshot) {
      try { snapshot = await workspaceFiles.readTextSnapshot(path); }
      catch (error) {
        const status = (error as { response?: { status?: number } }).response?.status;
        // A first save may have committed without returning its receipt or pointer.
        // Probe only this node's canonical owned path; a genuinely new node stays empty.
        if (!modelPath && status === 404) { modelFileRevision = null; return; }
        throw error;
      }
    }
    const previousRevision = modelFileRevision;
    const value = modelDocumentSchema.parse(modelSnapshot ?? JSON.parse(snapshot!.text));
    if (disposed) return;
    modelFileRevision = snapshot?.revision ?? null;
    // 复制、跨画布粘贴时只传递一次快照，写入新节点目录成功后才移除快照。
    if (modelSnapshot) {
      const path = await writeModel(workspaceFiles, value, value.anchors??anchors.value);
      if (disposed) return;
      data.value.modelPath = path;
      delete data.value.modelSnapshot;
    }
    if (previousRevision !== null && snapshot && previousRevision !== snapshot.revision) { undoStack.value = []; redoStack.value = []; }
    modelDocument.value = value;
    if(value.anchors)data.value.anchors=JSON.parse(JSON.stringify(value.anchors));
    data.value.modelPath = path;
    // An explicit empty selection means the base scene, including after reopening.
    if (data.value.selectedPlanId !== '' && !selectedPlan.value) data.value.selectedPlanId = value.plans[0]?.id ?? '';
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
  if (addingMannequin.value || exportingVideo.value || exportingImage.value || tasks.value.some(isDirectorGenerationPending)) throw new Error('导演台正在生成或导出，请等待完成');
}
// 导演台左侧属性面板：只改名称、位置、旋转、缩放、颜色，按场景校验后落盘。
async function updateObject(id: string, patch: ObjectPatch) {
  try {
    await modelReady;
    assertDirectorIdle();
    const workspaceFiles = files.getWorkspaceFiles();
    const saving = modelSaving.then(async () => {
      if (disposed) throw new Error('导演节点已关闭');
      const current = scene.value;
      if (!current.objectList.some(item => item.threeJsonId === id || item.assembly?.id === id)) throw new Error(translate('物体已不存在，请重新选择'));
      const nextScene: SceneDocument = stageAssemblies(current.objectList).some(group => group.id === id) ? editStageAsset(current, assemblyObjectPatch(id, patch)).scene : {
        ...current,
        objectList: current.objectList.map(item => item.threeJsonId !== id ? item : {
          ...item, name: patch.name || item.name, position: patch.position, rotation: patch.rotation, scale: patch.scale,
          material: { ...item.material, color: patch.color, ...(patch.roughness !== undefined ? { roughness: patch.roughness } : {}), ...(patch.metalness !== undefined ? { metalness: patch.metalness } : {}) },
          ...(item.objType === "mannequin" && patch.pose ? { pose: patch.pose, posePresetHeight: patch.posePresetHeight ?? item.posePresetHeight } : {}),
        }),
      };
      const value: ModelDocument = { ...modelDocument.value, scene: sceneSchema.parse(nextScene) };
      const path = await writeModel(workspaceFiles, value);
      if (disposed) throw new Error('导演节点已关闭');
      rememberModel();
      modelDocument.value = value;
      data.value.anchors=JSON.parse(JSON.stringify(value.anchors??anchors.value));
      data.value.modelPath = path;
    });
    modelSaving = saving.catch(() => {});
    await saving;
  } catch (error) {
    if (!disposed) ElMessage.error(error instanceof Error ? error.message : translate('物体修改失败'));
  }
}
async function addMannequin(signal?: AbortSignal, options: { bodyType?: BodyType; crowd?: boolean } = {}) {
  await modelReady;
  assertDirectorIdle(signal);
  addingMannequin.value = true;
  // A crowd is a 3x3 block of the same build, 0.9 m apart, placed beside the existing cast.
  const added = Array.from({ length: options.crowd ? 9 : 1 }, () => {
    const object = createMannequinObject(crypto.randomUUID());
    if (options.bodyType && options.bodyType !== 'standard') object.bodyType = options.bodyType;
    return object;
  });
  const object = added[0]!;
  try {
    const workspaceFiles = files.getWorkspaceFiles();
    const saving = modelSaving.then(async () => {
      signal?.throwIfAborted();
      if (disposed) throw new Error('导演节点已关闭');
      const current = scene.value;
      const mannequins = current.objectList.filter(item => item.objType === "mannequin");
      const startX = mannequins.length ? Math.max(...mannequins.map(item => item.position.x)) + 1 : 0;
      // 按添加顺序命名为角色A、角色B…，场景列表里能区分每个人偶。
      const names = new Set(current.objectList.map(item => item.name));
      let index = mannequins.length;
      added.forEach((item, order) => {
        item.material.color = actorColors[(options.crowd ? mannequins.length : mannequins.length + order) % actorColors.length]!;
        item.position.x = startX + (order % 3) * 0.9;
        item.position.z = options.crowd ? -Math.floor(order / 3) * 0.9 : 0;
        for (; ; index++) {
          const name = `${translate('角色')}${index < 26 ? String.fromCharCode(65 + index) : index + 1}`;
          if (!names.has(name)) { item.name = name; names.add(name); index++; break; }
        }
      });
      const nextScene: SceneDocument = { ...current, objectList: [...current.objectList, ...added] };
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
      rememberModel();
      modelDocument.value = value;
      data.value.anchors=JSON.parse(JSON.stringify(value.anchors??anchors.value));
      data.value.modelPath = path;
    });
    modelSaving = saving.catch(() => {});
    await saving;
    selectedObjectId.value = object.threeJsonId;
    return { object: JSON.parse(JSON.stringify(object)), objectIds: added.map(item => item.threeJsonId), objectCount: scene.value.objectList.length };
  } catch (error) {
    if (!disposed) ElMessage.error(error instanceof Error ? error.message : translate("人偶添加失败"));
    throw error;
  } finally {
    addingMannequin.value = false;
  }
}

// All manual scene operations share the existing revision-checked, serialized writer.
async function changeScene(change: (value: ModelDocument) => ModelDocument, history?: 'undo' | 'redo', selectedPlanId?: string, restoredAnchors?: CameraAnchor[],onError?:(error:unknown)=>void) {
  try {
    await modelReady;
    assertDirectorIdle();
    addingMannequin.value = true;
    const saving = modelSaving.then(async () => {
      if (disposed) throw new Error(translate('导演台已关闭'));
      const previous = currentHistoryEntry();
      const next = modelDocumentSchema.parse(change(JSON.parse(JSON.stringify(previous.document))));
      if(!history&&JSON.stringify(next)===JSON.stringify(previous.document)&&JSON.stringify(restoredAnchors??anchors.value)===JSON.stringify(previous.anchors)){if(selectedPlanId!==undefined)data.value.selectedPlanId=selectedPlanId;return;}
      const path = await writeModel(files.getWorkspaceFiles(), next, restoredAnchors??anchors.value);
      if (disposed) return;
      if (history === 'undo') { redoStack.value = [...redoStack.value, previous]; undoStack.value = undoStack.value.slice(0, -1); }
      else if (history === 'redo') { undoStack.value = [...undoStack.value, previous]; redoStack.value = redoStack.value.slice(0, -1); }
      else rememberModel();
      modelDocument.value = next;
      data.value.anchors=JSON.parse(JSON.stringify(next.anchors??anchors.value));
      if (selectedPlanId !== undefined) data.value.selectedPlanId = selectedPlanId;
      data.value.modelPath = path;
    });
    modelSaving = saving.catch(() => {});
    await saving;
    return true;
  } catch (error) {
    onError?.(error);
    if (!disposed) ElMessage.error(error instanceof Error ? error.message : translate('物体修改失败'));
    return false;
  } finally { addingMannequin.value = false; }
}
async function addObjects(objects: SceneDocument['objectList']) {
  const saved = await changeScene(value => ({ ...value, scene: { ...value.scene, objectList: [...value.scene.objectList, ...objects] } }));
  if (saved && objects[0]) selectedObjectId.value = objects[0].assembly?.id ?? objects[0].threeJsonId;
  return saved;
}
function removeObject(id: string) {
  return changeScene(value => {
    value.scene = removeStageObject(value.scene, id);
    const ids = new Set(value.scene.objectList.map(object => object.threeJsonId));
    value.plans = value.plans.map(plan => ({ ...plan, tracks: plan.tracks.filter(track => ids.has(track.objectId)) }));
    return value;
  });
}
async function duplicateObject(id: string) {
  let copiedId = "";
  const saved = await changeScene(value => {
    if (stageAssemblies(value.scene.objectList).some(group => group.id === id)) {
      const result = editStageAsset(value.scene, { assetId: id, action: 'copy' }); value.scene = result.scene; copiedId = result.assetId;
    } else {
      const object = value.scene.objectList.find(o => o.threeJsonId === id);
      if (!object) throw new Error(translate('物体已不存在，请重新选择'));
      copiedId = crypto.randomUUID();
      value.scene.objectList.push({ ...object, threeJsonId: copiedId, name: `${object.name ?? translate('物体')} · ${translate('副本')}`, position: { ...object.position, x: object.position.x + 1 } });
    }
    return value;
  });
  if (saved) selectedObjectId.value = copiedId;
  return saved;
}
function ungroupAsset(id: string) { return changeScene(value => ({ ...value, scene: editStageAsset(value.scene, { assetId: id, action: 'ungroup' }).scene })); }
async function restoreHistory(direction: 'undo' | 'redo') {
  await modelSaving;
  const stack = direction === 'undo' ? undoStack.value : redoStack.value;
  if (stack.length) { const entry = stack.at(-1)!; return changeScene(() => entry.document, direction, entry.selectedPlanId, entry.anchors); }
}

async function createCameraMotion(duration: number, easing: 'smooth' | 'linear' | 'cut') {
  const id = crypto.randomUUID();
  const saved = await changeScene(value => {
    if (anchors.value.length < 2) throw new Error(translate('请先记录至少两个机位'));
    const plan = directorPlanSchema.parse({
      name: uniquePlanName(value.plans,translate('机位运镜 {0}', { 0: value.plans.length + 1 })), duration, tracks: [],
      cameraFrames: anchors.value.map((anchor, index) => ({ time: index === anchors.value.length - 1 ? duration : index * duration / (anchors.value.length - 1), view: cameraViewSchema.parse({ camera: anchor.camera, controls: anchor.controls }), easing })),
    });
    return { ...value, plans: [...value.plans, { ...plan, id, source: 'camera' as const, instruction: translate('{0} 个机位 · {1} 秒 · {2}', { 0: anchors.value.length, 1: duration, 2: translate(easing === 'smooth' ? '平滑' : easing === 'linear' ? '匀速' : '切镜') }) }] };
  });
  if (saved) data.value.selectedPlanId = id;
  return saved ? { saved: true, planId: id, duration, cameraCount: anchors.value.length } : { saved: false };
}

async function editTimeline(request:TimelineRequest,throwOnError=false):Promise<boolean>{
  let failure:unknown;
  const args=timelineRequestSchema.parse(request);let id=args.action==='create'?crypto.randomUUID():args.planId??data.value.selectedPlanId;
  const saved=await changeScene(value=>{
    if(args.action==='create'){
      const context=editorView.value?.getContext(),view=context?.recordingCameraView??context?.selectedAnchor??context?.view??value.scene.sceneConfig;
      const plan=createManualPlan(value.scene,cameraViewSchema.parse({camera:view.camera,controls:view.controls}),uniquePlanName(value.plans,args.name??translate('手动动画 {0}',{0:value.plans.length+1})),args.duration??4);
      return {...value,plans:[...value.plans,{...plan,id:id!,source:'manual' as const,instruction:translate('手动关键帧编辑')}]};
    }
    const current=value.plans.find(p=>p.id===id);if(!current)throw Error(translate('请先选择动画方案'));
    const operations=args.operations!.map(op=>op.action==='rename'?{...op,name:uniquePlanName(value.plans.filter(p=>p.id!==id),op.name)}:op);
    const next=editTimelinePlan(value.scene,current,operations);
    const currentContent={name:current.name,duration:current.duration,tracks:current.tracks,cameraFrames:current.cameraFrames};if(JSON.stringify(next)===JSON.stringify(currentContent))return value;
    return {...value,plans:value.plans.map(p=>p.id===id?{...current,...next,source:'manual' as const}:p)};
  },undefined,id,undefined,error=>{failure=error;});
  if(saved&&args.action==='create'){await nextTick();editorView.value?.seekTime(0);}
  if(!saved&&throwOnError)throw failure??new Error(translate('时间轴修改失败，原方案已保留'));
  return saved===true;
}
nodeTools.register({name:'editDirectorTimeline',description:'直接编辑已保存导演动画的时间轴，不调用模型。create 新建并选中方案；edit 指定 planId（省略为当前），operations 原子批次支持轨道添加/删除、插入/移动/删除关键帧、修改帧参数、方案改名和时长等比缩放；recordCamera 在指定time录入完整view（保留已有同刻过渡，非重复才保存），recordPose 在指定时间记录角色变换/关节，只为变化的通道创建或更新关键帧，基础场景不变。首帧固定0秒；关节旋转单位弧度；duration.rescale=false 保留原时点并拒绝裁切。支持撤销。',parameters:timelineRequestSchema,async execute(args,{signal}){await modelReady;await modelSaving;assertDirectorIdle(signal);const saved=await editTimeline(args,true);if(!saved)throw Error(translate('时间轴修改失败，原方案已保留'));return {saved:true,planId:data.value.selectedPlanId,plan:JSON.parse(JSON.stringify(selectedPlan.value))};}});

async function managePlan(request:PlanManagementRequest,throwOnError=false):Promise<boolean>{
  let failure:unknown;const args=planManagementSchema.parse(request),copyId=args.action==='copy'?crypto.randomUUID():undefined;
  const selection=copyId??(args.action==='remove'&&data.value.selectedPlanId===args.planId?'':undefined);
  // Save the model and its resulting selection through the same serialized transaction.
  const saved=await changeScene(value=>{const result=manageSavedPlans(value.plans,data.value.selectedPlanId??'',args,()=>copyId!);value.plans=result.plans;return value;},undefined,selection,undefined,error=>failure=error);
  if(!saved){if(throwOnError)throw failure??new Error(translate('方案管理失败，原内容已保留'));return false;}
  if(args.action==='copy'){await nextTick();editorView.value?.seekTime(0);}
  return true;
}
nodeTools.register({name:'manageDirectorPlans',description:'复制、改名或删除一个已保存导演方案，不调用模型。planId 来自 readDirector；copy 深复制并选中新方案，rename 名称自动避重，remove 只移除目标方案，删除当前方案后回到基础场景。保留其他方案、场景、机位、素材；支持撤销/重做。',parameters:planManagementSchema,async execute(args,{signal}){await modelReady;await modelSaving;assertDirectorIdle(signal);await managePlan(args,true);return{saved:true,selectedPlanId:data.value.selectedPlanId??'',plans:plans.value.map(p=>({id:p.id,name:p.name,duration:p.duration}))};}});

nodeEvent.on("copy", async () => {
  await nodeEvent.emit("save");
  if (modelError.value) throw new Error(translate("导演台当前无法复制：{0}", { 0: modelError.value }));
  return { modelPath: undefined, modelSnapshot: { ...modelDocument.value, anchors: anchors.value }, directorActivity: [] };
});

nodeEvent.on("save", async (reason) => {
  await modelReady;
  let pending: Promise<void>;
  do {
    pending = modelSaving;
    await pending;
  } while (pending !== modelSaving);
  if (reason === "reload" && (exportingVideo.value || exportingImage.value || tasks.value.some(isDirectorGenerationPending))) {
    throw new Error(translate("导演台正在生成或导出，请完成后再刷新节点"));
  }
});

async function exportToCanvas(kind: "image" | "video", key: string, aspect: number, render: (signal: AbortSignal) => Promise<File>, externalSignal?: AbortSignal) {
  if (data.value.panorama && !panoramaUrl.value) throw new Error(translate('全景背景正在载入'));
  if (addingMannequin.value || tasks.value.some(isDirectorGenerationPending)) throw new Error(translate('导演台正在生成或导出，请等待完成'));
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

function exportVideo(aspect: number, camera?:CameraAnchor) {
  const base = selectedPlan.value;
  const plan=base&&camera?{...base,cameraFrames:[{time:0,view:cameraViewSchema.parse({camera:camera.camera,controls:camera.controls}),easing:'smooth' as const}]}:base;
  if (!plan) return;
  return exportToCanvas("video", "video", aspect, signal => renderVideo(scene.value, plan, aspect, signal, value => { exportProgress.value = value; }, lighting.value, sceneSettings.value));
}

function exportImage(anchor: CameraAnchor|undefined, aspect: number, time: number, signal?: AbortSignal) {
  const index=anchor?anchors.value.findIndex(item=>item.id===anchor.id):-1;const name=index>=0?`关键帧${index+1}`:translate(selectedPlan.value?'动画镜头':'基础场景');
  return exportToCanvas("image", anchor?.id??"animation-camera", aspect, async signal => {
    const file = await renderImage(scene.value, index>=0?anchor:undefined, aspect, time, signal, selectedPlan.value, lighting.value, sceneSettings.value);
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

type DirectorRunOutcome = { ok: boolean; anchorsChanged?:boolean; error?: string; cancelled?: boolean; readOnly?: boolean; changed?: boolean; mode?: DirectorMode; summary?: string; planId?: string; sceneChanged?: boolean; objects?: number };
function dismissGeneration(id: string) { tasks.value = tasks.value.filter(task => task.id !== id || isDirectorGenerationPending(task)); }
function cancelGeneration(id: string) {
  const task = tasks.value.find(task => task.id === id), controller = generationControllers.get(id);
  if (!task || task.state !== 'running' || !controller) return false;
  tasks.value = tasks.value.map(item => item.id === id ? { ...item, state: 'stopping', status: translate('正在停止…') } : item);
  controller.abort(new DOMException(translate('已停止'), 'AbortError'));
  return true;
}
async function generateFromUi() {
  const previousTask = tasks.value.at(-1)?.id;
  const result = await generate();
  if (!result.ok && !result.cancelled && tasks.value.at(-1)?.id === previousTask) ElMessage.error(publicError(result.error));
}
async function generate(externalSignal?: AbortSignal, requestedMode?: DirectorMode): Promise<DirectorRunOutcome> {
  await modelReady;
  await modelSaving;
  externalSignal?.throwIfAborted();
  try { assertDirectorIdle(externalSignal); preparePromptReferences(); }
  catch (error) { return { ok: false, error: publicError(error) }; }
  const requirement = prompt.value.trim();
  if (!requirement) return { ok: false, error: translate('请先输入提示词') };
  if(refList.value.length>8)return{ok:false,error:translate('每次最多引用 8 项素材')};
  if (refList.value.some(item => item.value === undefined)) return { ok: false, error: translate('引用节点暂无内容，请先补充引用内容') };
  const mode = requestedMode ?? aiMode.value, selectedModelKey = model.value;
  const baseScene = scene.value, basePlan = selectedPlan.value, basePlanId = data.value.selectedPlanId ?? '';
  const baseAnchors=JSON.parse(JSON.stringify(anchors.value)) as CameraAnchor[];
  editorView.value?.pauseForAgent();
  const selectedIds = selectedObjectIds(), editorContext = editorView.value?.getContext() ?? null;
  const aspect = sceneAspect.value, initialLighting = { ...lighting.value }, settings = { ...sceneSettings.value }, initialRatio = aspectRatio.value;
  const stageBefore = JSON.stringify({ lighting: data.value.lighting, settings: data.value.sceneSettings, ratio: data.value.aspectRatio });
  const references = anchors.value.map((value, index) => ({ anchorId: value.id, name: value.name, order: index + 1, ...cameraViewSchema.parse({ camera: value.camera, controls: value.controls }) }));
  const mediaReferences = refList.value
    .filter((item): item is typeof item & Extract<NodeOutput, { dataType: 'STRING' | 'IMAGE' | 'VIDEO' }> => isNodeOutput(item) && ['STRING', 'IMAGE', 'VIDEO'].includes(item.dataType))
    .map(item => item.dataType === 'STRING' ? { dataType: item.dataType, value: item.value } : { dataType: item.dataType, value: { ...item.value } });
  const conversation = tasks.value.slice(-6).map(item => ({ instruction: item.instruction.slice(0, 4000), state: item.state, mode: item.mode, summary: item.summary?.slice(0, 4000), references:item.referenceHistory, steps: item.traces.slice(-12).map(trace => ({ action: trace.label, target: trace.target, status: trace.status, outcome: trace.outcome })) }));
  const task: DirectorGeneration = { id: crypto.randomUUID(), instruction: requirement, mode, state: 'running', referenceHistory:directorReferenceHistorySchema.parse(referenceHistory()), traces: [], status: translate('正在连接 Agent…') };
  const controller = new AbortController(), cancel = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener('abort', cancel, { once: true });
  if (externalSignal?.aborted) cancel();
  generationControllers.set(task.id, controller);
  tasks.value = [...tasks.value.slice(-19), task];
  setPrompt('');
  // SDK events include rejected calls that never reach the local executor. Correlate
  // executed calls with those rows so every attempt is visible exactly once.
  const waitingTools = new Map<string, string[]>(), displayIds = new Map<string, string>(), observedIds = new Set<string>();
  const recordTool = (event: DirectorTraceEvent, source: 'local' | 'sdk' = 'local') => {
    if (source === 'local') {
      if (event.type === 'start') {
        const displayId = waitingTools.get(event.name)?.shift() ?? event.id;
        displayIds.set(event.id, displayId); observedIds.add(displayId);
      }
      event = { ...event, id: displayIds.get(event.id) ?? event.id };
    } else if (event.type === 'start') {
      waitingTools.set(event.name, [...(waitingTools.get(event.name) ?? []), event.id]);
    } else {
      waitingTools.set(event.name, (waitingTools.get(event.name) ?? []).filter(id => id !== event.id));
      if (observedIds.has(event.id)) return;
    }
    if (disposed) return;
    tasks.value = tasks.value.map(item => {
      if (item.id !== task.id) return item;
      const existing = item.traces.find(trace => trace.id === event.id);
      const started = existing ?? beginDirectorTrace(event, selectedIds);
      const trace = event.type === 'start' ? { ...beginDirectorTrace(event, selectedIds), startedAt: started.startedAt } : finishDirectorTrace(started, event);
      return { ...item, traces: existing ? item.traces.map(value => value.id === trace.id ? trace : value) : [...item.traces, trace] };
    });
  };
  const setStatus = (status: string) => {
    const current = tasks.value.find(item => item.id === task.id);
    if (current?.state === 'running' && current.status !== status) tasks.value = tasks.value.map(item => item.id === task.id ? { ...item, status } : item);
  };
  try {
    await refreshModels(); controller.signal.throwIfAborted();
    const choice = models.value.find(item => JSON.stringify([item.providerId, item.modelId]) === selectedModelKey);
    if (!choice) throw new DirectorTaskError(translate('请先在导演台里选择用于规划的模型'));
    const workspaceFiles = files.getWorkspaceFiles();
    const directory = mediaReferences.some(item => item.dataType !== 'STRING') ? (await workspaceFiles.list()).directory : undefined;
    controller.signal.throwIfAborted();
    const result = await prepareDirectorTask({
      mode, currentTime:editorContext?.time??0, scene: baseScene, anchors:baseAnchors, selectedAnchorId:editorContext?.selectedAnchor?.id, editorView:editorContext?.view??undefined, stage: { lighting: initialLighting, settings: (({ panoramaUrl: _url, ...rest }) => rest)(settings), aspectRatio: initialRatio }, plan: planForDraft(basePlan), plans: JSON.parse(JSON.stringify(plans.value)), selectedObjectIds: selectedIds, signal: controller.signal, onTool: recordTool,
      resolveCameraSnapshots:(value,requests,signal)=>resolveSceneCameraSnapshots(value,requests,aspect,signal,initialLighting,settings),
      resolveCamera:(value,view,signal)=>resolveSceneCamera(value,view,aspect,signal,initialLighting,settings),
      inspect: (value, plan, timestamps, signal, stage) => inspectScene(value, plan, timestamps, stageAspect(stage.aspectRatio), signal, stage.lighting, { ...stage.settings, panoramaUrl: settings.panoramaUrl }),
      runModel: (tools, document) => ai.generate({
        references: mediaReferences, providerId: choice.providerId, modelId: choice.modelId, systemPrompt: directorPrompt(mode), directory, tools, signal: controller.signal,
        prompt: JSON.stringify({ mode, instruction: requirement, references, selectedPlanId: basePlanId, context: { selectedObjectIds: selectedIds, editor: editorContext }, conversation, document }),
        onEvent(event) {
          if (event.type === 'status') setStatus(translate(event.message));
          else if (event.type === 'text' || event.type === 'reasoning') setStatus(translate('Agent 正在规划下一步…'));
          else if (event.type === 'toolStart' || event.type === 'toolEnd') {
            const trace = tasks.value.find(item => item.id === task.id)?.traces.find(item => item.id === event.id);
            recordTool({
              type: event.type === 'toolStart' ? 'start' : 'end', id: event.id, name: event.name,
              args: event.type === 'toolStart' && event.args && typeof event.args === 'object' ? event.args as Record<string, unknown> : {},
              anchors:baseAnchors, selectedAnchorId:editorContext?.selectedAnchor?.id, startedAt: trace?.startedAt ?? Date.now(), durationMs: trace ? Math.max(0, Date.now() - trace.startedAt) : undefined, scene: baseScene,
              ...(event.type === 'toolEnd' ? { result: event.result, error: event.isError ? event.result : undefined } : {}),
            }, 'sdk');
            setStatus(translate(event.type === 'toolStart' ? '正在读取与校验草稿…' : event.isError ? '工具返回原因，Agent 正在修正…' : '草稿操作完成，继续校验…'));
          }
        },
      }),
    });
    controller.signal.throwIfAborted();
    if (result.sceneChanged) result.summary=sceneDeletionReceipt(baseScene,result.scene,baseAnchors,plans.value,result.anchors.length)??result.summary;
    if (disposed) return { ok: false, cancelled: true };
    if (!result.changed) {
      tasks.value = tasks.value.map(item => item.id === task.id ? { ...item, state: 'succeeded', status: translate(result.readOnly ? result.inspected ? '已查看，未修改场景' : '仅回复，未操作场景' : '没有需要应用的修改'), summary: result.summary } : item);
      return { ok: true, changed: false, readOnly: result.readOnly, mode, summary: result.summary };
    }
    setStatus(translate('正在渲染预览…'));
    const nextScene = result.sceneChanged ? result.scene : baseScene;
    const plan = mode === 'animation' && result.plan ? { ...result.plan, name:uniquePlanName(plans.value,result.plan.name), id: task.id, instruction: requirement, summary: result.summary } : undefined;
    const nextLighting = result.stage.lighting, nextSettings = { ...result.stage.settings, panoramaUrl: settings.panoramaUrl }, nextAspect = stageAspect(result.stage.aspectRatio);
    const image = await renderPreview(nextScene, plan, nextLighting, nextSettings, nextAspect);
    controller.signal.throwIfAborted();
    const saving = modelSaving.then(async () => {
      controller.signal.throwIfAborted();
      if (disposed) throw new DOMException(translate('已停止'), 'AbortError');
      if (scene.value !== baseScene || JSON.stringify(anchors.value)!==JSON.stringify(baseAnchors)) throw new DirectorTaskError(translate('基础模型已被另一条指令更新，请基于当前模型重试。'));
      if (result.stageChanged && JSON.stringify({ lighting: data.value.lighting, settings: data.value.sceneSettings, ratio: data.value.aspectRatio }) !== stageBefore) throw new DirectorTaskError(translate('灯光或环境已被另一处修改，请基于当前设置重试。'));
      const objects = new Map(nextScene.objectList.map(object => [object.threeJsonId, object]));
      const previousPlans = result.sceneChanged ? plans.value.map(item => ({ ...item, tracks: item.tracks.filter(track => objects.has(track.objectId) && (!track.joint || objects.get(track.objectId)?.objType === 'mannequin')) })) : plans.value;
      const value: ModelDocument = { version: 1, scene: nextScene, plans: plan ? [...previousPlans, plan] : previousPlans };
      await prepareModel(value,result.anchors,controller.signal);
      controller.signal.throwIfAborted();
      // Once this atomic write starts, stop is disabled: a committed edit must never be labelled cancelled.
      tasks.value = tasks.value.map(item => item.id === task.id ? { ...item, state: 'applying', status: translate('正在保存场景与动画方案…'), traces: [...item.traces, { id: task.id + ':apply', name: 'applyDirectorCandidate', label: mode === 'scene' ? '保存场景' : '保存动画方案', status: 'running', startedAt: Date.now(), details: [translate('{0} 个物体', { 0: nextScene.objectList.length }),translate('{0} 个机位',{0:result.anchors.length})] }] } : item);
      const path = await writeModel(workspaceFiles, value, result.anchors);
      if (disposed) return;
      rememberModel();
      if (plan) planPreviews.set(plan, { scene: nextScene, lighting: nextLighting, settings: nextSettings, aspect: nextAspect, image });
      if (result.stageChanged) { lighting.value = { ...result.stage.lighting }; sceneSettings.value = nextSettings; aspectRatio.value = result.stage.aspectRatio; }
      modelDocument.value = value; data.value.modelPath = path; data.value.anchors=value.anchors??result.anchors;
      selectedObjectId.value = result.selectedObjectIds[0] ?? '';
      if ((data.value.selectedPlanId ?? '') === basePlanId) data.value.selectedPlanId = plan?.id ?? '';
    });
    modelSaving = saving.catch(() => {});
    await saving;
    if (disposed) return { ok: false, cancelled: true };
    tasks.value = tasks.value.map(item => item.id === task.id ? { ...item, state: 'succeeded', status: translate(mode === 'scene' ? '场景已更新' : '动画方案已保存'), summary: result.summary, traces: item.traces.map(trace => trace.name === 'applyDirectorCandidate' && trace.status === 'running' ? { ...trace, status: 'success', durationMs: Math.max(0, Date.now() - trace.startedAt), outcome: translate(mode === 'scene' ? '场景已更新' : '动画方案已保存') } : trace) } : item);
    if(plan&&data.value.selectedPlanId===plan.id&&editorContext?.recordingTarget){await nextTick();await editorView.value?.resumeRecordingTarget(editorContext.recordingTarget);}
    if(result.anchorsChanged&&result.selectedAnchorId&&result.selectedAnchorId!==editorContext?.selectedAnchor?.id){await nextTick();editorView.value?.selectAnchor(result.selectedAnchorId);}
    return { ok: true, anchorsChanged:result.anchorsChanged, changed: true, mode, summary: result.summary, planId: plan?.id, sceneChanged: result.sceneChanged, objects: nextScene.objectList.length };
  } catch (error) {
    const applying = tasks.value.find(item => item.id === task.id)?.state === 'applying';
    const cancelled = controller.signal.aborted && !applying;
    if (applying && !disposed) modelError.value = translate('保存结果未确认，请重新打开导演台检查');
    const message = applying ? translate('保存结果未确认，请重新打开导演台检查') : cancelled ? translate('已停止，未应用本轮修改') : error instanceof DirectorTaskError ? error.message : publicError(error);
    if (!disposed) {
      tasks.value = tasks.value.map(item => item.id === task.id ? { ...item, state: applying ? 'interrupted' : cancelled ? 'cancelled' : 'failed', error: cancelled ? undefined : message, status: message, traces: item.traces.map(trace => trace.status === 'running' ? { ...trace, status: 'interrupted', outcomeUnknown: applying && trace.name === 'applyDirectorCandidate', durationMs: Math.max(0, Date.now() - trace.startedAt) } : trace) } : item);
      if (!prompt.value.trim()) setPrompt(requirement);
    }
    return { ok: false, cancelled, error: message };
  } finally {
    externalSignal?.removeEventListener('abort', cancel);
    generationControllers.delete(task.id);
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
  name: 'addDirectorMannequin', description: '在现有 3D 场景中添加内置关节人偶，复用界面添加角色功能；bodyType 选体型（standard 标准男性、female 标准女性、athletic 健硕、slim 纤细、teen 少年、child 儿童、broad 宽厚、chibi 二头身），crowd=true 一次添加 3x3 群众。没有动画方案也能使用。不调用模型。',
  parameters: z.strictObject({ bodyType: z.enum(bodyTypeIds).optional(), crowd: z.boolean().optional() }), execute(args, { signal }) { return addMannequin(signal, args); },
});
nodeTools.register({
  name: 'getDirectorAssets', description: '读取内置布景库、道具和人偶姿势。预设是可编辑的实际几何体；添加不调用模型。姿势的 pose 是可写入场景对象的关节弧度值，height 是相对自然站立的高度偏移。',
  parameters: z.strictObject({}), execute: () => ({ props: propPresets, sets: setPresets, poses: posePresets, bodyTypes: Object.entries(bodyTypes).map(([id, { name }]) => ({ id, name })) }),
});
nodeTools.register({
  name: 'addDirectorAsset', description: '从内置库添加道具或整套布景到当前场景，保留已有物体；先用 getDirectorAssets 获取 id。不调用模型、不扣积分。',
  parameters: z.strictObject({ kind: z.enum(['prop', 'set']), id: z.string().min(1), position: z.strictObject({ x: z.number().min(-100).max(100), y: z.number().min(-100).max(100), z: z.number().min(-100).max(100) }).optional() }),
  async execute(args, { signal }) {
    signal?.throwIfAborted();
    const prop = propPresets.find(p => p.id === args.id), set = setPresets.find(p => p.id === args.id);
    if (args.kind === 'prop' ? !prop : !set) throw new Error(translate('物体已不存在，请重新选择'));
    let objects = localizeStageObjects(args.kind === 'prop' ? createProp(prop!.id) : createSet(set!.id));
    if (args.position) objects = offsetStageObjects(objects, args.position);
    const saved = await addObjects(objects);
    if (!saved) throw new Error(translate('物体修改失败'));
    return { saved: true, assets: stageAssemblies(objects), objectIds: objects.map(o => o.threeJsonId), objectCount: scene.value.objectList.length };
  },
});
nodeTools.register({
  name: 'updateDirectorAsset', description: '整体操作内置椅子、桌子等组合道具，assetId 来自 readDirector.assets。update 修改位置、旋转、统一缩放或材质；copy 复制，remove 删除全部零件，ungroup 拆成独立零件。保留稳定零件 ID，支持撤销，不调用模型。',
  parameters: stageAssetEditSchema,
  async execute(args) {
    let result: ReturnType<typeof editStageAsset> | undefined;
    const saved = await changeScene(value => {
      result = editStageAsset(value.scene, args); value.scene = result.scene;
      const ids = new Set(value.scene.objectList.map(object => object.threeJsonId));
      value.plans = value.plans.map(plan => ({ ...plan, tracks: plan.tracks.filter(track => ids.has(track.objectId)) }));
      return value;
    });
    if (!saved || !result) throw new Error(translate('物体修改失败'));
    selectedObjectId.value = result.action === 'remove' ? '' : result.action === 'ungroup' ? result.objectIds[0] ?? '' : result.assetId;
    const { scene: _scene, ...summary } = result; return { saved: true, ...summary };
  },
});
nodeTools.register({
  name: 'createDirectorCameraMotion', description: '使用已记录的至少两个机位按顺序创建本地运镜方案；不调用模型、不消耗积分。duration 是总秒数，easing 是每段过渡（smooth 平滑、linear 匀速、cut 切镜）。保留已有方案，创建后选中新方案；人物保持基础场景姿势。',
  parameters: z.strictObject({ duration: z.number().min(0.2).max(300), easing: z.enum(['smooth', 'linear', 'cut']).default('smooth') }),
  execute: ({ duration, easing }) => createCameraMotion(duration, easing),
});
nodeTools.register({
  name: 'applyDirectorPose', description: '使用共用姿势库。target=scene 修改基础场景；target=animation 按 time（省略为播放头）录入当前/指定 planId 的姿势关键帧，不改基础场景。省略 target 时，录帧开启或提供 time/planId 使用 animation，否则沿用静态摆姿势。objectId 省略只用唯一当前选中人偶。支持撤销，不调用模型。',
  parameters:z.strictObject({objectId:z.string().min(1).optional(),presetId:z.string().min(1),target:z.enum(['scene','animation']).optional(),time:z.number().min(0).max(300).optional(),planId:z.string().min(1).optional()}),
  async execute({objectId,presetId,target,time,planId},{signal}){
    await modelReady;await modelSaving;assertDirectorIdle(signal);
    const context=editorView.value?.getContext(),ids=selectedObjectIds(),id=objectId??(ids.length===1?ids[0]:undefined),destination=target??(time!==undefined||planId||context?.recordingKeyframes?'animation':'scene'),at=time??context?.time??0;
    if(destination==='scene'&&(planId||time!==undefined&&time!==0))throw Error(translate('基础场景姿势不使用动画时间'));
    let failure:unknown;const selected=destination==='animation'?planId??data.value.selectedPlanId:undefined;
    const saved=await changeScene(value=>{
      const index=value.scene.objectList.findIndex(o=>o.threeJsonId===id);if(index<0)throw Error(translate('物体已不存在，请重新选择'));
      if(destination==='animation'){const plan=value.plans.find(p=>p.id===selected);if(!plan)throw Error(translate('请先选择动画方案'));const next=applyTimelinePosePreset(value.scene,plan,id!,presetId,at);if(JSON.stringify(next)===JSON.stringify({name:plan.name,duration:plan.duration,tracks:plan.tracks,cameraFrames:plan.cameraFrames}))return value;value.plans=value.plans.map(p=>p.id===selected?{...p,...next,source:'manual' as const}:p);}
      else value.scene.objectList[index]=applyActorPosePreset(value.scene.objectList[index]!,presetId);
      return value;
    },undefined,selected,undefined,error=>failure=error);
    if(!saved)throw failure??new Error(translate('物体修改失败'));
    return{saved:true,objectId:id,presetId,target:destination,...(destination==='animation'?{time:at,planId:selected}:{})};
  },
});

nodeTools.register({
  name: 'restoreDirectorHistory', description: '撤销或重做最近的导演台场景/方案编辑，和界面按钮共用历史；AI 与手动修改均可回退。不调用模型。',
  parameters: z.strictObject({ direction: z.enum(['undo', 'redo']) }),
  async execute({ direction }, { signal }) { signal?.throwIfAborted(); const changed = await restoreHistory(direction); if (changed === false) throw new Error(translate('物体修改失败')); return { changed: changed === true, canUndo: undoStack.value.length > 0, canRedo: redoStack.value.length > 0 }; },
});
nodeTools.register({
  name: 'setDirectorOptions', description: '设置导演台实际预览和导出共用的灯光、网格及天空；省略字段保持原值。当前值用 readDirector 读取。不调用模型。',
  parameters: z.strictObject({
    lighting: z.strictObject({ globalEnabled: z.boolean().optional(), globalIntensity: z.number().min(0).max(100).optional(), sunEnabled: z.boolean().optional(), azimuth: z.number().min(0).max(360).optional(), elevation: z.number().min(-90).max(90).optional(), color: z.string().regex(/^#[\da-f]{6}$/i).optional(), intensity: z.number().min(0).max(100).optional() }).optional(),
    settings: z.strictObject({ gridVisible: z.boolean().optional(), skyVisible: z.boolean().optional(), backgroundColor: z.string().regex(/^#[\da-f]{6}$/i).optional(), groundVisible: z.boolean().optional(), groundColor: z.string().regex(/^#[\da-f]{6}$/i).optional(), groundHeight: z.number().min(-100).max(100).optional(), groundOpacity: z.number().min(0).max(1).optional(), labelsVisible: z.boolean().optional(), snapToGrid: z.boolean().optional(), panoramaRotation: z.number().min(-360).max(360).optional() }).optional(),
  }),
  async execute(args, { signal }) {
    await modelReady; await modelSaving; assertDirectorIdle(signal);
    if (args.lighting) lighting.value = { ...lighting.value, ...args.lighting };
    if (args.settings) sceneSettings.value = { ...sceneSettings.value, ...args.settings };
    return { lighting: lighting.value, settings: sceneSettings.value };
  },
});
nodeTools.register({
  name: 'selectDirectorPlan', description: '切换到已保存的导演动画方案，planId 来自 readDirector 的 plans；选中有效方案会同步切换为 animation 任务类型。空字符串切回基础场景预览，保留当前任务类型以便从基础场景新建动画。保留其他方案，不重新生成。',
  parameters: z.strictObject({ planId: z.string().max(100) }),
  async execute({ planId }, { signal }) {
    await modelReady; await modelSaving; assertDirectorIdle(signal);
    if (planId && !plans.value.some(plan => plan.id === planId)) throw new Error('历史方案不存在，请重新读取');
    data.value.selectedPlanId = planId;
    return { selectedPlanId: planId, mode:aiMode.value, plan: selectedPlan.value ? JSON.parse(JSON.stringify(selectedPlan.value)) : null };
  },
});
nodeTools.register({
  name: 'editDirectorAnchors', description: '管理导演台参考镜头关键帧：add 新增（不传 view 使用已保存场景镜头，捕捉编辑器当前镜头用 controlDirectorView）；update/remove 使用已有 anchorId；reorder 提供全部现有 anchorIds 的新顺序。view 采用真实 camera/controls 结构，time 为秒；不生成动画。',
  parameters: z.strictObject({ action: z.enum(['add','update','remove','reorder']), anchorId: z.string().min(1).optional(), name: z.string().trim().min(1).max(100).optional(), anchorIds: z.array(z.string().min(1)).max(100).optional(), view: cameraViewSchema.optional(), time: z.number().min(0).max(300).optional() }),
  async execute(args, { signal }) {
    await modelReady; await modelSaving; assertDirectorIdle(signal);
    const current = anchors.value;
    let changed: CameraAnchor | undefined;
    if (args.action === 'reorder') {
      const ids = args.anchorIds;
      if (!ids || ids.length !== current.length || new Set(ids).size !== ids.length || ids.some(id => !current.some(anchor => anchor.id === id))) throw new Error('anchorIds 必须包含全部现有关键帧且不重复');
      anchors.value = ids.map(id => current.find(anchor => anchor.id === id)!);
    } else if (args.action === 'add') {
      if (current.length >= 100) throw new Error('最多记录 100 个关键帧');
      changed = anchorSchema.parse({ ...(args.view ?? scene.value.sceneConfig), name: args.name, time: args.time ?? 0 });
      anchors.value = [...current, changed];
    } else {
      const anchor = current.find(anchor => anchor.id === args.anchorId);
      if (!anchor) throw new Error('关键帧不存在，请先 readDirector');
      if (args.action === 'remove') anchors.value = current.filter(item => item.id !== anchor.id);
      else {
        changed = anchorSchema.parse({ ...anchor, ...args.view, name: args.name ?? anchor.name, time: args.time ?? anchor.time });
        anchors.value = current.map(item => item.id === anchor.id ? changed! : item);
      }
    }
    await modelSaving; if(modelError.value)throw new Error(modelError.value);
    return { anchor: changed, anchorIds: anchors.value.map(anchor => anchor.id), count: anchors.value.length };
  },
});
nodeTools.register({
  name: 'exportDirectorImage', description: '按当前灯光、天空与比例导出PNG并添加到画布。传anchorId使用readDirector中的基础机位；省略anchorId使用当前动画在time（省略为播放头）处的真实镜头，没有动画则导出基础场景。不调用图片或视频模型。',
  parameters: z.strictObject({ anchorId: z.string().min(1).optional(), time: z.number().min(0).max(300).optional() }),
  async execute({ anchorId, time }, { signal }) {
    await modelReady; await modelSaving; assertDirectorIdle(signal);
    const anchor = anchorId?anchors.value.find(anchor => anchor.id === anchorId):undefined;
    if (anchorId&&!anchor) throw new Error('关键帧不存在，请先读取导演台');
    const position = time ?? (anchor?anchor.time??0:editorView.value?.getContext().time??0);
    if (selectedPlan.value && position > selectedPlan.value.duration) throw new Error('时间超过当前方案时长');
    const result = await exportImage(anchor, sceneAspect.value, position, signal);
    if (!result) throw new Error('关键帧导出未完成');
    if (result.ok === false) throw new Error(result.error || '关键帧导出未完成');
    return result;
  },
});
nodeTools.register({
  name: "exportDirectorVideo",
  description: "将已保存的当前白模方案在本机渲染为 MP4，并放入新的画布视频节点。沿用已保存画面比例；anchorId 指定机位，省略时在镜头录帧模式使用方案运镜，其他状态沿用编辑器当前选中机位，没有选中则使用方案运镜。绑定跟随/注视按每帧角色位置解析，无需视频生成模型。导出耗时接近片长，窗口需保持可见；返回实际文件路径和节点 ID。",
  parameters: z.strictObject({anchorId:z.string().min(1).optional()}),
  async execute({anchorId}, { signal }) {
    await modelReady;
    if (modelError.value) throw new Error(modelError.value);
    if (exportingVideo.value || exportingImage.value || tasks.value.some(isDirectorGenerationPending)) throw new Error("导演台正在生成或导出，请等待当前任务完成");
    const base = selectedPlan.value;
    if (!base) throw new Error("当前导演台还没有可导出的动画方案");
    const context=editorView.value?.getContext();const id=anchorId??(context?.recordingTarget?.kind==='camera'?undefined:context?.selectedAnchor?.id);const camera=id?anchors.value.find(a=>a.id===id):undefined;if(id&&!camera)throw new Error('机位不存在，请重新读取导演台');
    const plan=camera?{...base,cameraFrames:[{time:0,view:cameraViewSchema.parse({camera:camera.camera,controls:camera.controls}),easing:'smooth' as const}]}:base;
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
  description: "按节点基础场景或当前选中动画方案的运镜渲染真实画面；timestamps 为时长内 1–4 个时间点，无动画方案时用 [0]。summary.samples 返回相同时刻的精确物体与相机数值，核对人数、姿态和构图。此工具不跟随编辑器临时视角，不接受 anchorId；指定基础机位的截图使用 exportDirectorImage 的 anchorId，会新增 PNG 节点。只读，不调用模型；修改后回看最新状态，再决定是否交付。",
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
  description: "读取 3D 导演台的基础场景、稳定物体/组合道具 ID、机位、灯光、已保存方案、提示词和编辑器上下文。objects.position 是基础场景坐标，不是当前动画姿态；当前播放头的精确世界坐标用 editor.sampledState，选中关键帧用 editor.timeline.selectedFrame，录帧目标用 editor.recordingTarget。editor 为空或未就绪时先 setDirectorEditor 打开，再查询 controlDirectorView 的 status，不猜当前帧。section=scene / plan 返回完整 JSON，summary 默认概览，schema 返回场景/方案/编辑操作的真实 JSON Schema；section=plan 配合 planId 读取指定已保存方案。等待场景文件加载，失败会报错，可重新打开编辑器重试。",
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
    await modelSaving;
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
      objects: scene.value.objectList.map(item => ({ id: item.threeJsonId, name: item.name ?? "", type: item.objType, position: item.position, ...(item.bodyType ? { bodyType: item.bodyType } : {}) })),
      assets: stageAssemblies(scene.value.objectList),
      camera: JSON.parse(JSON.stringify(scene.value.sceneConfig.camera)),
      lights: scene.value.sceneConfig.lights.length,
      plans: plans.value.map(item => ({ id: item.id, name: item.name, displayName:planLabels.value.get(item.id), duration: item.duration, tracks: item.tracks.length, cameraFrames: item.cameraFrames.length, instruction: item.instruction ?? "" })),
      selectedPlanId: data.value.selectedPlanId ?? "",
      aspectRatio: aspectRatio.value,
      settings: JSON.parse(JSON.stringify(sceneSettings.value)),
      appearance: { backgroundColor: sceneBackground(scene.value, sceneSettings.value) },
      lighting: JSON.parse(JSON.stringify(lighting.value)),
      editorOpen: editing.value,
      loading: modelLoading.value,
      tasks: tasks.value.slice(-5).map(({ id, instruction, mode, state, status, error, summary, traces, referenceHistory }) => ({ id, referenceHistory, stepCount: traces.length, recentSteps: traces.slice(-4).map(trace => ({ label: trace.label, target: trace.target, status: trace.status, outcome: trace.outcome })), instruction: instruction.slice(0, 500), mode, state, status, error, summary: summary?.slice(0, 1500), summaryTruncated: Boolean(summary && summary.length > 1500) })),
      taskCount: tasks.value.length, tasksTruncated: tasks.value.length > 5,
      aiMode: aiMode.value,
      error: modelError.value,
      selectedObjectIds: selectedObjectIds(),
      editor: editorView.value?.getContext() ?? null,
      canUndo: undoStack.value.length > 0, canRedo: redoStack.value.length > 0,
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
    const draft = createDirectorDraft(sceneSnapshot(), planForDraft(selectedPlan.value), JSON.parse(JSON.stringify(plans.value)), { selectedObjectIds: selectedObjectIds() });
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
    const plan = parsedPlan.success ? { ...previous.find(item => item.id === planId), ...parsedPlan.data, id: planId } : undefined;
    const objects = new Map(nextScene.objectList.map(object => [object.threeJsonId, object]));
    const nextPlans = (plan ? previous.some(item => item.id === planId) ? previous.map(item => item.id === planId ? plan : item) : [...previous, plan] : previous)
      .map(item => draft.sceneChanged ? { ...item, tracks: item.tracks.filter(track => objects.has(track.objectId)) } : item);
    const saving = modelSaving.then(async () => {
      signal?.throwIfAborted();
      if (disposed) throw new Error('导演节点已关闭');
      const value: ModelDocument = { version: 1, scene: nextScene, plans: nextPlans };
      const path = await writeModel(files.getWorkspaceFiles(), value);
      if (disposed) throw new Error('导演节点已关闭');
      rememberModel();
      modelDocument.value = value;
      data.value.anchors=JSON.parse(JSON.stringify(value.anchors??anchors.value));
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
  description: "调用导演台内的文本模型完成一轮任务。mode=scene 只更新基础场景，mode=animation 创建动画方案；省略沿用界面模式。会产生文本模型调用，只在用户明确要求时使用；普通局部编辑优先直接调用节点工具。",
  parameters: z.strictObject({ instruction: z.string().max(4000).optional(), mode: directorModeSchema.optional() }),
  async execute({ instruction, mode }, { signal }) {
    if (tasks.value.some(isDirectorGenerationPending)) throw new Error("这个导演台已有任务正在执行，请等待该任务结果，不要重复生成");
    if (mode) {aiMode.value = mode;await nextTick();}
    if (instruction !== undefined) setPrompt(instruction);
    const result = await generate(signal, mode);
    if (!result?.ok) throw new Error(result?.error || "导演台未完成修改，原方案已保留");
    return result;
  },
});
nodeTools.register({
  name: 'setDirectorMode', description: '切换导演台内 LLM 的任务类型，不发起模型调用。scene 编辑基础场景并切回静态预览，animation 生成动画方案。',
  parameters: z.strictObject({ mode: directorModeSchema }),
  async execute({ mode }, { signal }) { await modelReady; await modelSaving; assertDirectorIdle(signal); aiMode.value = mode;await nextTick(); return { mode: aiMode.value, selectedPlanId: data.value.selectedPlanId ?? '' }; },
});
nodeTools.register({
  name: 'stopDirectorTask', description: '请求停止导演台内正在执行的 LLM 任务。taskId 来自 readDirector；省略时停止当前任务。已进入原子保存阶段不能取消，返回 stopped=false。通过 runDirector 发起的任务也可由发起方取消原调用的 signal；本工具主要用于停止界面发起的任务，不会再次调用模型。',
  parameters: z.strictObject({ taskId: z.string().min(1).optional() }),
  execute({ taskId }) { const task = tasks.value.find(item => taskId ? item.id === taskId : isDirectorGenerationPending(item)); return { stopped: task ? cancelGeneration(task.id) : false, taskId: task?.id ?? null, state: task ? tasks.value.find(item => item.id === task.id)?.state : null }; },
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
