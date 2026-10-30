import { Box3, Euler, Quaternion, Vector3, type Camera } from 'three';
import { getObjectByThreeJsonId, type SceneRuntime } from 'threejson/core';
import type { SceneDocument } from './scene';

/** Share (0–1) of an object's screen-space bounding box that lies inside the frame; 0 when out of shot or behind the camera. */
function frameCoverage(camera:Camera,box:Box3){
  if(box.isEmpty())return 0;
  const corners=[box.min.x,box.max.x].flatMap(x=>[box.min.y,box.max.y].flatMap(y=>[box.min.z,box.max.z].map(z=>new Vector3(x,y,z))));
  const front=corners.filter(point=>point.clone().applyMatrix4(camera.matrixWorldInverse).z<0);
  if(!front.length)return 0;
  const ndc=front.map(point=>point.project(camera)),xs=ndc.map(p=>p.x),ys=ndc.map(p=>p.y);
  const [x0,x1,y0,y1]=[Math.min(...xs),Math.max(...xs),Math.min(...ys),Math.max(...ys)],area=(x1-x0)*(y1-y0);
  if(area<=1e-9)return x0>=-1&&x1<=1&&y0>=-1&&y1<=1?1:0;
  const inside=Math.max(0,Math.min(1,x1)-Math.max(-1,x0))*Math.max(0,Math.min(1,y1)-Math.max(-1,y0));
  return Math.round(inside/area*100)/100;
}
/** Read the same world transforms used by rendering, after animation sampling. */
export function snapshotStage(runtime:SceneRuntime,document:SceneDocument,time:number){
  runtime.scene.updateMatrixWorld(true);runtime.camera.updateMatrixWorld(true);
  const vector=(v:{x:number;y:number;z:number})=>({x:v.x,y:v.y,z:v.z});
  const objects=document.objectList.map(definition=>{
    const object=getObjectByThreeJsonId(definition.threeJsonId,runtime.scene);
    const identity={objectId:definition.threeJsonId,name:definition.name??'',type:definition.objType};
    if(!object)return{...identity,available:false as const};
    return{...identity,available:true as const,position:vector(object.getWorldPosition(new Vector3())),rotation:vector(new Euler().setFromQuaternion(object.getWorldQuaternion(new Quaternion()))),scale:vector(object.getWorldScale(new Vector3())),color:definition.material.color,visible:object.visible,inFrame:frameCoverage(runtime.camera,new Box3().setFromObject(object))};
  });
  return{time,space:'world' as const,units:{position:'m',rotation:'rad'},objects,camera:{position:vector(runtime.camera.getWorldPosition(new Vector3())),forward:vector(runtime.camera.getWorldDirection(new Vector3())),fov:runtime.camera.fov}};
}
