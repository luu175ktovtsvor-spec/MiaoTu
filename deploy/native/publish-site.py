#!/usr/bin/env python3
"""Publish reviewed official-site assets and optional installer on the native host."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import urllib.request


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def health():
    result = {}
    for port in [4173, 4175, 4176, 4184]:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=10) as response:
            if response.status != 200:
                raise RuntimeError(f'Unhealthy port: {port}')
            result[str(port)] = response.status
    return result


def identities():
    result = {}
    for name in ['miaoimg.service', 'miaoimg-catalog.service']:
        values = dict(line.split('=', 1) for line in run('systemctl', 'show', name, '-p', 'ActiveState', '-p', 'MainPID').splitlines())
        if values.get('ActiveState') != 'active' or values.get('MainPID', '0') == '0':
            raise RuntimeError('Inactive service: ' + name)
        result[name] = values['MainPID']
    return result


def atomic_bytes(path, value):
    temp = path.with_name(path.name + '.site-next')
    temp.write_bytes(value)
    temp.chmod(0o644)
    os.replace(temp, path)


def switch(current, target):
    link = current.with_name('site-next')
    link.unlink(missing_ok=True)
    link.symlink_to(target)
    os.replace(link, current)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dist', type=Path, required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--install-script', type=Path)
    args = parser.parse_args()
    if not re.fullmatch('[0-9a-f]{40}', args.revision):
        parser.error('revision must be a full commit SHA')
    if not (args.dist / 'index.html').is_file() or not (args.dist / 'assets').is_dir():
        parser.error('dist must contain index.html and assets/')
    if args.install_script:
        run('sh', '-n', str(args.install_script))
    locks = []
    for name in ['/opt/miaoimg/.production-release.lock', '/run/lock/miaoimg-deploy.lock']:
        handle = open(name, 'a')
        fcntl.flock(handle, fcntl.LOCK_EX)
        locks.append(handle)
    base = Path('/opt/miaoimg')
    current = base / 'site-current'
    if not current.is_symlink():
        raise RuntimeError('Expected managed site-current symlink')
    previous = os.readlink(current)
    before = identities()
    health()
    release = base / 'site-releases' / args.revision
    if release.exists():
        raise RuntimeError('Site revision already exists; do not overwrite a release')
    release.mkdir(parents=True)
    shared = base / 'site-assets' / 'assets'
    shared.mkdir(parents=True, exist_ok=True)
    # Old HTML and in-flight sessions must retain their content-addressed assets.
    for asset in (args.dist / 'assets').rglob('*'):
        if not asset.is_file():
            continue
        target = shared / asset.relative_to(args.dist / 'assets')
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            if digest(asset) != digest(target):
                raise RuntimeError('Asset name collision: ' + target.name)
        else:
            shutil.copyfile(asset, target)
            target.chmod(0o644)
    html = (args.dist / 'index.html').read_bytes()
    for reference in re.findall(r'(?:src|href)="(?:\./|/)?assets/([^"?]+)', html.decode()):
        if not (shared / reference).is_file():
            raise RuntimeError('Missing HTML asset: ' + reference)
    (release / 'index.html').write_bytes(html)
    (release / 'index.html').chmod(0o644)
    snippet = Path('/etc/nginx/snippets/miaoimg-official-site-html.conf')
    original_snippet = snippet.read_bytes()
    script = base / 'desktop-downloads' / 'updates' / 'install-mac.sh'
    original_script = script.read_bytes() if args.install_script else None
    backup = base / 'site-backups' / (time.strftime('%Y%m%d-%H%M%S') + '-' + args.revision[:12])
    backup.mkdir(parents=True, mode=0o700)
    (backup / 'html.conf').write_bytes(original_snippet)
    if original_script is not None:
        (backup / 'install-mac.sh').write_bytes(original_script)
    (backup / 'state.json').write_text(json.dumps({'previous': previous, 'services': before, 'revision': args.revision}))
    switched = False
    try:
        def html_location(route):
            return f'''location = {route} {{
    root /opt/miaoimg/site-current;
    try_files /index.html =503;
    open_file_cache off;
    add_header Cache-Control "no-store" always;
    add_header X-Miaoimg-Site-Revision "{args.revision}" always;
}}
'''
        if args.install_script:
            atomic_bytes(script, args.install_script.read_bytes())
        atomic_bytes(snippet, (html_location('/') + html_location('/changelog')).encode())
        switch(current, release)
        switched = True
        run('nginx', '-t')
        run('systemctl', 'reload', 'nginx')
        for attempt in range(20):
            request = urllib.request.Request('https://miaoimg.cn/?site-verify=' + str(time.time()), headers={'Cache-Control': 'no-cache', 'Connection': 'close'})
            with urllib.request.urlopen(request, timeout=15) as response:
                if response.status == 200 and response.headers.get('X-Miaoimg-Site-Revision') == args.revision:
                    break
            time.sleep(.5)
        else:
            raise RuntimeError('Public site revision mismatch')
        after = identities()
        if after != before:
            raise RuntimeError('Business service identities changed during static publication')
        report = {'revision': args.revision, 'release': str(release), 'previous': previous, 'backup': str(backup), 'servicesUnchanged': before, 'health': health(), 'installerSha256': digest(script)}
        (base / 'site-release.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report, indent=2))
    except BaseException:
        atomic_bytes(snippet, original_snippet)
        if original_script is not None:
            atomic_bytes(script, original_script)
        if switched:
            switch(current, previous)
        run('nginx', '-t')
        run('systemctl', 'reload', 'nginx')
        raise


if __name__ == '__main__':
    main()
