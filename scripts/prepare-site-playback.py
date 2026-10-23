#!/usr/bin/env python3
"""Prepare bounded-bitrate, fast-start website previews without changing originals."""
import argparse
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import re
import struct
import subprocess

# Homepage film; it is not part of films.ts but is prepared with the catalog.
HERO = '/showcase/turkey-3d-20261023/brand-film.mp4'


def probe(path):
    return json.loads(subprocess.check_output([
        'ffprobe', '-v', 'error', '-show_entries',
        'format=duration,bit_rate:stream=codec_type,codec_name,width,height,avg_frame_rate',
        '-of', 'json', str(path)]))


def fast_start(path):
    atoms = []
    with path.open('rb') as stream:
        while header := stream.read(8):
            if len(header) != 8:
                break
            size, kind = struct.unpack('>I4s', header)
            length = 8
            if size == 1:
                size = struct.unpack('>Q', stream.read(8))[0]
                length = 16
            atoms.append(kind)
            if size < length:
                break
            stream.seek(size - length, 1)
    return b'moov' in atoms and b'mdat' in atoms and atoms.index(b'moov') < atoms.index(b'mdat')


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--films', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--report', required=True, type=Path)
    args = parser.parse_args()
    films = json.loads(args.films.read_text().split('export const films: ShowcaseFilm[] = ', 1)[1].strip().rstrip(';'))
    urls = list(dict.fromkeys([HERO, *[film['video'] for film in films]]))
    # First fix the four tail-index clips, then the hero and the remaining catalog.
    urls.sort(key=lambda url: (0 if re.search(r'new-13[4-7]\.mp4$', url) else 1 if 'brand-film' in url else 2))
    mapping, records = {}, []
    for index, url in enumerate(urls):
        if not url.startswith('/showcase/'):
            raise ValueError('Expected a local showcase URL: ' + url)
        path = (args.root / url.removeprefix('/showcase/')).resolve()
        if not path.is_relative_to(args.root.resolve()):
            raise ValueError('Media path escaped root')
        before = probe(path)
        video = next(stream for stream in before['streams'] if stream['codec_type'] == 'video')
        bitrate = int(before['format'].get('bit_rate', 0))
        front = fast_start(path)
        transcode = bitrate > 4_000_000 or video['codec_name'] != 'h264'
        if not transcode and front:
            continue
        fingerprint = sha(path)
        target = path.with_name(path.stem + '.stream-v1-' + fingerprint[:12] + '.mp4')
        if not target.exists():
            temporary = target.with_suffix('.pending.mp4')
            command = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', str(path),
                       '-map', '0:v:0', '-map', '0:a:0?']
            if transcode:
                rate = float(Fraction(video['avg_frame_rate']))
                command += ['-vf', "scale=w='if(gte(iw,ih),min(1920,iw),min(1080,iw))':h='if(gte(iw,ih),min(1080,ih),min(1920,ih))':force_original_aspect_ratio=decrease:force_divisible_by=2",
                            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-maxrate', '4M', '-bufsize', '8M',
                            '-pix_fmt', 'yuv420p', '-g', str(max(1, round(rate * 2))), '-threads', '2',
                            '-c:a', 'aac', '-b:a', '128k']
            else:
                command += ['-c', 'copy']
            command += ['-movflags', '+faststart', str(temporary)]
            try:
                subprocess.run(command, check=True)
                after = probe(temporary)
                if abs(float(after['format']['duration']) - float(before['format']['duration'])) > .25 or not fast_start(temporary):
                    raise ValueError('Preview validation failed: ' + str(path))
                temporary.chmod(0o644)
                temporary.replace(target)
            finally:
                temporary.unlink(missing_ok=True)
        after = probe(target)
        if not fast_start(target):
            raise ValueError('Existing preview is not fast-start: ' + str(target))
        mapped = '/showcase/' + str(target.relative_to(args.root.resolve()))
        mapping[url] = mapped
        records.append({'source': url, 'playback': mapped, 'sourceSha256': fingerprint,
                        'playbackSha256': sha(target), 'sourceBytes': path.stat().st_size,
                        'playbackBytes': target.stat().st_size,
                        'before': before, 'after': after, 'tailIndexFixed': not front})
        print(f'{index + 1}/{len(urls)} prepared {url}: {path.stat().st_size} -> {target.stat().st_size}', flush=True)
    args.output.write_text(json.dumps(mapping, indent=2, ensure_ascii=False) + '\n')
    args.report.write_text(json.dumps({'inspected': len(urls), 'optimized': len(records), 'files': records}, indent=2, ensure_ascii=False) + '\n')
    print(f'Inspected {len(urls)} published videos; optimized {len(records)}.', flush=True)


if __name__ == '__main__':
    main()
