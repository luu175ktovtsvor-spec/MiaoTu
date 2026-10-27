#!/usr/bin/env bash
# Read-only production inspection. The remote program only reads Docker,
# HTTP, systemd metadata, files, and SQLite through read-only connections.
set -Eeuo pipefail

REMOTE_HOST=${REMOTE_HOST:-miaoimg-cn}
REMOTE_CONTAINER=${REMOTE_CONTAINER:-miaoimg}
OUTPUT=text
usage() {
  cat <<'USAGE'
用法：
  deploy/inspect.sh              # SSH 到生产机，输出分区报告
  deploy/inspect.sh --json       # 输出机器可读 JSON
  REMOTE_HOST=root@host deploy/inspect.sh
USAGE
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --json) OUTPUT=json ;;
    --host) shift; [ "$#" -gt 0 ] || { usage >&2; exit 2; }; REMOTE_HOST=$1 ;;
    --container) shift; [ "$#" -gt 0 ] || { usage >&2; exit 2; }; REMOTE_CONTAINER=$1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done
case "$REMOTE_HOST" in *[!A-Za-z0-9_.@:-]*) echo "REMOTE_HOST 含有不安全字符" >&2; exit 2 ;; esac
case "$REMOTE_CONTAINER" in *[!A-Za-z0-9_.-]*) echo "REMOTE_CONTAINER 含有不安全字符" >&2; exit 2 ;; esac

# Mainland production is native. Keep the container inspector only for an
# explicitly selected legacy/customer Docker host, without assuming US root.
if [ "$REMOTE_CONTAINER" = "miaoimg" ]; then
  inspector=$(ssh -o BatchMode=yes -- "$REMOTE_HOST" 'if [ -f /opt/miaoimg-ops/native/inspect.py ]; then echo native; else echo docker; fi')
  if [ "$inspector" = "native" ]; then
    exec ssh -o BatchMode=yes -- "$REMOTE_HOST" python3 /opt/miaoimg-ops/native/inspect.py
  fi
fi

# The remote program only invokes read-only inspection commands. It uses a
# read-only SQLite URI, so opening the production database cannot upgrade the
# schema or create a journal file.
ssh -o BatchMode=yes -- "$REMOTE_HOST" python3 - "$REMOTE_CONTAINER" "$OUTPUT" <<'PY'
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

container = sys.argv[1]
output = sys.argv[2]

def run(args, timeout=20):
    try:
        p = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           timeout=timeout, check=False)
        return p.returncode, p.stdout.strip(), p.stderr.strip()
    except Exception as exc:
        return 125, "", str(exc)

def docker_inspect(name):
    code, out, _ = run(["docker", "inspect", name])
    if code != 0:
        return None
    try:
        return json.loads(out)[0]
    except Exception:
        return None

def redact(name, value):
    upper = name.upper()
    if any(part in upper for part in ("KEY", "PASSWORD", "TOKEN", "SECRET", "PRIVATE")):
        return "[REDACTED_SECRET]"
    return value

def http_code(url):
    code, out, _ = run(["curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}",
                        "--max-time", "8", url], timeout=12)
    if code != 0 or not re.fullmatch(r"[0-9]{3}", out or ""):
        return None
    return int(out)

def service_probe(port, paths):
    return {path: http_code(f"http://127.0.0.1:{port}{path}") for path in paths}

def timer(name):
    result = {"active": None, "last_trigger": None, "next_trigger": None, "result": None}
    code, out, _ = run(["systemctl", "show", name, "-p", "ActiveState", "-p", "LastTriggerUSec",
                        "-p", "NextElapseUSecRealtime", "-p", "Result"])
    if code != 0:
        return result
    for line in out.splitlines():
        key, _, value = line.partition("=")
        if key == "ActiveState": result["active"] = value or None
        elif key == "LastTriggerUSec": result["last_trigger"] = value or None
        elif key == "NextElapseUSecRealtime": result["next_trigger"] = value or None
        elif key == "Result": result["result"] = value or None
    return result

def db_open(path):
    if not path.is_file():
        return None
    try:
        return sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    except Exception:
        return None

def table_columns(db, name):
    try:
        return [row[1] for row in db.execute(f"PRAGMA table_info({name})")]
    except Exception:
        return []

def table_exists(db, name):
    try:
        return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None
    except Exception:
        return False

def scalar(db, sql, args=()):
    try:
        row = db.execute(sql, args).fetchone()
        return row[0] if row else None
    except Exception:
        return None

def rows(db, sql, args=()):
    try:
        return [dict(row) for row in db.execute(sql, args).fetchall()]
    except Exception:
        return []

def file_stats(root):
    files = 0
    size = 0
    path = Path(root)
    if not path.is_dir():
        return {"path": str(path), "files": None, "bytes": None}
    for current, dirs, names in os.walk(path):
        dirs[:] = [name for name in dirs if not name.startswith(".") or name in {".agent-sessions"}]
        for name in names:
            try:
                info = (Path(current) / name).stat()
                if (Path(current) / name).is_file():
                    files += 1
                    size += info.st_size
            except OSError:
                pass
    return {"path": str(path), "files": files, "bytes": size}

def redact_log(line):
    line = re.sub(r"(?i)([A-Z0-9_]*(?:KEY|PASSWORD|TOKEN|SECRET|PRIVATE)[A-Z0-9_]*)=([^\s,;]+)",
                  r"\1=[REDACTED_SECRET]", line)
    line = re.sub(r'(?i)("(?:key|password|token|secret|private)[^"]*"\s*:\s*")([^"]*)(")',
                  r"\1[REDACTED_SECRET]\3", line)
    return line[:500]

def recent_errors():
    code, out, _ = run(["docker", "logs", "--since", "24h", "--tail", "2000", container], timeout=30)
    if code != 0:
        return {"window": "24h", "unique": None, "items": [], "unknown": True}
    counts = {}
    for line in out.splitlines():
        if re.search(r"(?i)(error|exception|fatal|uncaught|traceback|failed|502)", line):
            clean = redact_log(line.strip())
            counts[clean] = counts.get(clean, 0) + 1
    items = [{"line": line, "count": count} for line, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:20]]
    return {"window": "24h", "unique": len(counts), "items": items, "unknown": False}

def container_dataset_counts():
    # The archive API may hydrate /app/.oip/runtime/prompts.db inside the image;
    # that path is not necessarily the host's /opt/miaoimg/.oip/runtime copy.
    code = (
        "import json,os,sqlite3; "
        "p=os.environ.get('OIP_DB_PATH','/app/.oip/runtime/prompts.db'); "
        "c=sqlite3.connect('file:'+p+'?mode=ro',uri=True); "
        "t={r[0] for r in c.execute(\"select name from sqlite_master where type='table'\")}; "
        "print(json.dumps({'path':p,**{n:(c.execute('select count(*) from '+n).fetchone()[0] if n in t else 0) for n in ['prompts','images','videos']}})); c.close()"
    )
    code, out, _ = run(["docker", "exec", container, "python3", "-c", code], timeout=20)
    if code != 0:
        return None
    try:
        value = json.loads(out)
        return value if isinstance(value, dict) else None
    except Exception:
        return None

info = docker_inspect(container)
if info is None:
    report = {"ok": False, "unknown": "容器不存在或 docker inspect 失败", "container": container}
else:
    env = {}
    for item in info.get("Config", {}).get("Env", []) or []:
        if "=" in item:
            name, value = item.split("=", 1)
            if name.startswith("OIP_") or name in {"ENABLE_MODEL_CALLS", "NODE_ENV"}:
                env[name] = redact(name, value)
    config = info.get("Config", {})
    state = info.get("State", {})
    health = state.get("Health") or {}
    image_ref = config.get("Image")
    image = None
    if image_ref:
        code, image_out, _ = run(["docker", "image", "inspect", image_ref])
        if code == 0:
            try:
                image = json.loads(image_out)[0]
            except Exception:
                image = None
    ports = {}
    for key, values in (info.get("NetworkSettings", {}).get("Ports", {}) or {}).items():
        ports[key] = [{"host_ip": item.get("HostIp"), "host_port": item.get("HostPort")} for item in (values or [])]
    host_ports = {}
    for container_port, values in ports.items():
        if values:
            try:
                host_ports[container_port.split("/")[0]] = int(values[0]["host_port"])
            except (TypeError, ValueError):
                pass
    web = host_ports.get("4173", 4173)
    image_api = host_ports.get("4175", 4175)
    archive_api = host_ports.get("4176", 4176)
    admin = host_ports.get("4184", 4184)
    public_origin = env.get("OIP_PUBLIC_ORIGIN")

    data_source = "/opt/miaoimg/.oip/runtime-data"
    for mount in info.get("Mounts", []) or []:
        if mount.get("Destination") == "/app/data":
            data_source = mount.get("Source") or data_source
    db_path = Path(data_source) / "management.sqlite"
    db = db_open(db_path)
    if db is not None:
        db.row_factory = sqlite3.Row

    counts = {"users": None, "active_users": None, "disabled_users": None, "points_total": None,
              "orders_by_status": [], "generations_by_status": [], "workspace_files": None,
              "upstream_calls": {"rows": None, "cost_rmb": None, "cost_source": None},
              "generation_upstream_cost_rmb": None}
    balances = {"checked": None, "matching": None, "mismatches": [], "stored_total": None, "ledger_total": None}
    layout = {"projects_table": None, "workspace_project_id": None, "workspace_blob": None,
              "media_layout_table": None, "media_layout": None, "conclusion": "未知"}
    if db is not None:
        counts["users"] = scalar(db, "SELECT COUNT(*) FROM users") if table_exists(db, "users") else None
        counts["active_users"] = scalar(db, "SELECT COUNT(*) FROM users WHERE status='active'") if table_exists(db, "users") else None
        counts["disabled_users"] = scalar(db, "SELECT COUNT(*) FROM users WHERE status<>'active'") if table_exists(db, "users") else None
        counts["points_total"] = scalar(db, "SELECT COALESCE(SUM(points),0) FROM users") if table_exists(db, "users") else None
        if table_exists(db, "payment_orders"):
            counts["orders_by_status"] = rows(db, "SELECT status,COUNT(*) AS rows FROM payment_orders GROUP BY status ORDER BY status")
        if table_exists(db, "generations"):
            counts["generations_by_status"] = rows(db, "SELECT status,COUNT(*) AS rows FROM generations GROUP BY status ORDER BY status")
        counts["workspace_files"] = scalar(db, "SELECT COUNT(*) FROM workspace_files") if table_exists(db, "workspace_files") else None
        if table_exists(db, "upstream_calls"):
            cols = table_columns(db, "upstream_calls")
            if "upstream_cost" in cols:
                cost_sql = "SELECT COUNT(*) AS rows, COALESCE(SUM(json_extract(upstream_cost,'$.rmb')),0) AS cost FROM upstream_calls"
                source = "upstream_calls.upstream_cost JSON via json_extract"
            elif "cost_rmb" in cols:
                cost_sql = "SELECT COUNT(*) AS rows, COALESCE(SUM(cost_rmb),0) AS cost FROM upstream_calls"
                source = "upstream_calls.cost_rmb REAL（当前生产 schema）"
            else:
                cost_sql = "SELECT COUNT(*) AS rows, NULL AS cost FROM upstream_calls"
                source = "未知：upstream_calls 没有成本列"
            row = db.execute(cost_sql).fetchone()
            counts["upstream_calls"] = {"rows": row[0], "cost_rmb": row[1], "cost_source": source}
        if table_exists(db, "generations") and "upstream_cost" in table_columns(db, "generations"):
            counts["generation_upstream_cost_rmb"] = scalar(db, "SELECT COALESCE(SUM(CASE WHEN upstream_cost IS NOT NULL THEN json_extract(upstream_cost,'$.rmb') ELSE 0 END),0) FROM generations")
        if table_exists(db, "users") and table_exists(db, "ledger"):
            mismatch_rows = rows(db, """WITH l AS (SELECT user_id,COALESCE(SUM(delta),0) AS ledger FROM ledger GROUP BY user_id)
                SELECT u.id,u.name,u.email,ROUND(u.points,4) AS stored_points,
                       ROUND(COALESCE(l.ledger,0),4) AS ledger_points,
                       ROUND(u.points-COALESCE(l.ledger,0),4) AS difference
                FROM users u LEFT JOIN l ON l.user_id=u.id
                WHERE ABS(u.points-COALESCE(l.ledger,0))>0.0001
                ORDER BY ABS(u.points-COALESCE(l.ledger,0)) DESC""")
            all_rows = rows(db, """SELECT u.points AS stored_points,COALESCE(SUM(l.delta),0) AS ledger_points
                FROM users u LEFT JOIN ledger l ON l.user_id=u.id GROUP BY u.id,u.points""")
            balances = {"checked": len(all_rows), "matching": len(all_rows) - len(mismatch_rows),
                        "mismatches": mismatch_rows,
                        "stored_total": sum(float(row["stored_points"] or 0) for row in all_rows),
                        "ledger_total": sum(float(row["ledger_points"] or 0) for row in all_rows)}
        layout["projects_table"] = table_exists(db, "projects")
        ws_cols = table_columns(db, "workspace_files")
        layout["workspace_project_id"] = "project_id" in ws_cols
        layout["workspace_blob"] = "blob" in ws_cols
        layout["media_layout_table"] = table_exists(db, "media_layout")
        layout["media_layout"] = scalar(db, "SELECT layout FROM media_layout WHERE id=1") if layout["media_layout_table"] else None
        if layout["projects_table"] and layout["workspace_project_id"] and layout["workspace_blob"] and layout["media_layout_table"]:
            layout["conclusion"] = "新布局：多项目 + 内容寻址（media_layout=%s）" % (layout["media_layout"] or "未知")
        elif not layout["projects_table"] and not layout["workspace_project_id"] and not layout["workspace_blob"] and not layout["media_layout_table"]:
            layout["conclusion"] = "老布局：单项目路径媒体，尚未进入项目/内容寻址迁移"
        else:
            layout["conclusion"] = "半迁移或结构不完整：不要自行运行存量迁移，先人工核对"
        db.close()

    media_root = "/opt/miaoimg/media"
    image_root = "/opt/miaoimg/images"
    preview_root = "/opt/miaoimg/previews"
    snapshot_root = "/opt/miaoimg/backups/media"
    snapshot_status_path = Path(data_source) / "ops-status" / "media-snapshot.json"
    sync_status_path = Path(data_source) / "sync-status.json"
    snapshot_status = {}
    sync_status = {}
    for path, target in [(snapshot_status_path, snapshot_status), (sync_status_path, sync_status)]:
        try:
            target.update(json.loads(path.read_text(encoding="utf-8")))
        except Exception:
            pass
    if snapshot_status.get("snapshotRoot"):
        snapshot_root = snapshot_status["snapshotRoot"]
    snapshots = []
    try:
        snapshots = sorted([path.name for path in Path(snapshot_root).iterdir() if path.is_dir()], reverse=True)
    except OSError:
        pass
    media = {"media": file_stats(media_root), "images": file_stats(image_root), "previews": file_stats(preview_root)}
    try:
        disk = shutil.disk_usage("/opt/miaoimg")
        disk_report = {"total_bytes": disk.total, "used_bytes": disk.used, "free_bytes": disk.free,
                       "free_percent": round(disk.free / disk.total * 100, 2) if disk.total else None}
    except OSError:
        disk_report = {"total_bytes": None, "used_bytes": None, "free_bytes": None, "free_percent": None}

    checks = {
        "public_origin": {path: http_code(f"{public_origin.rstrip('/')}{path}") for path in ["/", "/manage", "/api/catalog"]} if public_origin else {},
        "loopback": {
            "web": {"port": web, "paths": service_probe(web, ["/", "/manage", "/api/catalog", "/api/prompts", "/api/admin/session"])},
            "image_api": {"port": image_api, "paths": service_probe(image_api, ["/health", "/api/imagine/config", "/api/agent/health", "/api/ai/health", "/api/ext/health", "/api/mcp/health", "/api/nodes/health", "/api/ffmpeg/health", "/mcp"])},
            "archive_api": {"port": archive_api, "paths": service_probe(archive_api, ["/health", "/api/catalog", "/api/prompts"])},
            "admin_api": {"port": admin, "paths": service_probe(admin, ["/health", "/api/admin/session"])},
        },
    }
    report = {
        "ok": True,
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "server": {"hostname": os.uname().nodename, "utc_now": datetime.now(timezone.utc).isoformat()},
        "release": {"container": container, "image": image_ref, "image_id": (image or {}).get("Id"),
                    "image_created": (image or {}).get("Created"), "container_created": info.get("Created"),
                    "container_started": state.get("StartedAt"), "status": state.get("Status"),
                    "health": health.get("Status", "unknown"), "health_failing_streak": health.get("FailingStreak"),
                    "ports": ports, "mounts": [{"source": item.get("Source"), "destination": item.get("Destination"), "read_only": not item.get("RW", True)} for item in info.get("Mounts", []) or []],
                    "env": env},
        "services": {"http": checks, "container_healthcheck": {"status": health.get("Status", "unknown"),
                       "log_entries": len(health.get("Log", []) or [])}},
        "data": counts,
        "migration": layout,
        "media": {**media, "disk": disk_report, "snapshot": {"root": snapshot_root, "files": snapshots,
                    "count": len(snapshots), "latest": snapshots[0] if snapshots else None,
                    "status": snapshot_status or None,
                    "timer": timer("miaoimg-media-snapshot.timer")}},
        "dataset_sync": {"status": sync_status or None, "timer": timer("miaoimg-sync.timer"),
                         "database": {"path": "/opt/miaoimg/.oip/runtime/prompts.db", "prompts": None, "images": None, "videos": None}},
        "recent_errors": recent_errors(),
        "balance_invariant": balances,
    }
    live_dataset = container_dataset_counts()
    if live_dataset:
        report["dataset_sync"]["database"] = live_dataset
    for dataset_path in [Path("/opt/miaoimg/.oip/runtime/prompts.db"), Path("/opt/miaoimg/db/prompts.db")]:
        if live_dataset:
            break
        dataset = db_open(dataset_path)
        if dataset is None:
            continue
        report["dataset_sync"]["database"]["path"] = str(dataset_path)
        for name in ["prompts", "images", "videos"]:
            report["dataset_sync"]["database"][name] = scalar(dataset, f"SELECT COUNT(*) FROM {name}") if table_exists(dataset, name) else 0
        dataset.close()
        break

if output == "json":
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
else:
    def value(item):
        if item is None: return "未知"
        if isinstance(item, bool): return "是" if item else "否"
        if isinstance(item, (dict, list)): return json.dumps(item, ensure_ascii=False, separators=(",", ":"))
        return str(item)
    print("=== 这一版是什么 ===")
    if not report.get("ok"):
        print(f"容器                 : {report.get('container', container)}")
        print(f"状态                 : {report.get('unknown', '未知')}")
        raise SystemExit(1)
    rel = report["release"]
    for key, label in [("image", "镜像 tag"), ("image_created", "镜像创建时间"), ("container_created", "容器创建时间"),
                       ("container_started", "容器启动时间"), ("status", "容器状态"), ("health", "HEALTHCHECK 状态")]:
        print(f"{label:<20}: {value(rel.get(key))}")
    print("OIP_* / 关键环境变量:")
    for key, item in sorted(rel.get("env", {}).items()): print(f"  {key:<26}= {value(item)}")
    print("\n=== 服务是否真的活着 ===")
    print(f"容器 HEALTHCHECK      : {value(report['services']['container_healthcheck'])}")
    for scope, item in report["services"]["http"].get("loopback", {}).items():
        print(f"{scope} (127.0.0.1:{item['port']})")
        for path, code in item["paths"].items(): print(f"  {path:<28} {value(code)}")
    if report["services"]["http"].get("public_origin"):
        print("public origin")
        for path, code in report["services"]["http"]["public_origin"].items(): print(f"  {path:<28} {value(code)}")
    print("\n=== 数据现状 ===")
    data = report["data"]
    for key, label in [("users", "账号总数"), ("active_users", "启用账号"), ("disabled_users", "停用账号"),
                       ("points_total", "积分合计"), ("workspace_files", "workspace_files 行数")]: print(f"{label:<20}: {value(data.get(key))}")
    print(f"订单按状态           : {value(data.get('orders_by_status'))}")
    print(f"生成按状态           : {value(data.get('generations_by_status'))}")
    print(f"upstream_calls       : {value(data.get('upstream_calls'))}")
    print(f"generations.upstream_cost JSON 合计: {value(data.get('generation_upstream_cost_rmb'))} RMB")
    print("\n=== 迁移状态 ===")
    for key, label in [("projects_table", "projects 表"), ("workspace_project_id", "workspace_files.project_id"),
                       ("workspace_blob", "workspace_files.blob"), ("media_layout_table", "media_layout 表"),
                       ("media_layout", "media_layout.layout"), ("conclusion", "结论")]: print(f"{label:<28}: {value(report['migration'].get(key))}")
    print("\n=== 媒体与磁盘 ===")
    for key, label in [("media", "media"), ("images", "images"), ("previews", "previews")]: print(f"{label:<20}: {value(report['media'][key])}")
    print(f"磁盘                 : {value(report['media']['disk'])}")
    snap = report["media"]["snapshot"]
    print(f"最近媒体快照         : {value(snap.get('latest'))}，份数 {value(snap.get('count'))}")
    print(f"快照定时器           : {value(snap.get('timer'))}")
    print("\n=== 数据集同步 ===")
    print(f"定时器               : {value(report['dataset_sync']['timer'])}")
    print(f"最近运行结果         : {value(report['dataset_sync']['status'])}")
    print(f"库行数               : {value(report['dataset_sync']['database'])}")
    print("\n=== 最近异常（容器日志最近 24h，去重） ===")
    errors = report["recent_errors"]
    print(f"唯一报错条数         : {value(errors.get('unique'))}")
    for item in errors.get("items", []): print(f"  [{item['count']} 次] {item['line']}")
    if not errors.get("items") and errors.get("unique") == 0: print("  无匹配报错")
    print("\n=== 余额不变量 ===")
    balance = report["balance_invariant"]
    print(f"每个账号余额 == 账本累计: {'成立' if balance.get('checked') is not None and not balance.get('mismatches') else '不成立或未知'}")
    print(f"检查账号             : {value(balance.get('checked'))}，一致 {value(balance.get('matching'))}")
    print(f"余额合计 / 账本合计  : {value(balance.get('stored_total'))} / {value(balance.get('ledger_total'))}")
    for item in balance.get("mismatches", []): print(f"  {value(item)}")
PY
chmod +x deploy/inspect.sh
bash -n deploy/inspect.sh
