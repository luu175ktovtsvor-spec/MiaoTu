import { nodeTools, z } from './nodeTools';

export function useMediaPlaybackTools(element: () => HTMLMediaElement | undefined, prepare?: (signal?: AbortSignal) => Promise<void>) {
  const status = () => {
    const media = element();
    if (!media) throw new Error('播放器尚未就绪');
    return { paused: media.paused, currentTime: media.currentTime, duration: Number.isFinite(media.duration) ? media.duration : null, volume: media.volume, muted: media.muted, playbackRate: media.playbackRate, readyState: media.readyState, fullscreen: document.fullscreenElement === media };
  };
  nodeTools.register({
    name: 'controlPlayback', description: '读取或控制当前节点播放器：status、play、pause、seek（time 秒）、configure（volume 0–1 / muted）及 fullscreen/exitFullscreen。只影响预览，不改原片。全屏仍受系统用户手势权限约束，失败会明确报错。',
    parameters: z.strictObject({ action: z.enum(['status','play','pause','seek','configure','fullscreen','exitFullscreen']), time: z.number().finite().min(0).optional(), volume: z.number().min(0).max(1).optional(), muted: z.boolean().optional() }),
    async execute(args, { signal }) {
      if (args.action === 'status') return status();
      if (args.action === 'pause') { element()?.pause(); return status(); }
      await prepare?.(signal); signal?.throwIfAborted();
      const media = element(); if (!media) throw new Error('播放器尚未就绪');
      if (args.action === 'play') await media.play();
      if (args.action === 'seek') {
        if (args.time === undefined || !Number.isFinite(media.duration) || args.time > media.duration) throw new Error('请等待媒体加载并提供时长范围内的 time');
        media.currentTime = args.time;
      }
      if (args.volume !== undefined) media.volume = args.volume;
      if (args.muted !== undefined) media.muted = args.muted;
      if (args.action === 'fullscreen') await media.requestFullscreen();
      if (args.action === 'exitFullscreen' && document.fullscreenElement) await document.exitFullscreen();
      signal?.throwIfAborted(); return status();
    },
  });
}
