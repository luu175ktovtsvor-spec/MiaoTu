import { z, type NodeAiTool } from '@miaoimg/nodes-scaffold/runtime';
import { translate } from '@miaoimg/i18n/vue';
import { createDirectorDraft, type DirectorMode } from './agentTools';
import { detachDeletedCameraTargets, type CameraSnapshotRequest } from './cameraReconciliation';
import { directorPlanSchema } from './sceneAnimation';
import { sampledObjectPose } from './timeline';
import { createCameraDraft } from './cameraDraft';
import { createStageDraft, type StageState } from './stageDraft';
import type { CameraAnchor } from './motion';
import type { CameraView } from './scene';
import type { SceneDocument } from './scene';
import type { DirectorTraceEvent } from './directorTrace';
import type { DirectorPlan, DirectorPlanItem } from './sceneAnimation';

export class DirectorTaskError extends Error {}

/** Prepare a validated candidate; the node remains the only revision-checked save boundary. */
export async function prepareDirectorTask(options: {
  mode: DirectorMode;
  scene: SceneDocument;
  plan?: DirectorPlan;
  plans: DirectorPlanItem[];
  selectedObjectIds: string[];currentTime?:number;
  anchors?: CameraAnchor[]; selectedAnchorId?:string; editorView?:CameraView;
  /** Lighting, environment and aspect ratio at the start of the turn. */
  stage: StageState;
  signal: AbortSignal;
  onTool?(event: DirectorTraceEvent): void;
  runModel(tools: NodeAiTool[], document: ReturnType<ReturnType<typeof createDirectorDraft>['summary']> & {cameras:ReturnType<ReturnType<typeof createCameraDraft>['summary']>;stage:StageState}): Promise<{ text: string }>;
  resolveCameraSnapshots?(scene:SceneDocument,requests:CameraSnapshotRequest[],signal?:AbortSignal):Promise<CameraView[]>;
  resolveCamera?(scene:SceneDocument,view:CameraView,signal?:AbortSignal):Promise<CameraView>;
  inspect(scene: SceneDocument, plan: DirectorPlan | undefined, times: number[], signal: AbortSignal | undefined, stage: StageState): Promise<unknown>;
}) {
  const { mode, signal } = options;
  signal.throwIfAborted();
  const draft = createDirectorDraft(options.scene, options.plan, options.plans, { mode, selectedObjectIds: options.selectedObjectIds,time:options.currentTime });
  const stage=createStageDraft(options.stage,mode==='scene');
  // Camera focal lengths follow the draft aspect ratio, so read it on every use.
  const cameras=createCameraDraft(options.anchors??[],{view:options.editorView??{camera:options.scene.sceneConfig.camera,controls:options.scene.sceneConfig.controls},get aspect(){return stage.aspect;},selectedAnchorId:options.selectedAnchorId,editable:mode==='scene',getScene:()=>draft.raw().scene,resolveView:options.resolveCamera?(view,signal)=>options.resolveCamera!(draft.raw().scene,view,signal):undefined});
  let inspectedRevision = ''; const inspectedCameras=new Map<string,string>(),inspectedTimes=new Map<number,string>();const requiredPoseTimes=new Set<number>();
  const revision=()=>`${draft.revision}:${cameras.revision}:${stage.revision}`;
  // A camera check stays valid while that camera, the scene and the stage are unchanged; editing another camera does not invalidate it.
  const cameraKey=(id:string)=>`${draft.revision}:${stage.revision}:${JSON.stringify(cameras.raw().find(a=>a.id===id)??null)}`;
  // A pose check at a time stays valid while every character's sampled pose at that time is unchanged.
  const poseKey=(time:number)=>{const {scene,plan}=draft.raw(),parsed=directorPlanSchema.safeParse(plan);if(!parsed.success)return `${draft.revision}:${stage.revision}`;
    try{return `${stage.revision}:${JSON.stringify(scene.objectList.filter(o=>o.objType==='mannequin').map(o=>sampledObjectPose(scene,parsed.data,o.threeJsonId,time)))}`;}catch{return `${draft.revision}:${stage.revision}`;}};
  const pendingCameraChecks=()=>cameras.changedIds.filter(id=>inspectedCameras.get(id)!==cameraKey(id));
  const pendingPoseChecks=()=>{const frames=new Set(draft.raw().plan.tracks?.flatMap(track=>track.frames.map(frame=>frame.time))??[]);return [...requiredPoseTimes].filter(time=>frames.has(time)&&![...inspectedTimes].some(([seen,key])=>Math.abs(seen-time)<=.01&&key===poseKey(seen))).sort((a,b)=>a-b);};
  const inspectionSchema = mode === 'scene'
    ? z.strictObject({ timestamps: z.array(z.literal(0)).length(1) })
    : z.strictObject({ timestamps: z.array(z.number().min(0)).min(1).max(4) });
  const tools: NodeAiTool[] = [...draft.tools, ...cameras.tools, ...stage.tools, {
    name: 'inspectDocument',
    description: mode === 'scene'
      ? '查看本轮基础场景的真实渲染及精确世界坐标，用 timestamps:[0]。summary.samples 返回同一渲染时刻的物体位置、弧度旋转、缩放、颜色及相机数值。不需要动画方案；每次修改后必须重新回看，确认人数、站位、姿势和构图。'
      : '查看本轮动画草稿的真实渲染及精确世界坐标；summary.samples 给出各时点的物体位置、弧度旋转、缩放、颜色及相机数值，回答坐标必须用这些数值，不从图片估计。在方案时长内选择 1–4 个时间点。没有完整动画草稿时可用 [0] 查看基础场景；提交动画前必须补齐方案并重新回看。',
    parameters: z.toJSONSchema(inspectionSchema.extend({anchorId:z.string().min(1).optional()})),
    async execute(args, toolSignal) {
      signal.throwIfAborted(); toolSignal?.throwIfAborted();
      const { timestamps,anchorId } = inspectionSchema.extend({anchorId:z.string().min(1).optional()}).parse(args);
      const value = draft.inspectable(), currentRevision = revision();
      const id=anchorId??(mode==='scene'?cameras.selectedAnchorId:'');
      const anchor=id?cameras.raw().find(a=>a.id===id):undefined;
      if(id&&!anchor)throw Error('机位不存在，请先 readCameras');
      if(anchor)value.scene.sceneConfig={...value.scene.sceneConfig,camera:anchor.camera,controls:anchor.controls};
      if(anchor)value.plan=value.plan?{...value.plan,cameraFrames:[{time:0,view:{camera:anchor.camera,controls:anchor.controls},easing:'smooth'}]}:undefined;
      const result = await options.inspect(value.scene, value.plan, timestamps, toolSignal ?? signal, stage.raw());
      signal.throwIfAborted(); toolSignal?.throwIfAborted();
      // An edit may arrive while rendering. Its newer state must be inspected again.
      if (currentRevision === revision()) { inspectedRevision=currentRevision; for(const time of timestamps)inspectedTimes.set(time,poseKey(time)); if(id)inspectedCameras.set(id,cameraKey(id)); }
      return result;
    },
  }];
  let toolWork:Promise<unknown>=Promise.resolve();
  const observedTools: NodeAiTool[] = tools.map(tool => ({ ...tool,
    execute(args, toolSignal) {
      const work=toolWork.then(async()=>{
      const checkpoint=draft.checkpoint(),cameraCheckpoint=cameras.checkpoint(),stageCheckpoint=stage.checkpoint(),before=draft.raw();
      const id = crypto.randomUUID(), startedAt = Date.now();
      const eventArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
      options.onTool?.({ type: 'start', id, name: tool.name, args: eventArgs, startedAt, scene: draft.raw().scene, anchors: cameras.raw(), selectedAnchorId:cameras.selectedAnchorId });
      try {
        signal.throwIfAborted(); toolSignal?.throwIfAborted();
        let result = await tool.execute(args, toolSignal ?? signal);
        const after=draft.raw();
        if(before.scene.objectList.some(o=>!after.scene.objectList.some(a=>a.threeJsonId===o.threeJsonId))){
          const oldPlan=mode==='animation'?directorPlanSchema.safeParse(before.plan).data:undefined;
          const resolve=(requests:CameraSnapshotRequest[])=>{
            const items=requests.map(request=>({...request,plan:oldPlan}));
            if(options.resolveCameraSnapshots)return options.resolveCameraSnapshots(before.scene,items,toolSignal??signal);
            if(options.resolveCamera)return Promise.all(items.map(item=>options.resolveCamera!(before.scene,item.view,toolSignal??signal)));
            throw new DirectorTaskError(translate('无法保留机位取景，原场景已保留'));
          };
          const cameraRepair=await cameras.reconcileTargets(before.scene,resolve);
          const documentRepair=await draft.reconcileCameraViews(requests=>detachDeletedCameraTargets(before.scene,draft.raw().scene,requests,resolve));
          if(cameraRepair.detachedBindings+documentRepair>0)result={...(result&&typeof result==='object'?result:{}),detachedCameraBindings:cameraRepair.detachedBindings+documentRepair,detachedAnchorIds:cameraRepair.anchorIds,sharedSceneEffects:'已有方案会保留，但保存时会清理被删除物体的动作轨道和跟随/注视绑定；不能声称已有方案完全未变。'};
        }
        signal.throwIfAborted(); toolSignal?.throwIfAborted();
        if(tool.name==='applyActorPose'&&mode==='animation'&&result&&typeof result==='object'&&'time' in result&&'changed' in result&&result.changed&&typeof result.time==='number')requiredPoseTimes.add(result.time);
        // Tell the model which edited cameras still need an inspectDocument({anchorId}) before it finishes.
        if(['editCameras','editDocument','applyActorPose','inspectDocument','addStageAsset','updateStageAsset','editStage'].includes(tool.name)&&result&&typeof result==='object'&&!Array.isArray(result)){
          const cameraChecks=pendingCameraChecks(),poseChecks=pendingPoseChecks();
          if(cameraChecks.length)result={...(result as Record<string,unknown>),pendingCameraChecks:cameraChecks,pendingCameraChecksNote:'这些新增或修改的机位还需逐个用 inspectDocument 的 anchorId 回看'};
          if(poseChecks.length)result={...(result as Record<string,unknown>),pendingPoseChecks:poseChecks,pendingPoseChecksNote:'这些时间的姿势在最新草稿里还没回看，结束前用 inspectDocument 的 timestamps 逐一回看（每次最多 4 个）'};
        }
        options.onTool?.({ type: 'end', id, name: tool.name, args: eventArgs, startedAt, durationMs: Math.max(0, Date.now() - startedAt), scene: draft.raw().scene, anchors: cameras.raw(), selectedAnchorId:cameras.selectedAnchorId, result });
        return result;
      } catch (error) {
        draft.restore(checkpoint);cameras.restore(cameraCheckpoint);stage.restore(stageCheckpoint);
        options.onTool?.({ type: 'end', id, name: tool.name, args: eventArgs, startedAt, durationMs: Math.max(0, Date.now() - startedAt), scene: draft.raw().scene, anchors: cameras.raw(), selectedAnchorId:cameras.selectedAnchorId, error, interrupted: signal.aborted || toolSignal?.aborted });
        throw error;
      }
      });toolWork=work.catch(()=>{});return work;
    },
  }));
  const response = await options.runModel(observedTools, { ...draft.summary(), cameras:cameras.summary(), stage:stage.raw() });
  signal.throwIfAborted();
  if (!draft.edited && !cameras.changed && !stage.changed) return { scene: draft.raw().scene, stage: stage.raw(), stageChanged: false, mode, summary: response.text.trim(), readOnly: true, selectedObjectIds: draft.selectedObjectIds, inspected: inspectedRevision === revision(), sceneChanged: false, planChanged: false, anchorsChanged:false, anchors:cameras.raw(), selectedAnchorId:cameras.selectedAnchorId, changed: false, plan: undefined as DirectorPlan | undefined };
  if (inspectedRevision !== revision() || pendingCameraChecks().length) throw new DirectorTaskError(translate('最新修改尚未完成画面检查，原场景已保留，请重试'));
  if(pendingPoseChecks().length)throw new DirectorTaskError(translate('最新姿势尚未在对应时间回看，原方案已保留'));
  const value = draft.read();
  return { ...value, mode, readOnly: false, inspected: true, summary: response.text.trim(), sceneChanged: draft.sceneChanged, planChanged: draft.planChanged, anchors:cameras.raw(), selectedAnchorId:cameras.selectedAnchorId, anchorsChanged:cameras.changed, stage: stage.raw(), stageChanged: stage.changed, changed: draft.sceneChanged || draft.planChanged || cameras.changed || stage.changed };
}
