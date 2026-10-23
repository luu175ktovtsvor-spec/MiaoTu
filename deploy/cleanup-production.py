#!/usr/bin/env python3
"""服务器统一清理入口：验收后只留当前版和一个数据库恢复快照；不替代网页验收。"""
import argparse
import fcntl
import gzip
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time
import sqlite3

ROOT = pathlib.Path("/opt/miaoimg")
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('container', nargs='?', default='miaoimg')
parser.add_argument('build_dir', nargs='?', type=pathlib.Path)
parser.add_argument('--accepted-revision', help='网页验收完成后明确确认当前源码 revision')
parser.add_argument('--maintenance', action='store_true', help='回收无引用 blob、过期预览，并更新唯一数据库快照')
args = parser.parse_args()
container, build_dir = args.container, args.build_dir
assert re.fullmatch(r'[A-Za-z0-9_.-]+', container)

def run(args):
    return subprocess.check_output(args, text=True).strip()

def inspect_all():
    ids = run(["docker", "ps", "-aq"]).split()
    return json.loads(run(["docker", "inspect", *ids])) if ids else []

def digest(stream):
    h = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        h.update(chunk)
    return h.hexdigest()

lock = (ROOT / ".production-release.lock").open("a")
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    raise SystemExit("发布正在进行，清理请在发布和网页验收结束后执行")
before = os.statvfs("/")
items = inspect_all()
current = next(x for x in items if x["Name"] == "/" + container)
assert current["State"]["Running"] and current["State"].get("Health", {}).get("Status") == "healthy"
revision = current['Config'].get('Labels', {}).get('org.opencontainers.image.revision', '')
accepted_path = ROOT / '.accepted-revision'
if args.accepted_revision:
    assert re.fullmatch(r'[0-9a-f]{40}', args.accepted_revision) and args.accepted_revision == revision
    pending = accepted_path.with_suffix('.part')
    pending.write_text(revision + '\n')
    os.replace(pending, accepted_path)
accepted = bool(revision and accepted_path.exists() and accepted_path.read_text().strip() == revision)
previous = sorted(
    (x for x in items if x["Name"].startswith(("/" + container + ".previous", "/" + container + ".previous-"))
     and not x["State"]["Running"] and x["State"]["Status"] == "exited"),
    key=lambda x: x["Created"], reverse=True,
)
keep_previous = 0 if accepted else 1
report = {"accepted": accepted, "retainedRollback": previous[0]["Name"].lstrip("/") if previous and keep_previous else None,
          "removedContainers": [], "removedImages": [], "removedBackups": []}
# 不使用 rm -f：并发启动过的容器必须由 Docker 拒绝删除。
for old in previous[keep_previous:]:
    run(["docker", "rm", old["Id"]])
    report["removedContainers"].append(old["Name"].lstrip("/"))
items = inspect_all()
protected_images = {x["Image"] for x in items}
if previous or accepted:
    for line in run(["docker", "image", "ls", "--no-trunc", "--format", "{{json .}}"]).splitlines():
        image = json.loads(line)
        if image["Repository"] not in ("miaoimg", "miaoimg-admin", "open-image-prompts") or image["Tag"] == "<none>":
            continue
        if image["ID"] in protected_images:
            continue
        tag = image["Repository"] + ":" + image["Tag"]
        metadata = json.loads(run(["docker", "image", "inspect", tag]))[0]
        # 比当前线上还新的候选镜像可能属于其他任务，留给该任务收尾。
        if metadata["Created"] > current["Created"]:
            continue
        run(["docker", "image", "rm", tag])
        report["removedImages"].append(tag)

if args.maintenance:
    # 备份小型账号/索引数据库，不复制任何原始图片或视频。
    source_path = next(m['Source'] for m in current['Mounts'] if m['Destination'] == '/app/data')
    pending_db = ROOT / 'backups' / 'management-latest.sqlite.part'
    pending_db.parent.mkdir(exist_ok=True)
    pending_db.unlink(missing_ok=True)
    source = sqlite3.connect('file:' + source_path + '/management.sqlite?mode=ro', uri=True)
    target = sqlite3.connect(pending_db)
    try:
        source.backup(target)
        assert target.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    finally:
        source.close(); target.close()
    pending_gz = pending_db.with_suffix('.gz.part')
    try:
        with pending_db.open('rb') as src, gzip.open(pending_gz, 'wb') as dst:
            shutil.copyfileobj(src, dst)
        with pending_db.open('rb') as src: original = digest(src)
        with gzip.open(pending_gz, 'rb') as src: assert digest(src) == original
        os.chmod(pending_gz, 0o600)
        os.replace(pending_gz, ROOT / 'backups' / 'management-latest.sqlite.gz')
    finally:
        pending_db.unlink(missing_ok=True); pending_gz.unlink(missing_ok=True)
    # 只使用具有原子引用保护的新回收入口；未升级的容器不跑旧 --fix。
    if run(['docker', 'exec', container, 'sh', '-c', 'test -f /app/server/reclaim-unused-blobs.ts && echo supported || true']) == 'supported':
        report['blobCleanup'] = json.loads(run(['docker', 'exec', container, 'node', 'server/reclaim-unused-blobs.ts', '--apply']))
    # 预览是可重建派生文件；原始 blob 和历史引用永远不按时间清理。
    previews = []
    for directory in [ROOT / 'media' / '_previews', *(ROOT / 'media').glob('*/_previews')]:
        if directory.is_symlink(): continue
        previews.extend(p for p in directory.glob('*.jpg') if p.is_file() and not p.is_symlink())
    previews.sort(key=lambda p: p.stat().st_mtime_ns)
    total = sum(p.stat().st_size for p in previews)
    removed_previews = 0
    for path in previews:
        info = path.stat()
        if total <= 256 * 1024**2 and time.time() - info.st_mtime < 30 * 86400: continue
        if time.time() - info.st_mtime < 120: continue
        path.unlink(); total -= info.st_size; removed_previews += 1
    report['previewCleanup'] = {'removed': removed_previews, 'retainedBytes': total}

# 只处理已关闭的独立数据库快照；当前数据库、媒体和唯一历史归档不在此范围。
snapshots = []
for root in (ROOT / "backups", pathlib.Path("/opt/miaoimg-releases")):
    for path in root.rglob("management*.sqlite*"):
        if path.is_symlink() or not path.is_file() or not path.name.endswith((".sqlite", ".sqlite.gz")):
            continue
        raw = pathlib.Path(str(path).removesuffix(".gz"))
        wal = pathlib.Path(str(raw) + "-wal")
        if wal.exists() and wal.stat().st_size:
            continue
        snapshots.append(path)
snapshots.sort(key=lambda p: p.stat().st_mtime_ns, reverse=True)
retained = []
for path in snapshots[:1]:
    if path.name.endswith(".gz"):
        retained.append(str(path))
        continue
    stat = path.stat()
    target = pathlib.Path(str(path) + ".gz")
    pending = pathlib.Path(str(target) + ".part")
    assert not target.exists() and not pending.exists()
    try:
        with path.open("rb") as source:
            original_hash = digest(source)
        with path.open("rb") as source, pending.open("xb") as output:
            os.chmod(pending, 0o600)
            with gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=0) as zipped:
                shutil.copyfileobj(source, zipped)
        with gzip.open(pending, "rb") as source:
            assert digest(source) == original_hash
        actual = path.stat()
        assert (actual.st_size, actual.st_mtime_ns) == (stat.st_size, stat.st_mtime_ns)
        os.utime(pending, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        pending.rename(target)
        path.unlink()
        retained.append(str(target))
    finally:
        pending.unlink(missing_ok=True)
for path in snapshots[1:]:
    path.unlink()
    report['removedBackups'].append(str(path))
report["retainedDatabaseBackups"] = retained

history = [json.loads(line) for line in run(["docker", "buildx", "history", "ls", "--format", "json"]).splitlines()]
if any(x["status"] not in ("Completed", "Error", "Canceled") for x in history):
    report["cacheCleanup"] = "构建进行中，交给本次构建完成后清理"
else:
    result = run(["docker", "buildx", "prune", "--all", "--force"])
    report["cacheCleanup"] = result.splitlines()[-1] if result else "完成"

if build_dir:
    assert not build_dir.is_symlink()
    resolved = build_dir.resolve()
    assert resolved == pathlib.Path("/opt/miaoimg-build") or resolved.parent == pathlib.Path("/opt/miaoimg-builds")
    assert not (resolved / ".git").exists()
    mounts = [m["Source"] for x in items for m in x["Mounts"]]
    assert not any(m == str(resolved) or m.startswith(str(resolved) + "/")
                   or str(resolved).startswith(m + "/") for m in mounts)
    for proc in pathlib.Path("/proc").iterdir():
        if proc.name.isdigit():
            try:
                cwd = os.readlink(proc / "cwd")
            except OSError:
                continue
            assert cwd != str(resolved) and not cwd.startswith(str(resolved) + "/")
    if resolved.exists():
        shutil.rmtree(resolved)
    report["removedBuildDirectory"] = str(resolved)
after = os.statvfs("/")
report["availableBytes"] = after.f_bavail * after.f_frsize
report["freedBytes"] = report["availableBytes"] - before.f_bavail * before.f_frsize
print(json.dumps(report, ensure_ascii=False))
