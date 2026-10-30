import { PerspectiveCamera, Vector3 } from 'three';
import { prepareMotion, sampleMotion } from './motion';
import { captureCamera, type CameraView } from './scene';
import { resolveCameraView, type CameraTargetResolver } from './cameraTracking';
import type { DirectorPlan } from './sceneAnimation';
import { translate } from '@miaoimg/i18n/vue';
const prepared=new WeakMap<DirectorPlan,ReturnType<typeof prepareMotion>>();
export function equivalentCameraViews(a:CameraView,b:CameraView){
 const normalize=(v:CameraView)=>({...v,camera:{...v.camera,roll:v.camera.roll??0,tracking:{follow:v.camera.tracking?.follow,lookAt:v.camera.tracking?.lookAt}}});
 const equal=(a:unknown,b:unknown):boolean=>{if(typeof a==='number'&&typeof b==='number')return Math.abs(a-b)<1e-9;if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;const x=a as Record<string,unknown>,y=b as Record<string,unknown>,keys=[...new Set([...Object.keys(x),...Object.keys(y)])];return keys.every(k=>equal(x[k],y[k]));};
 return equal(normalize(a),normalize(b));
}
/** Sample the animation while retaining only shared, unambiguous camera bindings. */
export function sampledCameraView(plan:DirectorPlan,time:number,resolve?:CameraTargetResolver):CameraView{
 if(!Number.isFinite(time)||time<0||time>plan.duration)throw Error(translate('请选择当前动画时长内的录帧时间'));
 const frames=plan.cameraFrames,exact=frames.find(f=>Math.abs(f.time-time)<1e-6);
 if(exact)return structuredClone(exact.view);if(time<=frames[0]!.time)return structuredClone(frames[0]!.view);if(time>=frames.at(-1)!.time)return structuredClone(frames.at(-1)!.view);
 const index=frames.findIndex(f=>f.time>time),a=frames[index-1]!,b=frames[index]!,tracking:NonNullable<CameraView['camera']['tracking']>={};
 if(b.easing==='cut')return structuredClone(a.view);
 let progress=(time-a.time)/(b.time-a.time);if(b.easing==='smooth')progress=progress*progress*(3-2*progress);
 for(const kind of ['follow','lookAt'] as const){const x=a.view.camera.tracking?.[kind],y=b.view.camera.tracking?.[kind];if(!x&&!y)continue;if(!x||!y||x.objectId!==y.objectId||x.point!==y.point)throw Error(translate('这段镜头的绑定目标不同，请先选择已有镜头关键帧再录入'));const v=new Vector3(x.offset.x,x.offset.y,x.offset.z).lerp(new Vector3(y.offset.x,y.offset.y,y.offset.z),progress);tracking[kind]={...x,offset:{x:v.x,y:v.y,z:v.z}};}
 let motion=prepared.get(plan);if(!motion){motion=prepareMotion(frames);prepared.set(plan,motion);}const camera=new PerspectiveCamera();camera.userData.directorResolveTarget=resolve;sampleMotion(camera,motion,time);const view=captureCamera({camera} as Parameters<typeof captureCamera>[0]);
 const va=resolveCameraView(a.view,resolve),vb=resolveCameraView(b.view,resolve),distance=(v:CameraView)=>new Vector3(v.camera.position.x,v.camera.position.y,v.camera.position.z).distanceTo(new Vector3(v.controls.target.x,v.controls.target.y,v.controls.target.z));const length=distance(va)+(distance(vb)-distance(va))*progress,target=camera.getWorldDirection(new Vector3()).multiplyScalar(Math.max(.01,length)).add(camera.position);view.controls.target={x:target.x,y:target.y,z:target.z};if(Object.keys(tracking).length)view.camera.tracking=tracking;
 return view;
}

/** Preserve a camera's live targets when adopting a newly navigated world-space view. */
export function cameraViewIntoBindings(world:CameraView,template:CameraView,resolve?:CameraTargetResolver):CameraView{
 const result=structuredClone(world),base=resolveCameraView(template,resolve),distance=new Vector3(base.camera.position.x,base.camera.position.y,base.camera.position.z).distanceTo(new Vector3(base.controls.target.x,base.controls.target.y,base.controls.target.z));
 const position=new Vector3(result.camera.position.x,result.camera.position.y,result.camera.position.z),target=new Vector3(result.controls.target.x,result.controls.target.y,result.controls.target.z).sub(position).normalize().multiplyScalar(Math.max(.01,distance)).add(position);result.controls.target={x:target.x,y:target.y,z:target.z};
 if(template.camera.tracking){if(!resolve)throw Error(translate('机位目标不存在，请先取消绑定'));const tracking=structuredClone(template.camera.tracking);for(const kind of ['follow','lookAt'] as const){const binding=tracking[kind];if(!binding)continue;const point=resolve({...binding,offset:{x:0,y:0,z:0}}),desired=kind==='follow'?result.camera.position:result.controls.target;binding.offset={x:desired.x-point.x,y:desired.y-point.y,z:desired.z-point.z};}result.camera.tracking=tracking;}
 return result;
}
