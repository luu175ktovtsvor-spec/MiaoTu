import type { NodeMediaModel } from "../../scaffold/nodeAi";
import { fitsCustomSize } from "../../scaffold/nodeAi";

const pixels = (size: string) => /^(\d+)x(\d+)$/.exec(size)?.slice(1).map(Number);
const ratioValue = (ratio: string | undefined) => { const [w,h]=String(ratio || '').split(':').map(Number); return w>0&&h>0?w/h:undefined; };
const gcd = (a: number,b: number): number => b?gcd(b,a%b):a;

export function imageRedrawOutput(model: NodeMediaModel, width?: number, height?: number) {
  const sizes=model.imageSizes || [], ratios=model.imageRatios || [];
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || !(width!>0&&height!>0))
    return {size:sizes.includes('auto')?'auto':'',ratio:ratios.includes('auto')?'auto':''};
  const sourceRatio=width!/height!, rule=model.customSize?model.sizeRule:undefined;
  if (rule && Number.isFinite(rule.maxPixels) && rule.maxPixels>0 && sourceRatio>=rule.minRatio && sourceRatio<=rule.maxRatio) {
    const divisor=gcd(width!,height!),a=width!/divisor,b=height!/divisor;
    const step=Number.isSafeInteger(rule.multipleOf)&&rule.multipleOf!>0?rule.multipleOf!:1;
    const unitA=step/gcd(a,step),unitB=step/gcd(b,step),unit=unitA*unitB/gcd(unitA,unitB);
    const maximum=Math.min(Math.sqrt(rule.maxPixels/(a*b)),rule.maxEdge?rule.maxEdge/a:Infinity,rule.maxEdge?rule.maxEdge/b:Infinity);
    const scale=Math.floor(maximum/unit)*unit;
    const size=`${a*scale}x${b*scale}`;
    if (scale>0 && fitsCustomSize(rule,size)) {
      const exact=`${a}:${b}`;
      return {size,ratio:ratios.includes(exact)?exact:ratios.includes('auto')?'auto':''};
    }
  }
  const candidates=sizes.flatMap(size=>{
    const dimensions=pixels(size),metadata=model.sizes?.find(item=>item.value===size);
    const aspect=dimensions?dimensions[0]!/dimensions[1]!:ratioValue(metadata?.ratio);
    if (aspect) return [{size,aspect,area:dimensions?dimensions[0]!*dimensions[1]!:Number.parseFloat(size)**2*1_000_000,ratio:metadata?.ratio || ''}];
    return ratios.flatMap(ratio=>{const aspect=ratioValue(ratio);return aspect?[{size,aspect,area:Number.parseFloat(size)**2*1_000_000||0,ratio}]:[];});
  });
  candidates.sort((a,b)=>Math.abs(Math.log(a.aspect/sourceRatio))-Math.abs(Math.log(b.aspect/sourceRatio)) || b.area-a.area);
  const chosen=candidates[0];
  if (!chosen) return {size:sizes.includes('auto')?'auto':'',ratio:ratios.includes('auto')?'auto':''};
  const dimensions=pixels(chosen.size),exact=dimensions?`${dimensions[0]!/gcd(dimensions[0]!,dimensions[1]!)}:${dimensions[1]!/gcd(dimensions[0]!,dimensions[1]!)}`:chosen.ratio;
  return {size:chosen.size,ratio:ratios.includes(exact)?exact:ratios.includes('auto')?'auto':''};
}
