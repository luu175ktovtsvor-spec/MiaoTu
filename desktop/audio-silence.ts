import { spawn } from 'node:child_process'
import { execMedia, MediaJobs, waitForMedia } from '../server/media-jobs.ts'
import { silenceOptions, segmentsAroundSilence, type SilenceOptions, type SilenceRange } from '../server/audio-silence-segments.ts'
type File = {path:string;revision:string;diskPath?:string|null;mime:string}
const FORMATS='wav,mp3,mov,matroska,webm,ogg,flac,aac,aiff,au,caf,amr,ac3,eac3,dts,ape,wv,tta,w64,dsf,iff'
async function analyze(file:File, options:SilenceOptions, ffmpeg:string, ffprobe:string, signal:AbortSignal){
  const input=['-protocol_whitelist','file,pipe','-format_whitelist',FORMATS,'-i',file.diskPath!]
  const raw=await execMedia(ffprobe,['-v','error',...input,'-show_streams','-show_format','-of','json'],{signal,maxBuffer:256*1024})
  const media=JSON.parse(raw),tracks=(media.streams||[]).filter((stream:any)=>stream.codec_type==='audio'),audio=tracks.find((stream:any)=>stream.disposition?.default)||tracks[0]
  const [n,d]=String(audio?.time_base||'').split('/').map(Number),exact=Number(audio?.duration_ts)*n/d
  const duration=[exact,Number(audio?.duration),Number(media.format?.duration)].find(value=>Number.isFinite(value)&&value>0)
  if(!audio||!duration)throw new Error('无法读取有效的音频时长')
  const filter=`asetpts=PTS-STARTPTS,silencedetect=n=${options.thresholdDb}dB:d=${options.minSilence}:mono=0,astats=metadata=0:reset=0:measure_perchannel=none:measure_overall=Peak_level`
  const data=await new Promise<{silences:SilenceRange[];peakDb:number}>((resolve,reject)=>{
    const child=spawn(ffmpeg,['-hide_banner','-nostats','-v','info','-nostdin','-threads','1','-filter_threads','1',...input,'-map',`0:${audio.index}`,'-vn','-sn','-dn','-af',filter,'-f','null','-'],{windowsHide:true,stdio:['ignore','ignore','pipe']})
    const silences:SilenceRange[]=[];let text='',start:number|undefined,peakDb=NaN,failure:Error|undefined
    const abort=()=>child.kill('SIGKILL');signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()
    const line=(value:string)=>{
      const begin=/silence_start:\s*([-\d.e+]+)/.exec(value),end=/silence_end:\s*([-\d.e+]+)/.exec(value),peak=/Peak level dB:\s*(-?inf|[-\d.e+]+)/i.exec(value)
      if(begin)start=Number(begin[1]);
      if(end&&start!==undefined){silences.push({start,end:Number(end[1])});start=undefined;if(silences.length>1001){failure=new Error('检测到过多片段，请调整静音阈值或最短静音时长后重试');abort()}}
      if(peak)peakDb=/^-inf$/i.test(peak[1])?-Infinity:Number(peak[1])
    }
    child.stderr.setEncoding('utf8');child.stderr.on('data',(chunk:string)=>{text+=chunk;let end:number;while((end=text.indexOf('\n'))>=0){line(text.slice(0,end));text=text.slice(end+1)}if(text.length>8192){failure=new Error('静音分析回执异常');abort()}})
    child.on('error',error=>{failure=error});child.on('close',code=>{signal.removeEventListener('abort',abort);if(text.trim())line(text);if(start!==undefined)silences.push({start,end:duration});if(signal.aborted)reject(signal.reason);else if(failure||code!==0)reject(failure||new Error('静音分析失败'));else resolve({silences,peakDb})})
  })
  return {...segmentsAroundSilence(duration,data.silences,options,data.peakDb),duration,...options,method:'peak_dbfs',peakDb:Number.isFinite(data.peakDb)?data.peakDb:null}
}
export function createAudioSilence({ensureTools=async()=>{},ffmpeg=()=>process.env.OIP_FFMPEG_PATH||'ffmpeg',ffprobe=()=>process.env.OIP_FFPROBE_PATH||'ffprobe'}={}){
  const jobs=new MediaJobs<Awaited<ReturnType<typeof analyze>>>(1,{timeoutMs:120000})
  return {async read(scope:string,file:File,input:Partial<SilenceOptions>,signal?:AbortSignal,validate:()=>void=()=>{}){
    const options=silenceOptions(input);if(!file.diskPath||!file.mime.startsWith('audio/'))throw new Error('当前文件无法在本机分析静音')
    const key=JSON.stringify([scope,file.path,file.revision,options]);if(!jobs.has(key)&&jobs.size>=16)throw new Error('静音分析正在排队，请稍后重试')
    return jobs.run(key,async(taskSignal,beforeCommit)=>{await waitForMedia(ensureTools(),taskSignal);const result=await analyze(file,options,ffmpeg(),ffprobe(),taskSignal);await beforeCommit();return result},signal,validate)
  },stop:()=>jobs.stop()}
}
