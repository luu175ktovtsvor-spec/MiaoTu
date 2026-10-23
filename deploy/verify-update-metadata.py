#!/usr/bin/env python3
"""核对 electron-builder 更新元数据：版本一致，引用的每个文件存在、大小和 sha512 都对得上。"""
import base64, hashlib, os, re, sys
version, *metas = sys.argv[1:]
for meta in metas:
    text = open(meta, encoding='utf-8').read()
    found = re.search(r'^version: (.+)$', text, re.M)
    if not found or found.group(1).strip().strip("'\"") != version:
        sys.exit(f'{meta} 的版本不是 {version}')
    entries = re.findall(r'- url: (.+)\n\s+sha512: (.+)\n\s+size: (\d+)', text)
    if not entries:
        sys.exit(f'{meta} 没有文件条目')
    for url, sha, size in entries:
        url = url.strip()
        if not os.path.isfile(url):
            sys.exit(f'{meta} 引用的 {url} 不存在')
        if os.path.getsize(url) != int(size):
            sys.exit(f'{url} 大小与 {meta} 不一致')
        digest = hashlib.sha512()
        with open(url, 'rb') as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b''):
                digest.update(chunk)
        if base64.b64encode(digest.digest()).decode() != sha.strip():
            sys.exit(f'{url} 的 sha512 与 {meta} 不一致')
    print(f'{meta}：{len(entries)} 个文件核对通过')
