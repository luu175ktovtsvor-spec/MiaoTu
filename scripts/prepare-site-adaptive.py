#!/usr/bin/env python3
"""Build a small initial HLS rendition plus a retained HD rendition for slow links."""
import argparse
from fractions import Fraction
from concurrent.futures import ThreadPoolExecutor
import threading
import json
from pathlib import Path
import runpy
import shutil
import subprocess

helpers = runpy.run_path(str(Path(__file__).with_name('prepare-site-playback.py')))
probe, sha = helpers['probe'], helpers['sha']


def playlist_stats(path):
    durations, segments = [], []
    for line in path.read_text().splitlines():
        if line.startswith('#EXTINF:'):
            durations.append(float(line.split(':')[1].rstrip(',')))
        elif line and not line.startswith('#'):
            segments.append(path.parent / line)
    if not segments or len(segments) != len(durations) or any(not segment.is_file() for segment in segments):
        raise ValueError('Incomplete playlist: ' + str(path))
    return {'seconds': sum(durations), 'bytes': sum(segment.stat().st_size for segment in segments),
            'peak': max(int(segment.stat().st_size * 8 / duration) for segment, duration in zip(segments, durations))}


def add_hero_rendition(args, mapping, records):
    hero = '/showcase/turkey-film-clean-20261014/brand-film.mp4'
    if hero not in mapping:
        return
    prepared = json.loads(args.playback.read_text())
    source = args.root / prepared.get(hero, hero).removeprefix('/showcase/')
    folder = args.root / mapping[hero]['master'].removeprefix('/showcase/')
    folder = folder.parent
    medium = folder / 'medium'
    if not (medium / 'index.m3u8').exists():
        temporary = folder / '.medium-pending'
        shutil.rmtree(temporary, ignore_errors=True); temporary.mkdir()
        video = next(s for s in probe(source)['streams'] if s['codec_type'] == 'video')
        rate = float(Fraction(video['avg_frame_rate']))
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', str(source),
            '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2',
            '-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-maxrate', '650k', '-bufsize', '650k',
            '-pix_fmt', 'yuv420p', '-fps_mode', 'passthrough', '-g', str(round(rate * 2)), '-sc_threshold', '0',
            '-force_key_frames', 'expr:gte(t,n_forced*2)', '-threads', '2', '-c:a', 'aac', '-b:a', '96k',
            '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments',
            '-hls_segment_filename', str(temporary / '%04d.ts'), str(temporary / 'index.m3u8')], check=True)
        playlist_stats(temporary / 'index.m3u8')
        temporary.rename(medium)
    stats = playlist_stats(medium / 'index.m3u8')
    record = next(record for record in records if record['source'] == hero)
    if abs(stats['seconds'] - record['low']['seconds']) > .3:
        raise ValueError('Hero middle rendition duration mismatch')
    master = (folder / 'master.m3u8').read_text()
    bandwidth = int(stats['peak'] * 1.1)
    average = int(stats['bytes'] * 8 / stats['seconds'])
    lines = master.splitlines()
    position = next(i for i, line in enumerate(lines) if line == 'high/index.m3u8') - 1
    lines[position:position] = [f'#EXT-X-STREAM-INF:BANDWIDTH={bandwidth},AVERAGE-BANDWIDTH={average},RESOLUTION=1280x720', 'medium/index.m3u8']
    enhanced = '\n'.join(lines) + '\n'
    target = folder / 'master-720.m3u8'
    if target.exists() and target.read_text() != enhanced:
        raise ValueError('Published hero master would change bytes')
    target.write_text(enhanced)
    mapping[hero]['master'] = mapping[hero]['master'].replace('master.m3u8', 'master-720.m3u8')
    mapping[hero]['manifest'] = enhanced
    record['master'] = mapping[hero]['master']; record['medium'] = stats


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['root', 'films', 'playback', 'output', 'report']:
        parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    films = json.loads(args.films.read_text().split('export const films: ShowcaseFilm[] = ', 1)[1].strip().rstrip(';'))
    prepared = json.loads(args.playback.read_text())
    urls = list(dict.fromkeys(['/showcase/turkey-film-clean-20261014/brand-film.mp4', *[film['video'] for film in films]]))
    urls.sort(key=lambda url: (0 if 'new-136.mp4' in url else 1 if 'brand-film' in url else 2))
    mapping, records = {}, []
    locks, lock_guard = {}, threading.Lock()
    def prepare(entry):
        index, url = entry
        source = (args.root / prepared.get(url, url).removeprefix('/showcase/')).resolve()
        if not source.is_relative_to(args.root.resolve()):
            raise ValueError('Media path escaped root')
        info = probe(source)
        if int(info['format'].get('bit_rate', 0)) <= 550_000:
            return
        video = next(stream for stream in info['streams'] if stream['codec_type'] == 'video')
        digest = sha(source)
        parent = args.root / 'adaptive-v3'; parent.mkdir(exist_ok=True)
        with lock_guard:
            lock = locks.setdefault(digest, threading.Lock())
        with lock:
            folder = parent / digest[:20]
            if not (folder / 'master.m3u8').exists():
                temporary = parent / ('.pending-' + digest[:20])
                if temporary.exists():
                    shutil.rmtree(temporary)
                (temporary / 'low').mkdir(parents=True)
                (temporary / 'high').mkdir()
                common = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', str(source),
                          '-map', '0:v:0', '-map', '0:a:0?']
                def finish(level):
                    return ['-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments',
                            '-hls_segment_filename', str(temporary / level / '%04d.ts'), str(temporary / level / 'index.m3u8')]
                rate = float(Fraction(video['avg_frame_rate']))
                try:
                    subprocess.run(common + ['-vf', "scale=w='if(gte(iw,ih),min(640,iw),min(360,iw))':h='if(gte(iw,ih),min(360,ih),min(640,ih))':force_original_aspect_ratio=decrease:force_divisible_by=2",
                        '-c:v', 'libx264', '-preset', 'superfast', '-crf', '24', '-maxrate', '300k', '-bufsize', '300k',
                        '-pix_fmt', 'yuv420p', '-fps_mode', 'passthrough', '-g', str(max(1, round(rate * 2))), '-sc_threshold', '0',
                        '-force_key_frames', 'expr:gte(t,n_forced*2)', '-threads', '2', '-c:a', 'aac', '-b:a', '64k'] + finish('low'), check=True)
                    subprocess.run(common + ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k'] + finish('high'), check=True)
                    low, high = [playlist_stats(temporary / level / 'index.m3u8') for level in ['low', 'high']]
                    if abs(low['seconds'] - high['seconds']) > .3:
                        # Some source edit lists begin before their first copyable keyframe.
                        # Decode that exceptional HD rendition instead of dropping its opening.
                        shutil.rmtree(temporary / 'high'); (temporary / 'high').mkdir()
                        subprocess.run(common + ['-vf', "scale=w='if(gte(iw,ih),min(1920,iw),min(1080,iw))':h='if(gte(iw,ih),min(1080,ih),min(1920,ih))':force_original_aspect_ratio=decrease:force_divisible_by=2",
                            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-maxrate', '4M', '-bufsize', '8M',
                            '-pix_fmt', 'yuv420p', '-fps_mode', 'passthrough', '-g', str(max(1, round(rate * 2))), '-sc_threshold', '0',
                            '-force_key_frames', 'expr:gte(t,n_forced*2)', '-threads', '2', '-c:a', 'aac', '-b:a', '128k'] + finish('high'), check=True)
                        high = playlist_stats(temporary / 'high/index.m3u8')
                        if abs(low['seconds'] - high['seconds']) > .3:
                            raise ValueError('Rendition duration mismatch after decode: ' + url)
                    low_video = next(stream for stream in probe(temporary / 'low/0000.ts')['streams'] if stream['codec_type'] == 'video')
                    lines = ['#EXTM3U', '#EXT-X-VERSION:3']
                    high_video = next(stream for stream in probe(temporary / 'high/0000.ts')['streams'] if stream['codec_type'] == 'video')
                    for name, stats, dimensions in [('low', low, low_video), ('high', high, high_video)]:
                        peak = int(stats['peak'] * 1.1)
                        average = int(stats['bytes'] * 8 / stats['seconds'])
                        lines += [f'#EXT-X-STREAM-INF:BANDWIDTH={peak},AVERAGE-BANDWIDTH={average},RESOLUTION={dimensions["width"]}x{dimensions["height"]}', name + '/index.m3u8']
                    (temporary / 'master.m3u8').write_text('\n'.join(lines) + '\n')
                    temporary.rename(folder)
                except BaseException:
                    shutil.rmtree(temporary, ignore_errors=True)
                    raise
        low, high = [playlist_stats(folder / level / 'index.m3u8') for level in ['low', 'high']]
        master = '/showcase/' + str(folder.relative_to(args.root)) + '/master.m3u8'
        mapping[url] = {'master': master, 'manifest': (folder / 'master.m3u8').read_text(), 'low': (folder / 'low/index.m3u8').read_text()}
        records.append({'source': url, 'master': master, 'sourceSha256': digest, 'low': low, 'high': high})
        print(f'{index + 1}/{len(urls)} adaptive {url}; low={int(low["bytes"] * 8 / low["seconds"])} bps', flush=True)
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(prepare, enumerate(urls)))
    add_hero_rendition(args, mapping, records)
    args.output.write_text(json.dumps(mapping, indent=2) + '\n')
    args.report.write_text(json.dumps({'inspected': len(urls), 'adaptive': len(records), 'files': records}, indent=2) + '\n')
    print(f'Inspected {len(urls)} videos; {len(records)} adaptive packages ready.', flush=True)


if __name__ == '__main__':
    main()
