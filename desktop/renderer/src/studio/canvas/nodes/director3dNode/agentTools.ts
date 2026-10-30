import { z, type NodeAiTool } from "@miaoimg/nodes-scaffold/runtime";
import { editStageAsset, offsetStageObjects, stageAssemblies, stageAssetEditSchema } from './stageGroups';
import type { CameraSnapshotRequest } from './cameraReconciliation';
import { validateCameraTargets } from './cameraTracking';
import { applyTimelinePosePreset } from './timeline';
import { sceneSchema, createMannequinObject, type SceneDocument } from "./scene";
import { bodyTypeIds, bodyTypes } from "./mannequin";
import { actorColors, propPresets, setPresets, posePresets, createProp, createSet, localizeStageObjects, applyActorPosePreset } from "./stageLibrary";
import { translate } from "@miaoimg/i18n/vue";
import { directorPlanSchema, type DirectorPlan, type DirectorPlanItem } from "./sceneAnimation";

const pathSchema = z.array(z.union([
  z.string().max(100).refine(value => !["__proto__", "constructor", "prototype"].includes(value), "路径不允许访问原型"),
  z.number().int().min(0).max(2000),
])).max(24);
const selection = {
  objectId: z.string().min(1).max(100).optional().describe("稳定ID；提供后，scene的path从该物体开始，plan的path从该动作轨道开始，不再重复objectList/tracks前缀"),
  joint: directorPlanSchema.shape.tracks.element.shape.joint,
};
const readSchema = z.strictObject({
  section: z.enum(["scene", "plan", "history", "schema"]).describe("plan是当前私有动画草稿，不传planId；history是按planId读取的历史方案；schema读取工具结构"),
  ...selection,
  planId: z.string().min(1).max(100).optional().describe("仅section=history时提供；读取当前草稿用section=plan，不传此字段"),
  path: pathSchema.optional().describe("相对路径数组。已传objectId时，plan读取帧用['frames']；未传objectId时可用['tracks',0,'frames']。空数组读取已选物体/轨道，省略objectId且path为空则读整个section"),
});
export const operationSchema = z.strictObject({
  section: z.enum(["scene", "plan"]),
  ...selection,
  path: pathSchema.describe("相对所选物体/轨道的路径。传了objectId时不要重复objectList/tracks前缀；未传objectId才从section根节点开始"),
  op: z.enum(["add", "replace", "remove"]),
  value: z.json().optional(),
});
export const directorModeSchema = z.enum(["scene", "animation"]);
export type DirectorMode = z.infer<typeof directorModeSchema>;

const editSchema = z.strictObject({ operations: z.array(operationSchema).min(1).max(100) });
type Draft = { scene: SceneDocument; plan: Partial<DirectorPlan> };
type Path = z.infer<typeof pathSchema>;

function checkSize(value: unknown) {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 500000) throw new Error("草稿或工具参数超过 500 KB，请精简场景或关键帧");
}

function readPath(value: unknown, path: Path): unknown {
  for (const key of path) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)
      || (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(String(key)))) {
      throw new Error(`路径不存在：${path.join(".")}`);
    }
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}

function selectionPath(value: unknown, section: "scene" | "plan", objectId?: string, joint?: string): Path {
  if (joint && (section !== "plan" || !objectId)) throw new Error("joint 只能与 plan 的 objectId 一同使用");
  if (!objectId) return [];
  const key = section === "scene" ? "objectList" : "tracks";
  const items = readPath(value, [key]) as (SceneDocument["objectList"][number] & DirectorPlan["tracks"][number])[];
  const index = items.findIndex(item => section === "scene" ? item.threeJsonId === objectId : item.objectId === objectId && item.joint === joint);
  if (index < 0) throw new Error(`找不到${section === "scene" ? "物体" : "轨道"}：${objectId}${joint ? ` / ${joint}` : ""}`);
  return [key, index];
}

function applyOperation(draft: Draft, operation: z.infer<typeof operationSchema>) {
  const { section, op, value } = operation;
  if (op !== "remove" && !Object.hasOwn(operation, "value")) throw new Error(`${op} 必须提供 value`);
  const path = [...selectionPath(draft[section], section, operation.objectId, operation.joint), ...operation.path];
  if (!path.length) {
    if (op !== "replace") throw new Error("整个 scene 或 plan 只允许 replace；请用相对路径添加或删除字段");
    Object.assign(draft, { [section]: structuredClone(value) });
    return;
  }
  const key = path.pop()!;
  const parent = readPath(draft[section], path);
  if (!parent || typeof parent !== "object") throw new Error(`路径不是对象或数组：${path.join(".")}`);
  if (Array.isArray(parent)) {
    const index = key === "-" && op === "add" ? parent.length : /^(0|[1-9]\d*)$/.test(String(key)) ? Number(key) : -1;
    if (index < 0 || index >= parent.length + Number(op === "add")) throw new Error(`数组位置不存在：${[...path, key].join(".")}`);
    if (op === "remove") parent.splice(index, 1);
    else if (op === "add") parent.splice(index, 0, structuredClone(value));
    else parent[index] = structuredClone(value);
    return;
  }
  const object = parent as Record<string | number, unknown>;
  const exists = Object.hasOwn(object, key);
  if (op === "add" ? exists : !exists) throw new Error(`字段${exists ? "已存在，请使用 replace" : "不存在"}：${[...path, key].join(".")}`);
  if (op === "remove") delete object[key];
  else object[key] = structuredClone(value);
}

function validateDraft(draft: Draft, complete = false, mode: DirectorMode = "animation") {
  checkSize(draft);
  const scene = sceneSchema.parse(draft.scene);
  const plan = directorPlanSchema.safeParse(draft.plan);
  if (mode === 'scene') {
    draft.scene = scene;
    return { valid: true, planReady: plan.success, issues: [] as string[] };
  }
  const issues = plan.success ? [] : plan.error.issues;
  // ACT: 仅允许顶层必填项尚未补齐；字段结构、数值和已完整方案的约束仍拒绝整批修改。
  const incomplete = (issue: z.core.$ZodIssue) => issue.path.length === 1 && (
    (issue.code === "invalid_type" && !Object.hasOwn(draft.plan, issue.path[0]!))
    || (issue.code === "too_small" && issue.path[0] === "cameraFrames" && draft.plan.cameraFrames?.length === 0)
    || (issue.code === "custom" && issue.path[0] === "cameraFrames" && draft.plan.cameraFrames?.length === 0)
  );
  const invalid = complete ? issues : issues.filter(issue => !incomplete(issue));
  if (invalid.length) throw new Error(invalid.slice(0, 8).map(issue => `plan.${issue.path.join(".")}：${issue.message}`).join("\n"));
  const objects = new Map(scene.objectList.map(object => [object.threeJsonId, object]));
  for (const track of draft.plan.tracks ?? []) {
    const object = objects.get(track.objectId);
    if (!object) throw new Error(`tracks 引用了不存在的物体：${track.objectId}，删除物体时需同时删除其轨道`);
    if (track.joint && object.objType !== "mannequin") throw new Error(`只有人偶支持关节轨道：${track.objectId} / ${track.joint}`);
  }
  draft.scene = scene;
  if (plan.success) draft.plan = plan.data;
  return { valid: plan.success, planReady: plan.success, issues: issues.map(issue => `plan.${issue.path.join(".")}：${issue.message}`) };
}

export function createDirectorDraft(scene: SceneDocument, plan?: DirectorPlan, plans: DirectorPlanItem[] = [], context: { selectedObjectIds?: string[]; mode?: DirectorMode; time?:number } = {}) {
  let draft: Draft = structuredClone({ scene, plan: plan ?? { tracks: [], cameraFrames: [] } });
  const history = structuredClone(plans);
  const mode = context.mode ?? "animation";
  validateDraft(draft, false, mode);
  const originalScene = JSON.stringify(draft.scene);
  const originalPlan = JSON.stringify(draft.plan);
  let edited = false;
  let revision = 0;
  let currentSelection = [...(context.selectedObjectIds ?? [])];

  const tools: NodeAiTool[] = [{
    name: "readDocument",
    description: "读取本轮独立草稿的 scene / plan；objectId 选择场景物体或方案轨道，joint 选择人偶关节轨道，path 为相对字段路径。history 只读且必须提供 planId。schema 可用 path ['scene'] / ['plan'] 读取 JSON Schema。按需读取，避免反复读取完整文档。",
    parameters: z.toJSONSchema(readSchema),
    execute(args, signal) {
      signal?.throwIfAborted();
      const { section, objectId, joint, planId, path = [] } = readSchema.parse(args);
      if (section === "schema") {
        if (objectId || joint || planId) throw new Error("schema 不支持 objectId、joint 或 planId");
        return readPath({ scene: z.toJSONSchema(sceneSchema), plan: z.toJSONSchema(directorPlanSchema) }, path);
      }
      let value: unknown = section === "history" ? history.find(item => item.id === planId) : draft[section];
      if (section === "history" && (!planId || !value)) throw new Error("历史方案不存在，请从摘要中选择有效 planId");
      if (section !== "history" && planId) throw new Error("planId 仅用于只读 history");
      const selected = selectionPath(value, section === "scene" ? "scene" : "plan", objectId, joint);
      value = readPath(value, [...selected, ...path]);
      checkSize(value);
      return { value: structuredClone(value), selectedObjectIds: currentSelection, ...validateDraft(draft, false, mode) };
    },
  }, {
    name: "editDocument",
    description: "原子批量修改本轮 scene / plan 草稿，不修改历史和磁盘。objectId / joint 按稳定 ID 选择现有物体/轨道，path 为相对路径。add 添加新字段或插入数组，数组下标 '-' 表示追加；replace / remove 必须命中已有路径。添加物体用 scene 的 ['objectList','-']，添加轨道用 plan 的 ['tracks','-']。任何非法操作整批撤销。返回 valid=false 时只保存了未完成草稿，必须依据 issues 补齐，直到 valid=true。",
    parameters: z.toJSONSchema(editSchema),
    execute(args, signal) {
      signal?.throwIfAborted();
      checkSize(args);
      const { operations } = editSchema.parse(args);
      const next = structuredClone(draft);
      if (mode === 'scene' && operations.some(operation => operation.section === 'plan')) throw new Error('本轮只编辑基础场景，动画方案只读；需要动画时请选择 animation 模式');
      operations.forEach(operation => applyOperation(next, operation));
      const groups = new Map(stageAssemblies(draft.scene.objectList).map(({ objectIds: _ids, ...group }) => [group.id, JSON.stringify(group)]));
      if (stageAssemblies(next.scene.objectList).some(({ objectIds: _ids, ...group }) => groups.get(group.id) !== JSON.stringify(group))) throw new Error('整体道具变换请使用 updateStageAsset，保留零件之间的关系');
      const validation = validateDraft(next, false, mode);
      signal?.throwIfAborted();
      draft = next;
      edited = true; revision++;
      return { applied: operations.length, ...validation };
    },
  }];

  const assetSchema = z.strictObject({ kind: z.enum(['actor', 'prop', 'set']), presetId: z.string().min(1).optional(), bodyType: z.enum(bodyTypeIds).optional(), name: z.string().trim().min(1).max(100).optional(), position: sceneSchema.shape.objectList.element.shape.position.optional() });
  tools.push({
    name: 'getStageLibrary', description: '读取与手动布景库相同的角色、道具、场景和姿势预设。添加使用 addStageAsset；人偶摆姿使用 applyActorPose，不必手写几何体或猜关节弧度。',
    parameters: z.toJSONSchema(z.strictObject({})), execute: () => ({ props: propPresets, sets: setPresets, poses: posePresets.map(({ id, name }) => ({ id, name })), bodyTypes: Object.entries(bodyTypes).map(([id, { name }]) => ({ id, name })) }),
  }, {
    name: 'addStageAsset', description: '添加真实内置几何体到本轮草稿，保留其他物体；kind=actor 添加一个关节人偶（bodyType 取 getStageLibrary 的 bodyTypes，省略为标准男性），prop/set 的 presetId 来自 getStageLibrary。position 是相对预设的位移。返回新物体的稳定 objectIds。',
    parameters: z.toJSONSchema(assetSchema),
    execute(args, signal) {
      signal?.throwIfAborted();
      const request = assetSchema.parse(args);
      let objects: SceneDocument['objectList'];
      if (request.kind === 'actor') {
        const count = draft.scene.objectList.filter(o => o.objType === 'mannequin').length;
        const actor = createMannequinObject(crypto.randomUUID());
        actor.name = request.name ?? `${translate('角色')}${count < 26 ? String.fromCharCode(65 + count) : count + 1}`;
        actor.material.color = actorColors[count % actorColors.length]!;
        actor.position.x = count;
        if (request.bodyType && request.bodyType !== 'standard') actor.bodyType = request.bodyType;
        objects = [actor];
      } else if (request.kind === 'prop') {
        const preset = propPresets.find(p => p.id === request.presetId);
        if (!preset) throw new Error('道具预设不存在，请先读取 getStageLibrary');
        objects = createProp(preset.id);
      } else {
        const preset = setPresets.find(p => p.id === request.presetId);
        if (!preset) throw new Error('场景预设不存在，请先读取 getStageLibrary');
        objects = createSet(preset.id);
      }
      objects = localizeStageObjects(objects);
      if (request.position) objects = offsetStageObjects(objects, request.position);
      if (request.name) {
        if (objects.length === 1) objects[0]!.name = request.name;
        else if (request.kind === 'prop') for (const object of objects) if (object.assembly) object.assembly.name = request.name;
      }
      const next = structuredClone(draft);
      next.scene.objectList.push(...objects);
      const validation = validateDraft(next, false, mode);
      signal?.throwIfAborted(); draft = next; edited = true; revision++;
      currentSelection = [objects[0]!.assembly?.id ?? objects[0]!.threeJsonId];
      return { assets: stageAssemblies(objects), objectIds: objects.map(o => o.threeJsonId), objects: objects.length, ...validation };
    },
  }, {
    name: 'updateStageAsset', description: '整体操作组合道具，assetId 来自摘要 assets 或 addStageAsset 的 assets。update 修改位置、弧度旋转、等比 scale 或颜色材质；copy 复制整体，remove 删除整体，ungroup 拆成独立零件。不要逐个移动椅面椅腿，也不要用 editDocument 改 assembly 字段。历史方案只读。',
    parameters: z.toJSONSchema(stageAssetEditSchema),
    execute(args, signal) {
      signal?.throwIfAborted();
      const result = editStageAsset(draft.scene, stageAssetEditSchema.parse(args));
      const next = structuredClone(draft); next.scene = result.scene;
      if (mode === 'animation' && result.action === 'remove') { const ids = new Set(next.scene.objectList.map(object => object.threeJsonId)); next.plan.tracks = next.plan.tracks?.filter(track => ids.has(track.objectId)); }
      const validation = validateDraft(next, false, mode); signal?.throwIfAborted();
      if (result.changed) { draft = next; edited = true; revision++; currentSelection = result.action === 'remove' ? [] : [result.action === 'ungroup' ? result.objectIds[0]! : result.assetId]; }
      const { scene: _scene, ...summary } = result; return { ...summary, ...validation };
    },
  }, {
    name: 'applyActorPose', description: mode==='scene'
      ? '对基础场景人偶应用与手动界面相同的静态姿势，正确还原坐姿高度；本模式不创建动画关键帧。presetId 来自 getStageLibrary；objectId 省略时使用唯一当前选中的人偶。'
      : '对当前动画草稿中的人偶录入姿势关键帧，不修改基础 scene。time 为秒，省略使用本轮开始时的播放头；先确保完整 plan（name/duration/cameraFrames/tracks）。姿势与手动录帧相同，保留水平运动与相机；只更新变化通道，坐站高度正确记账。修改后必须 inspectDocument 回看对应 time。',
    parameters: z.toJSONSchema(z.strictObject({ objectId: z.string().min(1).optional(), presetId: z.string().min(1),time:z.number().min(0).max(300).optional() })),
    execute(args, signal) {
      signal?.throwIfAborted();
      const { objectId, presetId,time } = z.strictObject({ objectId: z.string().min(1).optional(), presetId: z.string().min(1),time:z.number().min(0).max(300).optional() }).parse(args);
      const id = objectId ?? (currentSelection.length === 1 ? currentSelection[0] : undefined);
      const next = structuredClone(draft),index=next.scene.objectList.findIndex(o=>o.threeJsonId===id);
      if(index<0)throw Error('请先读取草稿并指定真实的人偶 objectId');
      const at=time??context.time??0;
      if(mode==='animation'){
        const parsed=directorPlanSchema.safeParse(next.plan);if(!parsed.success)throw Error(translate('请先补齐动画方案，再按时间录入姿势'));
        next.plan=applyTimelinePosePreset(next.scene,parsed.data,id!,presetId,at);
      }else{
        if(time!==undefined&&time!==0)throw Error(translate('基础场景姿势不使用动画时间'));
        next.scene.objectList[index]=applyActorPosePreset(next.scene.objectList[index]!,presetId);
      }
      const validation=validateDraft(next,false,mode);signal?.throwIfAborted();
      const changed=JSON.stringify(next)!==JSON.stringify(draft);
      if(changed){draft=next;edited=true;revision++;}
      return {objectId:id,presetId,mode,...(mode==='animation'?{time:at}:{}),changed,...validation};
    },
  });

  return {
    tools,
    checkpoint(){return {draft:structuredClone(draft),selection:[...currentSelection],revision,edited};},
    restore(checkpoint:{draft:Draft;selection:string[];revision:number;edited:boolean}){draft=structuredClone(checkpoint.draft);currentSelection=[...checkpoint.selection];revision=checkpoint.revision;edited=checkpoint.edited;},
    async reconcileCameraViews(repair:(requests:CameraSnapshotRequest[])=>Promise<{views:import('./scene').CameraView[];detachedBindings:number}>){
      const version=revision,frames=mode==='animation'?draft.plan.cameraFrames??[]:[];
      const repaired=await repair([{view:draft.scene.sceneConfig,time:0},...frames.map(f=>({view:f.view,time:f.time}))]);
      if(version!==revision)throw Error('草稿已更新，请重新读取');
      const next=structuredClone(draft),view=repaired.views[0]!;
      next.scene.sceneConfig={...next.scene.sceneConfig,camera:view.camera,controls:view.controls};
      if(mode==='animation'&&next.plan.cameraFrames)next.plan.cameraFrames=next.plan.cameraFrames.map((frame,i)=>({...frame,view:repaired.views[i+1]!}));
      validateCameraTargets(next.scene,[next.scene.sceneConfig,...(mode==='animation'?next.plan.cameraFrames?.map(f=>f.view)??[]:[])]);
      if(JSON.stringify(next)!==JSON.stringify(draft)){validateDraft(next,false,mode);draft=next;edited=true;revision++;}
      return repaired.detachedBindings;
    },
    get edited() { return edited; },
    get revision() { return revision; },
    get selectedObjectIds() { return currentSelection.filter(id => draft.scene.objectList.some(object => object.threeJsonId === id || object.assembly?.id === id)); },
    get planChanged() { return mode === "animation" && JSON.stringify(draft.plan) !== originalPlan; },
    get sceneChanged() { return JSON.stringify(draft.scene) !== originalScene; },
    summary() {
      return {
        mode, revision, assets: stageAssemblies(draft.scene.objectList),
        selectedObjectIds: currentSelection.filter(id => draft.scene.objectList.some(o => o.threeJsonId === id || o.assembly?.id === id)),
        objects: draft.scene.objectList.map(({ threeJsonId, name, objType, bodyType }) => ({ threeJsonId, name, objType, ...(bodyType ? { bodyType } : {}) })),
        plan: { name: draft.plan.name, duration: draft.plan.duration, tracks: draft.plan.tracks?.map(({ objectId, joint, frames }) => ({ objectId, joint, frames: frames.length })), cameraFrames: draft.plan.cameraFrames?.length },
        history: history.map(({ id, name, duration, tracks, cameraFrames }) => ({ id, name, duration, tracks: tracks.length, cameraFrames: cameraFrames.length })),
        ...validateDraft(draft, false, mode),
      };
    },
    inspectable(): { scene: SceneDocument; plan?: DirectorPlan } {
      validateDraft(draft, false, mode);
      const plan = mode === 'animation' ? directorPlanSchema.safeParse(draft.plan) : undefined;
      return { scene: structuredClone(draft.scene), ...(plan?.success ? { plan: plan.data } : {}) };
    },
    read(): { scene: SceneDocument; plan?: DirectorPlan; selectedObjectIds: string[] } {
      validateDraft(draft, true, mode);
      return { scene: structuredClone(draft.scene), selectedObjectIds: currentSelection, ...(mode === 'animation' ? { plan: directorPlanSchema.parse(draft.plan) } : {}) };
    },
    /** 只读当前草稿内容，不做完整校验：画布 Agent 的编辑可能只改场景、把方案留到以后补齐。 */
    raw(): { scene: SceneDocument; plan: Partial<DirectorPlan> } {
      return structuredClone(draft) as { scene: SceneDocument; plan: Partial<DirectorPlan> };
    },
  };
}
