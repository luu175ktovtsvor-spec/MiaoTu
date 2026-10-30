export type SilenceOptions = { thresholdDb: number; minSilence: number; padding: number };
export type SilenceRange = { start: number; end: number };
export function silenceOptions(input: Partial<SilenceOptions> = {}): SilenceOptions {
  const value = { thresholdDb: input.thresholdDb ?? -40, minSilence: input.minSilence ?? 0.4, padding: input.padding ?? 0.04 };
  if (!Number.isFinite(value.thresholdDb) || value.thresholdDb < -90 || value.thresholdDb > -5 || !Number.isFinite(value.minSilence) || value.minSilence < 0.05 || value.minSilence > 10 || !Number.isFinite(value.padding) || value.padding < 0 || value.padding > 1) throw Object.assign(new Error('静音检测参数超出范围'),{status:422});
  return value;
}
export function segmentsAroundSilence(duration: number, silences: SilenceRange[], options: SilenceOptions, peakDb: number) {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(peakDb) && peakDb !== -Infinity) throw new Error('无法读取有效的静音分析结果');
  if (peakDb <= options.thresholdDb) return { status: 'all_silent', segments: [] as SilenceRange[] };
  const removed = silences.map(range => ({ start: Math.max(0,range.start) + (range.start > 0 ? options.padding : 0), end: Math.min(duration,range.end) - (range.end < duration ? options.padding : 0) }))
    .filter(range => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start).sort((a,b)=>a.start-b.start);
  const segments: SilenceRange[] = []; let cursor = 0;
  for (const range of removed) {
    if (range.start > cursor) segments.push({start:cursor,end:Math.min(duration,range.start)});
    cursor = Math.max(cursor,range.end);
  }
  if (cursor < duration) segments.push({start:cursor,end:duration});
  const valid = segments.filter(range=>range.end>range.start);
  if (valid.length > 1000) throw new Error('检测到过多片段，请调整静音阈值或最短静音时长后重试');
  return {status:removed.length ? 'split' : 'no_silence',segments:valid};
}
