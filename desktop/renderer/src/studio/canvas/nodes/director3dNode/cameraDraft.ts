import { z, type NodeAiTool } from '@miaoimg/nodes-scaffold/runtime';
import { translate } from '@miaoimg/i18n/vue';
import { anchorSchema, type CameraAnchor } from './motion';
import { cameraViewSchema, type CameraView, type SceneDocument } from './scene';
import { detachDeletedCameraTargets, type CameraSnapshotRequest } from './cameraReconciliation';
import { validateCameraTargets } from './cameraTracking';
import { cameraFocalLength, cameraFov } from './cameraRig';
import { documentShotSubject, shotPresets, shotPresetView } from './cameraPresets';

export const cameraAnchorsSchema = z.array(anchorSchema).max(100).superRefine((anchors, ctx) => {
  if (new Set(anchors.map(a => a.id)).size !== anchors.length) ctx.addIssue({code:'custom',message:'机位 ID 不能重复'});
});
const vector = z.strictObject({x:z.number().min(-10000).max(10000),y:z.number().min(-10000).max(10000),z:z.number().min(-10000).max(10000)});
export const cameraEditSchema = z.strictObject({
  operations:z.array(z.strictObject({
    action:z.enum(['add','update','copy','remove','reorder']), anchorId:z.string().min(1).max(100).optional(),
    shotPresetId:z.enum(shotPresets.map(p=>p.id) as [string,...string[]]).optional(),subjectObjectId:z.string().min(1).max(100).optional(),shotTargetObjectId:z.string().min(1).max(100).optional(),
    name:z.string().trim().min(1).max(100).optional(), position:vector.optional(), target:vector.optional(),
    fov:z.number().min(10).max(120).optional(), focalLengthMm:z.number().positive().optional(),
    rollDegrees:z.number().min(-180).max(180).optional(),time:z.number().min(0).max(300).optional(),
    followObjectId:z.string().min(1).max(100).nullable().optional(),lookAtObjectId:z.string().min(1).max(100).nullable().optional(),followOffset:vector.optional(),lookAtOffset:vector.optional(),
    view:cameraViewSchema.optional(),anchorIds:z.array(z.string().min(1)).max(100).optional(),
  })).min(1).max(100),
});
/** Private camera candidates share the same validation and pose representation as the editor. */
export function createCameraDraft(anchors:CameraAnchor[], options:{view:CameraView;aspect:number;selectedAnchorId?:string;editable:boolean;getScene?:()=>SceneDocument;resolveView?:(view:CameraView,signal?:AbortSignal)=>Promise<CameraView>}) {
  let current=cameraAnchorsSchema.parse(structuredClone(anchors)), selected=options.selectedAnchorId??'', revision=0;
  const original=JSON.stringify(current), source=new Map(current.map(a=>[a.id,JSON.stringify(a)]));
  const tools:NodeAiTool[]=[{
    name:'readCameras',description:'读取真实机位（稳定 anchorId、名称、camera/controls、取景时间和焦距 mm），selectedAnchorId 是当前选中机位。编辑前先读；units: 位置米，roll 弧度，FOV 角度。',
    parameters:z.toJSONSchema(z.strictObject({})),execute(_args,signal){signal?.throwIfAborted();return summary();},
  }];
  if(options.editable)tools.push({
    name:'editCameras',description:'编辑本轮私有机位草稿，不立即应用。add 新建（shotPresetId 按景别对主体人偶 subjectObjectId 自动取景：' + shotPresets.map(p=>`${p.id}=${p.name}`).join('，') + '；省略主体用第一个人偶；过肩镜头用 shotTargetObjectId 指定看向的另一人偶，省略看向最近的人偶。景别预设已算好取景，不要再手动改 position/target），copy 复制，update 修改，remove 删除，reorder 排序；anchorId 省略仅使用当前选中机位。followObjectId / lookAtObjectId 绑定真实物体（取自 scene.objectList 的 threeJsonId，不能使用整体道具 assetId），null 取消并保留当前取景；followOffset / lookAtOffset 为世界坐标偏移米。跟随保持初始位置偏移，注视始终瞄准物体中心。绑定字段优先于手动 position/target。position/target 为绝对世界坐标米，focalLengthMm 为毫米，rollDegrees 为角度。add 不传 view 使用本轮当前编辑器取景；copy 默认平移 X +0.5 米并保持朝向。操作批次整体校验，修改后必须 inspectDocument({timestamps:[0],anchorId}) 回看每个修改的机位。不要通过移动人物冒充修改机位。',
    parameters:z.toJSONSchema(cameraEditSchema),async execute(args,signal){
      signal?.throwIfAborted();const baseRevision=revision;const originalScene=options.getScene?JSON.stringify(options.getScene()):undefined;const {operations}=cameraEditSchema.parse(args);let next=structuredClone(current),nextSelected=selected;
      for(const op of operations){
        if(op.action==='reorder'){
          if(!op.anchorIds||op.anchorIds.length!==next.length||new Set(op.anchorIds).size!==next.length||op.anchorIds.some(id=>!next.some(a=>a.id===id)))throw Error('anchorIds 必须包含全部现有机位且不重复');
          next=op.anchorIds.map(id=>next.find(a=>a.id===id)!);continue;
        }
        const id=op.anchorId??nextSelected,existing=next.find(a=>a.id===id);
        if(op.action!=='add'&&!existing)throw Error('请先读取机位并指定真实 anchorId');
        if(op.action==='remove'){next=next.filter(a=>a.id!==id);if(nextSelected===id)nextSelected='';continue;}
        if(op.fov!==undefined&&op.focalLengthMm!==undefined)throw Error('fov 与 focalLengthMm 只传一个');
        let value:CameraAnchor;
        if(op.action==='add'&&op.shotPresetId){const scene=options.getScene?.();if(!scene)throw Error('请先读取场景');value=anchorSchema.parse({...shotPresetView(op.shotPresetId,documentShotSubject(scene,op.subjectObjectId,op.shotTargetObjectId),options.aspect),id:crypto.randomUUID(),name:op.name??translate(shotPresets.find(p=>p.id===op.shotPresetId)!.name),time:0});}
        else if(op.action==='add')value=anchorSchema.parse({...options.view,id:crypto.randomUUID(),name:op.name??translate('机位 {0}',{0:next.length+1}),time:0});
        else if(op.action==='copy')value=anchorSchema.parse({...existing,id:crypto.randomUUID(),name:(op.name??`${existing!.name??translate('机位')} · ${translate('副本')}`).slice(0,100),camera:{...existing!.camera,position:{...existing!.camera.position,x:existing!.camera.position.x+.5}},controls:{target:{...existing!.controls.target,x:existing!.controls.target.x+.5}}});
        else value=existing!;
        const tracking=structuredClone(value.camera.tracking??{});
        if(value.camera.tracking&&options.resolveView&&(op.followObjectId!==undefined||op.lookAtObjectId!==undefined)){
          const resolved=await options.resolveView(value,signal);value={...value,camera:{...value.camera,position:resolved.camera.position,roll:resolved.camera.roll},controls:resolved.controls};
        }
        for(const kind of ['follow','lookAt'] as const){const id=kind==='follow'?op.followObjectId:op.lookAtObjectId;const offset=kind==='follow'?op.followOffset:op.lookAtOffset;
          if(id===null)delete tracking[kind];
          else if(id!==undefined){const object=options.getScene?.().objectList.find(o=>o.threeJsonId===id);if(!object)throw Error('请读取场景并使用真实物体 objectId 作为机位目标');tracking[kind]={objectId:id,point:kind==='follow'?'root':'center',offset:offset??(kind==='follow'?{x:value.camera.position.x-object.position.x,y:value.camera.position.y-object.position.y,z:value.camera.position.z-object.position.z}:{x:0,y:0,z:0})};}
          else if(offset){if(!tracking[kind])throw Error('请先选择机位绑定目标');tracking[kind]!.offset=offset;}
        }
        if(op.action==='copy')for(const kind of ['follow','lookAt'] as const)if(tracking[kind])tracking[kind]!.offset.x+=.5;
        value={...value,camera:{...value.camera,tracking:Object.keys(tracking).length?tracking:undefined}};
        const fov=op.focalLengthMm===undefined?op.fov:cameraFov(op.focalLengthMm,options.aspect);
        value=anchorSchema.parse({...value,...op.view,name:op.name??value.name,time:op.time??value.time,camera:{...(op.view?.camera??value.camera),...(op.position?{position:op.position}:{}),...(fov!==undefined?{fov}:{}),...(op.rollDegrees!==undefined?{roll:op.rollDegrees*Math.PI/180}:{})},controls:{target:op.target??op.view?.controls.target??value.controls.target}});
        if(op.action==='update')next=next.map(a=>a.id===id?value:a);else next.push(value);nextSelected=value.id;
      }
      next=cameraAnchorsSchema.parse(next);signal?.throwIfAborted();if(revision!==baseRevision||options.getScene&&JSON.stringify(options.getScene())!==originalScene)throw Error('草稿已更新，请重新读取后修改机位');if(options.getScene)validateCameraTargets(options.getScene(),next);if(JSON.stringify(next)!==JSON.stringify(current)){current=next;selected=nextSelected;revision++;}
      return {changed:JSON.stringify(current)!==original,...summary()};
    },
  });
  function summary(){return {selectedAnchorId:current.some(a=>a.id===selected)?selected:null,anchors:current.map((a,index)=>({...structuredClone(a),name:a.name??translate('机位 {0}',{0:index+1}),focalLengthMm:cameraFocalLength(a,options.aspect)}))};}
  return {tools,summary,
    checkpoint(){return {anchors:structuredClone(current),selected,revision};},
    restore(checkpoint:{anchors:CameraAnchor[];selected:string;revision:number}){current=structuredClone(checkpoint.anchors);selected=checkpoint.selected;revision=checkpoint.revision;},
    async reconcileTargets(before:SceneDocument,resolve:(requests:CameraSnapshotRequest[])=>Promise<CameraView[]>){
      const scene=options.getScene?.();if(!scene)return{detachedBindings:0,anchorIds:[] as string[]};
      const version=revision,repaired=await detachDeletedCameraTargets(before,scene,current.map(anchor=>({view:anchor,time:anchor.time??0})),resolve);
      if(version!==revision)throw Error('草稿已更新，请重新读取机位');
      if(repaired.detachedBindings){current=cameraAnchorsSchema.parse(current.map((anchor,i)=>({...anchor,...repaired.views[i]})));revision++;}
      validateCameraTargets(scene,current);
      return{detachedBindings:repaired.detachedBindings,anchorIds:repaired.changedIndices.map(i=>current[i]!.id)};
    },
    get revision(){return revision;},get changed(){return JSON.stringify(current)!==original;},get changedIds(){return current.filter(a=>source.get(a.id)!==JSON.stringify(a)).map(a=>a.id);},raw:()=>structuredClone(current),get selectedAnchorId(){return current.some(a=>a.id===selected)?selected:'';}};
}
