import { Box3, PerspectiveCamera, Vector3 } from 'three';

export interface StageFrameArea { width:number; height:number; left:number; top:number; right:number; bottom:number }
function corners(bounds:Box3){
 return [bounds.min.x,bounds.max.x].flatMap(x=>[bounds.min.y,bounds.max.y].flatMap(y=>[bounds.min.z,bounds.max.z].map(z=>new Vector3(x,y,z))));
}
/** Fit every corner in the usable viewport, accounting for depth and off-centre UI. */
export function frameStageBounds(camera:Pick<PerspectiveCamera,'fov'|'aspect'|'near'>,bounds:Box3,direction:Vector3,area:StageFrameArea){
 const box=bounds.isEmpty()?new Box3(new Vector3(-1,0,-1),new Vector3(1,1.8,1)):bounds;
 const center=box.getCenter(new Vector3()),back=direction.clone();
 if(back.lengthSq()<1e-10)back.set(1,.5,1);back.normalize();
 // Keep lookAt's world-up basis well defined for a directly overhead view.
 if(Math.abs(back.y)>.999999){back.z+=.001;back.normalize();}
 const right=new Vector3().crossVectors(new Vector3(0,1,0),back).normalize(),up=new Vector3().crossVectors(back,right).normalize();
 const tanY=Math.tan(camera.fov*Math.PI/360),tanX=tanY*camera.aspect;
 const left=area.left/area.width*2-1,rightEdge=area.right/area.width*2-1,top=1-area.top/area.height*2,bottom=1-area.bottom/area.height*2;
 const cx=(left+rightEdge)/2,cy=(top+bottom)/2,halfX=(rightEdge-left)*.82/2,halfY=(top-bottom)*.82/2;
 if(halfX<=0||halfY<=0||tanX<=0||tanY<=0)throw Error('舞台可用取景区域无效');
 let distance=1.5;
 for(const point of corners(box)){
  point.sub(center);const x=point.dot(right),y=point.dot(up),z=point.dot(back);
  distance=Math.max(distance,z+camera.near*2,(x/tanX+(cx+halfX)*z)/halfX,(-x/tanX-(cx-halfX)*z)/halfX,(y/tanY+(cy+halfY)*z)/halfY,(-y/tanY-(cy-halfY)*z)/halfY);
 }
 const target=center.clone().addScaledVector(right,-cx*distance*tanX).addScaledVector(up,-cy*distance*tanY);
 return{position:target.clone().addScaledVector(back,distance),target,distance};
}
/** CSS viewport coordinates used by the preview controls and their status receipt. */
export function stageScreenBounds(camera:PerspectiveCamera,bounds:Box3,width:number,height:number){
 if(bounds.isEmpty())return null;camera.updateMatrixWorld(true);
 const points=corners(bounds).map(p=>p.project(camera));
 return{left:Math.min(...points.map(p=>(p.x+1)*width/2)),right:Math.max(...points.map(p=>(p.x+1)*width/2)),top:Math.min(...points.map(p=>(1-p.y)*height/2)),bottom:Math.max(...points.map(p=>(1-p.y)*height/2))};
}
