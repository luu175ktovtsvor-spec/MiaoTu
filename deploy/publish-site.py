#!/usr/bin/env python3
"""Publish only official-site HTML/assets; leave API and admin containers running."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import urllib.request


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def health():
    return json.loads(run('docker', 'exec', 'miaoimg', 'node', '-e',
        "Promise.all([4173,4175,4176,4184].map(async port=>{const r=await fetch('http://127.0.0.1:'+port+'/health');if(!r.ok)throw Error(port+':'+r.status);return {port,status:r.status}})).then(v=>console.log(JSON.stringify(v))).catch(e=>{console.error(e.message);process.exit(1)})"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    args = parser.parse_args()
    image = json.loads(run('docker', 'image', 'inspect', args.image))[0]
    revision = image['Config'].get('Labels', {}).get('org.opencontainers.image.revision', '')
    if not re.fullmatch('[0-9a-f]{40}', revision):
        raise SystemExit('Image requires a full source revision label')
    image_id = image['Id']
    locks = []
    for name in ['/opt/miaoimg/.production-release.lock', '/run/lock/miaoimg-deploy.lock']:
        handle = open(name, 'a'); fcntl.flock(handle, fcntl.LOCK_EX); locks.append(handle)
    identities = {name: run('docker', 'inspect', '--format', '{{.Id}}', name)
                  for name in ['miaoimg', 'miaoimg-admin']}
    health()
    base = Path('/opt/miaoimg')
    releases = base / 'site-releases'; releases.mkdir(exist_ok=True)
    shared = base / 'site-assets'; shared.mkdir(exist_ok=True)
    release = releases / revision; release.mkdir(exist_ok=True)
    current = base / 'site-current'
    if current.exists() and not current.is_symlink():
        raise SystemExit('site-current must be a managed symlink')
    previous = os.readlink(current) if current.is_symlink() else None
    config = Path('/etc/nginx/sites-enabled/miaoimg.conf').resolve()
    snippet = Path('/etc/nginx/snippets/miaoimg-official-site-html.conf')
    original = config.read_bytes()
    previous_snippet = snippet.read_bytes() if snippet.exists() else None
    backup = base / 'site-backups' / (time.strftime('%Y%m%d-%H%M%S') + '-' + revision[:12])
    backup.mkdir(parents=True, mode=0o700)
    (backup / 'nginx.conf').write_bytes(original)
    if previous_snippet is not None: (backup / 'html.conf').write_bytes(previous_snippet)
    (backup / 'state.json').write_text(json.dumps({'previous': previous, 'containers': identities, 'revision': revision}))
    extractor = run('docker', 'create', '--entrypoint', '/bin/true', image_id)
    try:
        with tempfile.TemporaryDirectory(prefix='site-incoming-', dir=base) as tmp:
            temp = Path(tmp)
            # Cached older pages still need their exact hashed assets after the switch.
            for source, label in [('miaoimg', 'old'), (extractor, 'new')]:
                folder = temp / label; folder.mkdir()
                run('docker', 'cp', source + ':/app/web/dist/assets', str(folder))
                for asset in (folder / 'assets').rglob('*'):
                    if not asset.is_file(): continue
                    target = shared / 'assets' / asset.relative_to(folder / 'assets')
                    target.parent.mkdir(parents=True, exist_ok=True)
                    if target.exists():
                        if digest(asset) != digest(target): raise RuntimeError('Asset name collision: ' + target.name)
                    else:
                        shutil.copyfile(asset, target); target.chmod(0o644)
            run('docker', 'cp', extractor + ':/app/web/dist/index.html', str(release / 'index.html'))
            (release / 'index.html').chmod(0o644)
            html = (release / 'index.html').read_text()
            for path in re.findall(r'(?:src|href)="(/assets/[^"?]+)', html):
                if not (shared / path.lstrip('/')).is_file(): raise RuntimeError('Missing HTML asset: ' + path)
    finally:
        run('docker', 'rm', extractor)
    block = '''    location /assets/ {
        root /opt/miaoimg/site-assets;
        error_page 404 = @miaoimg_runtime_assets;
        expires 1y;
        access_log off;
    }
    location @miaoimg_runtime_assets {
        proxy_pass http://127.0.0.1:4173;
        proxy_set_header Host 127.0.0.1:4173;
    }'''
    text = original.decode()
    text, count = re.subn(r'    location /assets/ \{.*?\n    \}', lambda _: block, text, flags=re.S)
    if count != 1: raise RuntimeError('Expected exactly one asset location')
    include = '    include /etc/nginx/snippets/miaoimg-official-site-html.conf;'
    if include not in text:
        anchor = '    include /etc/nginx/snippets/miaoimg-official-site-media.conf;'
        if text.count(anchor) != 1: raise RuntimeError('Official media include not found')
        text = text.replace(anchor, anchor + '\n' + include)
    switched = False
    try:
        snippet.write_text('''location = / {
    root /opt/miaoimg/site-current;
    try_files /index.html =503;
    open_file_cache off;
    add_header Cache-Control "no-store" always;
    add_header X-Miaoimg-Site-Revision "''' + revision + '''" always;
}
''')
        link = base / 'site-next'; link.unlink(missing_ok=True); link.symlink_to(release)
        os.replace(link, current)
        config.write_text(text)
        run('nginx', '-t'); run('systemctl', 'reload', 'nginx'); switched = True
        # Nginx reload is graceful: existing workers may finish a request with old HTML.
        for attempt in range(20):
            request = urllib.request.Request('https://miaoimg.cn/?site-verify=' + str(time.time()), headers={'Cache-Control': 'no-cache', 'Connection': 'close'})
            with urllib.request.urlopen(request, timeout=20) as response:
                matched = response.status == 200 and response.headers.get('X-Miaoimg-Site-Revision') == revision
            if matched:
                break
            time.sleep(.5)
        else:
            raise RuntimeError('Public HTML revision mismatch after graceful reload')
        ports = health()
        for name, identity in identities.items():
            if run('docker', 'inspect', '--format', '{{.Id}}', name) != identity:
                raise RuntimeError('Unexpected container change: ' + name)
        report = {'revision': revision, 'image': args.image, 'release': str(release), 'backup': str(backup),
                  'containersUnchanged': identities, 'health': ports}
        (base / 'site-release.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report, indent=2))
    except BaseException:
        config.write_bytes(original)
        if previous_snippet is None: snippet.unlink(missing_ok=True)
        else: snippet.write_bytes(previous_snippet)
        current.unlink(missing_ok=True)
        if previous: current.symlink_to(previous)
        run('nginx', '-t')
        if switched: run('systemctl', 'reload', 'nginx')
        raise


if __name__ == '__main__':
    main()
