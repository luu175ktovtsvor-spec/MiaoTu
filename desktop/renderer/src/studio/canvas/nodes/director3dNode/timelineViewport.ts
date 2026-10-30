export const timelineMinZoom=1,timelineMaxZoom=8;
export function clampTimelineZoom(value:number){return Math.max(timelineMinZoom,Math.min(timelineMaxZoom,Math.round((Number.isFinite(value)?value:1)*4)/4));}
export function timelineViewportMetrics(width:number,zoom:number){
 const viewportWidth=Math.max(1,width),labelWidth=Math.min(120,Math.max(76,Math.round(viewportWidth*.25))),visibleLaneWidth=Math.max(1,viewportWidth-labelWidth-20),laneWidth=Math.max(80,visibleLaneWidth)*clampTimelineZoom(zoom);
 return{viewportWidth,labelWidth,visibleLaneWidth,laneWidth,surfaceWidth:labelWidth+20+laneWidth,maxScroll:Math.max(0,laneWidth-visibleLaneWidth)};
}
export function timelinePointerTime(clientX:number,laneLeft:number,laneWidth:number,duration:number){return Math.round(Math.max(0,Math.min(1,(clientX-laneLeft)/Math.max(1,laneWidth)))*duration*100)/100;}
export function timelineAnchorScroll(time:number,duration:number,laneWidth:number,visibleWidth:number,offset=visibleWidth/2){return Math.max(0,Math.min(Math.max(0,laneWidth-visibleWidth),time/Math.max(.01,duration)*laneWidth-offset));}
export function timelineRulerTicks(duration:number,laneWidth:number){
 const desired=Math.max(.01,duration*64/Math.max(1,laneWidth)),power=10**Math.floor(Math.log10(desired)),unit=[1,2,5,10].find(v=>v*power>=desired)??10,step=Math.max(.01,unit*power),ticks:number[]=[];
 for(let i=0;i*step<duration&&i<255;i++)ticks.push(Math.round(i*step*1e8)/1e8);
 if(ticks.length>1&&(duration-ticks.at(-1)!)/duration*laneWidth<42)ticks.pop();
 ticks.push(duration);return ticks;
}
