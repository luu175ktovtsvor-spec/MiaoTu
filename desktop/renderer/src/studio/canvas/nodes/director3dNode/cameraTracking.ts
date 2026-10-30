import { Box3, Vector3 } from 'three';
import { getObjectByThreeJsonId, type SceneRuntime } from 'threejson/core';
import type { CameraView, SceneDocument } from './scene';
import { translate } from '@miaoimg/i18n/vue';

export type CameraBinding = NonNullable<NonNullable<CameraView['camera']['tracking']>['follow']>;
export type CameraTargetResolver = (binding: CameraBinding) => { x:number;y:number;z:number };
export function createCameraTargetResolver(runtime:SceneRuntime):CameraTargetResolver {
  return binding=>{
    const target=getObjectByThreeJsonId(binding.objectId,runtime.scene);
    if(!target)throw new Error(translate('机位目标不存在，请先取消绑定'));
    target.updateWorldMatrix(true,true);
    const point=binding.point==='center'?new Box3().setFromObject(target).getCenter(new Vector3()):target.getWorldPosition(new Vector3());
    return {x:point.x+binding.offset.x,y:point.y+binding.offset.y,z:point.z+binding.offset.z};
  };
}
export function resolveCameraView(view:CameraView,resolve?:CameraTargetResolver):CameraView {
  const tracking=view.camera.tracking;if(!tracking||!resolve)return view;
  return {...view,camera:{...view.camera,position:tracking.follow?resolve(tracking.follow):view.camera.position},controls:{target:tracking.lookAt?resolve(tracking.lookAt):view.controls.target}};
}
export function validateCameraTargets(scene:SceneDocument,views:CameraView[]) {
  const ids=new Set(scene.objectList.map(o=>o.threeJsonId));
  for(const view of views)for(const binding of [view.camera.tracking?.follow,view.camera.tracking?.lookAt]){
    if(binding&&!ids.has(binding.objectId))throw new Error(translate('机位目标不存在，请先取消绑定'));
  }
}
