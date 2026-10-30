import { z } from '@miaoimg/nodes-scaffold/runtime';
import type { DirectorPlanItem } from './sceneAnimation';
import { translate } from '@miaoimg/i18n/vue';
export const planManagementSchema=z.strictObject({action:z.enum(['copy','rename','remove']),planId:z.string().min(1),name:z.string().trim().min(1).max(80).optional()}).superRefine((v,ctx)=>{if(v.action==='rename'&&!v.name)ctx.addIssue({code:'custom',path:['name'],message:'rename 必须提供 name'});if(v.action==='remove'&&v.name)ctx.addIssue({code:'custom',message:'remove 不使用 name'});});
export type PlanManagementRequest=z.infer<typeof planManagementSchema>;
export function uniquePlanName(plans:Pick<DirectorPlanItem,'name'>[],requested:string){
 const name=requested.trim().slice(0,80)||translate('动画方案'),used=new Set(plans.map(p=>p.name));if(!used.has(name))return name;
 for(let n=2;;n++){const suffix=` · ${n}`,candidate=name.slice(0,80-suffix.length)+suffix;if(!used.has(candidate))return candidate;}
}
/** Old duplicate names remain untouched on disk, while every displayed label is distinct. */
export function planDisplayNames(plans:Pick<DirectorPlanItem,'id'|'name'>[]){
 const counts=new Map<string,number>(),seen=new Map<string,number>(),reserved=new Set(plans.map(p=>p.name)),used=new Set<string>(),labels=new Map<string,string>();
 for(const p of plans)counts.set(p.name,(counts.get(p.name)??0)+1);
 for(const p of plans){let label=p.name;if(counts.get(p.name)!>1){let n=(seen.get(p.name)??0)+1;label=`${p.name} · ${n}`;while(reserved.has(label)||used.has(label)){n++;label=`${p.name} · ${n}`;}seen.set(p.name,n);}used.add(label);labels.set(p.id,label);}
 return labels;
}
export function manageSavedPlans(plans:DirectorPlanItem[],selectedPlanId:string,raw:PlanManagementRequest,newId=()=>crypto.randomUUID()){
 const request=planManagementSchema.parse(raw),source=plans.find(p=>p.id===request.planId);if(!source)throw Error(translate('方案已不存在，请重新选择'));
 if(request.action==='remove')return{plans:plans.filter(p=>p.id!==source.id),selectedPlanId:selectedPlanId===source.id?'':selectedPlanId,changed:true,plan:undefined};
 if(request.action==='copy'){
  const suffix=` · ${translate('副本')}`;
  const copy:DirectorPlanItem={...structuredClone(source),id:newId(),name:uniquePlanName(plans,request.name??`${source.name.slice(0,80-suffix.length)}${suffix}`),source:'manual'};
  if(plans.some(p=>p.id===copy.id))throw Error(translate('方案 ID 不能重复'));
  return{plans:[...plans,copy],selectedPlanId:copy.id,changed:true,plan:copy};
 }
 const name=uniquePlanName(plans.filter(p=>p.id!==source.id),request.name!),renamed={...source,name};
 return{plans:name===source.name?plans:plans.map(p=>p.id===source.id?renamed:p),selectedPlanId,changed:name!==source.name,plan:renamed};
}
