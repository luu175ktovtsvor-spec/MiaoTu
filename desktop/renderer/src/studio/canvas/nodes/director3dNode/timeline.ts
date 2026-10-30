import { z } from '@miaoimg/nodes-scaffold/runtime';
import { Euler, Quaternion, Vector3 } from 'three';
import { directorPlanSchema, type DirectorPlan } from './sceneAnimation';
import { cameraViewSchema, type SceneDocument, type CameraView } from './scene';
import { prepareMotion, sampleMotion } from './motion';
import { PerspectiveCamera } from 'three';
import { captureCamera } from './scene';
import { applyActorPosePreset } from './stageLibrary';
import {equivalentCameraViews} from './cameraRecording';
import { mannequinJoints } from './mannequin';
import { translate } from '@miaoimg/i18n/vue';
const vector=z.strictObject({x:z.number().min(-10000).max(10000),y:z.number().min(-10000).max(10000),z:z.number().min(-10000).max(10000)});
export const timelineTargetSchema=z.strictObject({kind:z.enum(['camera','object']),objectId:z.string().min(1).optional(),joint:z.enum(mannequinJoints).optional()});
export type TimelineTarget=z.infer<typeof timelineTargetSchema>;
export const timelineOperationSchema=z.discriminatedUnion('action',[
 z.strictObject({action:z.literal('duration'),duration:z.number().min(.2).max(300),rescale:z.boolean().default(true)}),
 z.strictObject({action:z.literal('recordCamera'),time:z.number().min(0).max(300),view:cameraViewSchema,easing:z.enum(['linear','smooth','cut']).optional()}),
 z.strictObject({action:z.literal('recordPose'),objectId:z.string().min(1),time:z.number().min(0).max(300),position:vector,rotation:vector,scale:vector,pose:z.partialRecord(z.enum(mannequinJoints),vector).optional(),posePresetHeight:z.number().min(-2).max(2).optional()}),
 z.strictObject({action:z.literal('rename'),name:z.string().trim().min(1).max(80)}),
 z.strictObject({action:z.literal('addTrack'),objectId:z.string().min(1),joint:z.enum(mannequinJoints).optional()}),
 z.strictObject({action:z.literal('removeTrack'),objectId:z.string().min(1),joint:z.enum(mannequinJoints).optional()}),
 z.strictObject({action:z.literal('insert'),target:timelineTargetSchema,time:z.number().min(0).max(300)}),
 z.strictObject({action:z.literal('move'),target:timelineTargetSchema,index:z.number().int().min(0).max(119),time:z.number().min(0).max(300)}),
 z.strictObject({action:z.literal('remove'),target:timelineTargetSchema,index:z.number().int().min(0).max(119)}),
 z.strictObject({action:z.literal('update'),target:timelineTargetSchema,index:z.number().int().min(0).max(119),rotation:vector.optional(),position:vector.optional(),scale:vector.optional(),view:cameraViewSchema.optional(),easing:z.enum(['linear','smooth','cut']).optional()}),
]);
export type TimelineOperation=z.infer<typeof timelineOperationSchema>;
export const timelineRequestSchema=z.strictObject({action:z.enum(['create','edit']),name:z.string().trim().min(1).max(80).optional(),duration:z.number().min(.2).max(300).optional(),planId:z.string().min(1).optional(),operations:z.array(timelineOperationSchema).min(1).max(100).optional()}).superRefine((value,ctx)=>{
 if(value.action==='edit'&&!value.operations)ctx.addIssue({code:'custom',path:['operations'],message:'edit 必须提供 operations'});
 if(value.action==='create'&&(value.planId||value.operations))ctx.addIssue({code:'custom',message:'create 不使用 planId 或 operations'});
 if(value.action==='edit'&&(value.name||value.duration))ctx.addIssue({code:'custom',message:'edit 请通过 operations 修改名称和时长'});
});
export type TimelineRequest=z.infer<typeof timelineRequestSchema>;
export function timelineKey(target:TimelineTarget){return target.kind==='camera'?'camera':JSON.stringify([target.objectId,target.joint??'']);}
function baseFrame(scene:SceneDocument,target:TimelineTarget){
 const object=scene.objectList.find(o=>o.threeJsonId===target.objectId);if(!object)throw Error(translate('请先选择一个真实物体'));
 if(target.joint&&object.objType!=='mannequin')throw Error(translate('只有人偶可以添加关节轨道'));
 if(target.joint)return {time:0,rotation:{...(object.pose?.[target.joint]??{x:0,y:0,z:0})}};
 return {time:0,posePresetHeight:undefined as number|undefined,position:{...object.position},rotation:{x:object.rotation?.rotationX??0,y:object.rotation?.rotationY??0,z:object.rotation?.rotationZ??0},scale:{x:object.scale?.scaleX??1,y:object.scale?.scaleY??1,z:object.scale?.scaleZ??1}};
}
function trackFor(plan:DirectorPlan,target:TimelineTarget){
 if(target.kind==='camera'){if(target.objectId||target.joint)throw Error(translate('镜头轨道不使用物体或关节 ID'));return {kind:'camera' as const,frames:plan.cameraFrames};}
 if(!target.objectId)throw Error(translate('请选择动作轨道'));
 const track=plan.tracks.find(t=>t.objectId===target.objectId&&t.joint===target.joint);if(!track)throw Error(translate('动作轨道已不存在，请重新选择'));return {kind:'object' as const,frames:track.frames,track};
}
function samplePresetHeight(scene:SceneDocument,plan:DirectorPlan,id:string,time:number){
 const base=scene.objectList.find(o=>o.threeJsonId===id)?.posePresetHeight??0;
 const root=plan.tracks.find(t=>t.objectId===id&&!t.joint),keys=(root?.frames??[]).filter(f=>f.posePresetHeight!==undefined).map(f=>({time:f.time,value:f.posePresetHeight!}));
 if(!keys.length)return base;if(keys[0]!.time>0)keys.unshift({time:0,value:base});
 const index=keys.findIndex(k=>k.time>=time),next=keys[index<0?keys.length-1:index]!,previous=keys[Math.max(0,(index<0?keys.length-1:index)-1)]!;
 const p=next===previous?1:Math.min(1,Math.max(0,(time-previous.time)/(next.time-previous.time)));return previous.value+(next.value-previous.value)*p;
}
export function sampleObjectFrame(scene:SceneDocument,plan:DirectorPlan,target:TimelineTarget,time:number){
 const selected=trackFor(plan,target);if(selected.kind!=='object')throw Error(translate('请选择动作轨道'));const frames=selected.frames,base=baseFrame(scene,target);
 const end=frames.findIndex(f=>f.time>=time),next=frames[end<0?frames.length-1:end]!,previous=frames[Math.max(0,(end<0?frames.length-1:end)-1)]!;
 const p=previous===next?1:Math.min(1,Math.max(0,(time-previous.time)/(next.time-previous.time)));
 const q=(r:{x:number;y:number;z:number})=>new Quaternion().setFromEuler(new Euler(r.x,r.y,r.z));const rotation=new Euler().setFromQuaternion(q(previous.rotation).slerp(q(next.rotation),p));
 const value:{time:number;rotation:{x:number;y:number;z:number};position?:{x:number;y:number;z:number};scale?:{x:number;y:number;z:number};posePresetHeight?:number}={time,rotation:{x:rotation.x,y:rotation.y,z:rotation.z}};
 if(!target.joint)for(const key of ['position','scale'] as const){const a=previous[key]??base[key]!,b=next[key]??base[key]!;const v=new Vector3(a.x,a.y,a.z).lerp(new Vector3(b.x,b.y,b.z),p);value[key]={x:v.x,y:v.y,z:v.z};}
 if(!target.joint)value.posePresetHeight=samplePresetHeight(scene,plan,target.objectId!,time);
 return value;
}
export function sampledObjectPose(scene:SceneDocument,plan:DirectorPlan,id:string,time:number){
 const object=scene.objectList.find(o=>o.threeJsonId===id);if(!object)throw Error(translate('请先选择一个真实物体'));
 const sample=(joint?:typeof mannequinJoints[number])=>{const target:TimelineTarget={kind:'object',objectId:id,joint};return plan.tracks.some(t=>t.objectId===id&&t.joint===joint)?sampleObjectFrame(scene,plan,target,time):baseFrame(scene,target);};
 const root=sample();return {...root,posePresetHeight:samplePresetHeight(scene,plan,id,time),pose:object.objType==='mannequin'?Object.fromEntries(mannequinJoints.map(joint=>[joint,sample(joint).rotation])) as NonNullable<typeof object.pose>:undefined};
}
function recordPose(scene:SceneDocument,plan:DirectorPlan,op:Extract<TimelineOperation,{action:'recordPose'}>){
 const object=scene.objectList.find(o=>o.threeJsonId===op.objectId);if(!object||object.objType!=='mannequin')throw Error(translate('请先选择一个角色录帧'));
 if(op.time>plan.duration)throw Error(translate('关键帧不能超过方案时长'));
 const sampled=sampledObjectPose(scene,plan,op.objectId,op.time),near=(a:{x:number;y:number;z:number},b:{x:number;y:number;z:number})=>['x','y','z'].every(k=>Math.abs(a[k as 'x']-b[k as 'x'])<1e-6);
 const rotationsEqual=(a:{x:number;y:number;z:number},b:{x:number;y:number;z:number})=>1-Math.abs(new Quaternion().setFromEuler(new Euler(a.x,a.y,a.z)).dot(new Quaternion().setFromEuler(new Euler(b.x,b.y,b.z))))<1e-10;
 const put=(joint:typeof mannequinJoints[number]|undefined,frame:DirectorPlan['tracks'][number]['frames'][number])=>{let track=plan.tracks.find(t=>t.objectId===op.objectId&&t.joint===joint);if(!track){const first=baseFrame(scene,{kind:'object',objectId:op.objectId,joint});track={objectId:op.objectId,...(joint?{joint}:{}),frames:op.time>0?[first,structuredClone(frame)]:[{...structuredClone(frame),time:0},{...structuredClone(frame),posePresetHeight:undefined,time:plan.duration}]};plan.tracks.push(track);}const index=track.frames.findIndex(f=>Math.abs(f.time-op.time)<1e-6);if(index>=0)track.frames[index]={...track.frames[index]!,...frame};else track.frames.push(frame);track.frames.sort((a,b)=>a.time-b.time);};
 const height=op.posePresetHeight??sampled.posePresetHeight??0,heightChanged=Math.abs(height-(sampled.posePresetHeight??0))>1e-6;
 const futureHeights=new Map((plan.tracks.find(t=>t.objectId===op.objectId&&!t.joint)?.frames??[]).filter(f=>f.time>op.time).map(f=>[f.time,samplePresetHeight(scene,plan,op.objectId,f.time)]));
 if(!near(sampled.position!,op.position)||!rotationsEqual(sampled.rotation,op.rotation)||!near(sampled.scale!,op.scale)||heightChanged)put(undefined,{time:op.time,position:op.position,rotation:op.rotation,scale:op.scale,...(heightChanged?{posePresetHeight:height}:{})});
 if(heightChanged){const root=plan.tracks.find(t=>t.objectId===op.objectId&&!t.joint);for(const frame of root?.frames??[])if(frame.time>op.time&&futureHeights.has(frame.time)){const position=frame.position??object.position;frame.position={...position,y:position.y+samplePresetHeight(scene,plan,op.objectId,frame.time)-futureHeights.get(frame.time)!};}}

 if(op.pose)for(const joint of mannequinJoints){if(!Object.hasOwn(op.pose,joint))continue;const desired=op.pose[joint]??{x:0,y:0,z:0},before=sampled.pose?.[joint]??{x:0,y:0,z:0};if(!rotationsEqual(before,desired))put(joint,{time:op.time,rotation:desired});}
}

/** A batch edits a private copy and validates the complete resulting plan once. */
export function editTimelinePlan(scene:SceneDocument,source:DirectorPlan,operations:TimelineOperation[]):DirectorPlan{
 const {name,duration,tracks,cameraFrames}=source;
 let plan=structuredClone({name,duration,tracks,cameraFrames});
 for(const raw of operations){const op=timelineOperationSchema.parse(raw);
  if(op.action==='recordCamera'){
   if(op.time>plan.duration)throw Error(translate('关键帧不能超过方案时长'));
   const index=plan.cameraFrames.findIndex(f=>Math.abs(f.time-op.time)<1e-6),old=index>=0?plan.cameraFrames[index]:undefined;
   if(old&&equivalentCameraViews(old.view,op.view)&&(!op.easing||op.easing===old.easing))continue;
   const frame={time:old?.time??op.time,view:structuredClone(op.view),easing:op.easing??old?.easing??plan.cameraFrames.findLast(f=>f.time<=op.time)?.easing??'smooth' as const};
   if(index>=0)plan.cameraFrames[index]=frame;else plan.cameraFrames.push(frame);plan.cameraFrames.sort((a,b)=>a.time-b.time);continue;
  }
  if(op.action==='recordPose'){recordPose(scene,plan,op);continue;}
  if(op.action==='rename'){plan.name=op.name;continue;}
  if(op.action==='duration'){const ratio=op.duration/plan.duration;if(op.rescale){for(const t of plan.tracks)for(const f of t.frames)f.time=Math.min(op.duration,Math.round(f.time*ratio*1e9)/1e9);for(const f of plan.cameraFrames)f.time=Math.min(op.duration,Math.round(f.time*ratio*1e9)/1e9);}plan.duration=op.duration;continue;}
  if(op.action==='addTrack'){const target={kind:'object' as const,objectId:op.objectId,joint:op.joint};if(plan.tracks.some(t=>t.objectId===op.objectId&&t.joint===op.joint))continue;const frame=baseFrame(scene,target);plan.tracks.push({objectId:op.objectId,...(op.joint?{joint:op.joint}:{}),frames:[frame,{...structuredClone(frame),time:plan.duration}]});continue;}
  if(op.action==='removeTrack'){baseFrame(scene,{kind:'object',objectId:op.objectId,joint:op.joint});plan.tracks=plan.tracks.filter(t=>t.objectId!==op.objectId||t.joint!==op.joint);continue;}
  const selected=trackFor(plan,op.target);
  if(op.action==='insert'){
   if(op.time>plan.duration)throw Error(translate('关键帧不能超过方案时长'));if(selected.frames.some(f=>Math.abs(f.time-op.time)<1e-6))continue;
   if(selected.kind==='object'){selected.frames.push(sampleObjectFrame(scene,plan,op.target,op.time));selected.frames.sort((a,b)=>a.time-b.time);}
   else{const camera=new PerspectiveCamera();sampleMotion(camera,prepareMotion(plan.cameraFrames),op.time);const view=captureCamera({camera} as Parameters<typeof captureCamera>[0]);const previous=plan.cameraFrames.findLast(f=>f.time<=op.time)!;const next=plan.cameraFrames.find(f=>f.time>=op.time)??previous;
    // Fixed shared bindings remain live. Different bindings are not guessed.
    const a=previous.view.camera.tracking,b=next.view.camera.tracking;
    if(a||b){const tracking:NonNullable<CameraView['camera']['tracking']>={};let progress=previous===next?1:(op.time-previous.time)/(next.time-previous.time);if(next.easing==='cut')progress=0;else if(next.easing==='smooth')progress=progress*progress*(3-2*progress);
      for(const key of ['follow','lookAt'] as const){const x=a?.[key],y=b?.[key];if(!x&&!y)continue;if(!x||!y||x.objectId!==y.objectId||x.point!==y.point)throw Error(translate('这段镜头的绑定目标不同，请先选择独立机位'));const offset=new Vector3(x.offset.x,x.offset.y,x.offset.z).lerp(new Vector3(y.offset.x,y.offset.y,y.offset.z),progress);tracking[key]={...x,offset:{x:offset.x,y:offset.y,z:offset.z}};}
      view.camera.tracking=tracking;const start=previous.view.camera.roll??0,end=next.view.camera.roll??0;view.camera.roll=start+Math.atan2(Math.sin(end-start),Math.cos(end-start))*progress;
    }
    selected.frames.push({time:op.time,view,easing:next.easing});selected.frames.sort((a,b)=>a.time-b.time);}
   continue;
  }
  const frame=selected.frames[op.index];if(!frame)throw Error(translate('关键帧已不存在，请重新选择'));
  if(op.action==='move'){if(op.index===0&&op.time!==0)throw Error(translate('首帧必须保持在 0 秒'));if(op.time>plan.duration||selected.frames.some((f,i)=>i!==op.index&&Math.abs(f.time-op.time)<1e-6))throw Error(translate('关键帧时间超出范围或与其他帧重复'));frame.time=op.time;selected.frames.sort((a,b)=>a.time-b.time);continue;}
  if(op.action==='remove'){if(op.index===0)throw Error(translate('首帧必须保持在 0 秒'));if(selected.frames.length<=(selected.kind==='camera'?1:2))throw Error(translate('请保留必要关键帧，或移除整条动作轨道'));selected.frames.splice(op.index,1);continue;}
  if(selected.kind==='camera'){if(op.rotation||op.position||op.scale)throw Error(translate('镜头关键帧请修改取景参数'));if(op.view)selected.frames[op.index]={...plan.cameraFrames[op.index]!,view:op.view};if(op.easing)plan.cameraFrames[op.index]!.easing=op.easing;}
  else{if(op.view||op.easing)throw Error(translate('角色轨道不使用镜头过渡参数'));if(op.target.joint&&(op.position||op.scale))throw Error(translate('关节关键帧只修改旋转'));Object.assign(frame,...(['rotation','position','scale'] as const).filter(k=>op[k]!==undefined).map(k=>({[k]:op[k]})));}
 }
 return directorPlanSchema.parse(plan);
}
export function createManualPlan(scene:SceneDocument,view:CameraView,name:string,duration=4):DirectorPlan{return directorPlanSchema.parse({name,duration,tracks:[],cameraFrames:[{time:0,view,easing:'smooth'}]});}

/** The same sampled pose and height accounting used by manual stage recording. */
export function applyTimelinePosePreset(scene:SceneDocument,source:DirectorPlan,id:string,presetId:string,time:number){
 if(!Number.isFinite(time)||time<0||time>source.duration)throw Error(translate('姿势录帧时间必须位于当前方案时长内'));
 const object=scene.objectList.find(o=>o.threeJsonId===id);if(!object||object.objType!=='mannequin')throw Error(translate('请先选择一个角色录帧'));
 const sampled=sampledObjectPose(scene,source,id,time),posed=applyActorPosePreset({...object,position:sampled.position!,pose:sampled.pose,posePresetHeight:sampled.posePresetHeight},presetId);
 return editTimelinePlan(scene,source,[{action:'recordPose',objectId:id,time,position:posed.position,rotation:sampled.rotation,scale:sampled.scale!,pose:Object.fromEntries(mannequinJoints.map(joint=>[joint,posed.pose?.[joint]??{x:0,y:0,z:0}])),posePresetHeight:posed.posePresetHeight}]);
}
