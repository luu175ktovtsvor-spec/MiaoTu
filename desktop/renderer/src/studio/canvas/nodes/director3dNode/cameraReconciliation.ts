import { translate } from '@miaoimg/i18n/vue';
import type { CameraView, SceneDocument } from './scene';
import type { DirectorPlan } from './sceneAnimation';
export type CameraSnapshotRequest={view:CameraView;time:number;plan?:DirectorPlan};
/** Only detach references to objects actually removed by this edit. Unknown IDs remain errors. */
export async function detachDeletedCameraTargets(before:SceneDocument,after:SceneDocument,requests:CameraSnapshotRequest[],resolve:(requests:CameraSnapshotRequest[])=>Promise<CameraView[]>) {
  const oldIds=new Set(before.objectList.map(o=>o.threeJsonId)),ids=new Set(after.objectList.map(o=>o.threeJsonId));
  const pending: {index:number;kinds:('follow'|'lookAt')[];request:CameraSnapshotRequest}[]=[];
  requests.forEach((request,index)=>{
    const tracking=request.view.camera.tracking;
    const kinds=(['follow','lookAt'] as const).filter(kind=>tracking?.[kind]&&oldIds.has(tracking[kind]!.objectId)&&!ids.has(tracking[kind]!.objectId));
    if(!kinds.length)return;
    // A second binding may target an object created in this same edit. It has no
    // previous pose and is irrelevant to freezing the removed binding.
    const resolvable=Object.fromEntries(Object.entries(tracking??{}).filter(([,binding])=>binding&&oldIds.has(binding.objectId)));
    pending.push({index,kinds,request:{...request,view:{...request.view,camera:{...request.view.camera,tracking:resolvable}}}});
  });
  const views=requests.map(r=>r.view);if(!pending.length)return{views,detachedBindings:0,changedIndices:[] as number[]};
  const resolved=await resolve(pending.map(p=>p.request));if(resolved.length!==pending.length)throw new Error(translate('机位快照结果不完整，原场景已保留'));
  pending.forEach((item,index)=>{
    const original=requests[item.index]!.view,pose=resolved[index]!,tracking={...original.camera.tracking};
    for(const kind of item.kinds)delete tracking[kind];
    views[item.index]={...original,camera:{...original.camera,position:item.kinds.includes('follow')?{...pose.camera.position}:original.camera.position,tracking:Object.keys(tracking).length?tracking:undefined},controls:item.kinds.includes('lookAt')?{target:{...pose.controls.target}}:original.controls};
  });
  return{views,detachedBindings:pending.reduce((n,p)=>n+p.kinds.length,0),changedIndices:pending.map(p=>p.index)};
}

/** Destructive edits report the committed effects, including shared-scene cleanup. */
export function sceneDeletionReceipt(before:SceneDocument,after:SceneDocument,beforeAnchors:CameraView[],plans:(DirectorPlan&{id:string})[],cameraCount:number){
  const ids=new Set(after.objectList.map(o=>o.threeJsonId)),old=new Map(before.objectList.map(o=>[o.threeJsonId,o]));
  const removed=before.objectList.filter(o=>!ids.has(o.threeJsonId));if(!removed.length)return;
  const removedIds=new Set(removed.map(o=>o.threeJsonId));
  const nameList=(items:SceneDocument['objectList'])=>[...new Set(items.map(o=>o.name||translate('物体')))].slice(0,6).join(' / ');
  const changed=after.objectList.filter(o=>old.has(o.threeJsonId)&&JSON.stringify(old.get(o.threeJsonId))!==JSON.stringify(o));
  const added=after.objectList.filter(o=>!old.has(o.threeJsonId));
  const tracks=plans.flatMap(p=>p.tracks).filter(t=>removedIds.has(t.objectId)).length;
  const bindings=[before.sceneConfig,...beforeAnchors,...plans.flatMap(p=>p.cameraFrames.map(f=>f.view))].reduce((count,v)=>count+(['follow','lookAt'] as const).filter(k=>v.camera.tracking?.[k]&&removedIds.has(v.camera.tracking[k]!.objectId)).length,0);
  const lines=[translate('已删除：{0}',{0:nameList(removed)})];
  if(added.length)lines.push(translate('已添加：{0}',{0:nameList(added)}));
  if(changed.length)lines.push(translate('已更新：{0}',{0:nameList(changed)}));
  lines.push(translate('保留 {0} 个机位和 {1} 个已有方案',{0:cameraCount,1:plans.length}));
  if(tracks)lines.push(translate('已清理 {0} 条相关动作轨道',{0:tracks}));
  if(bindings)lines.push(translate('已解除 {0} 个失效机位绑定',{0:bindings}),translate('相关机位已按原记录时间保留取景'));
  return lines.join('\n');
}
