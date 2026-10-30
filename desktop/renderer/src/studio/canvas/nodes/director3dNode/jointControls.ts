import { translate } from '@miaoimg/i18n/vue';
import type { mannequinJoints } from './mannequin';
export type MannequinJoint=typeof mannequinJoints[number];
export type JointAngleControl={axis:'x'|'y'|'z';label:string;sign:1|-1};
/** Positive human-facing angles: raise arms/legs forwards and abduct both sides outwards. */
export function jointAngleControls(joint:MannequinJoint):JointAngleControl[]{
 const row=(labels:[string,string,string],signs:[1|-1,1|-1,1|-1]=[1,1,1])=>(['x','y','z'] as const).map((axis,i)=>({axis,label:labels[i]!,sign:signs[i]!}));
 if(joint==='head'||joint==='neck')return row([translate('点头'),translate('转头'),translate('歪头')]);
 if(joint==='spine'||joint==='hips')return row([translate('前倾'),translate('转体'),translate('侧倾')]);
 if(joint.endsWith('Shoulder'))return row([translate('前举'),translate('扭转'),translate('外展')],[-1,1,joint.startsWith('left')?1:-1]);
 if(joint.endsWith('Elbow'))return row([translate('屈肘'),translate('扭转'),translate('侧摆')],[-1,1,1]);
 if(joint.endsWith('Wrist'))return row([translate('屈腕'),translate('扭转'),translate('侧摆')],[-1,1,1]);
 if(joint.endsWith('Hip'))return row([translate('前抬'),translate('扭转'),translate('外展')],[-1,1,joint.startsWith('left')?1:-1]);
 if(joint.endsWith('Knee'))return row([translate('屈膝'),translate('扭转'),translate('侧摆')]);
 return row([translate('勾脚'),translate('转向'),translate('侧倾')],[-1,1,1]);
}
export function jointAngleDegrees(control:JointAngleControl,radians=0){return Math.round(radians*control.sign*180/Math.PI*100)/100;}
export function jointAngleRadians(control:JointAngleControl,degrees:number){return degrees*control.sign*Math.PI/180;}
