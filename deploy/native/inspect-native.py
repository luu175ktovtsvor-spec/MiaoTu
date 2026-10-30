#!/usr/bin/env python3
"""Read-only native service inspection; never emits credential values."""
import argparse
import json
import os
from urllib.parse import urlsplit, unquote
from postgres_runtime import configured_database, configured_value, postgres_environment
import re
import shutil
import sqlite3
import subprocess
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


def service(unit):
    result = subprocess.run(
        ["systemctl", "show", unit, "-p", "ActiveState", "-p", "SubState",
         "-p", "MainPID", "-p", "MemoryCurrent", "-p", "ExecMainStatus"],
        text=True, capture_output=True, check=False, timeout=10,
    )
    values = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    pid = int(values.get("MainPID", "0") or "0")
    try:
        values["actual_working_directory"] = str(Path(f"/proc/{pid}/cwd").resolve(strict=True)) if pid else None
    except OSError:
        values["actual_working_directory"] = None
    return values


def http(path, port):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(f"http://127.0.0.1:{port}{path}", timeout=5) as response:
            return response.status
    except urllib.error.HTTPError as exc:
        return exc.code
    except (OSError, urllib.error.URLError):
        return None


def database(path):
    if not path.is_file():
        return {"path": str(path), "available": False}
    with sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=5) as db:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        counts = {table: db.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
                  for table in ["users", "ledger", "generations", "payment_orders", "workspace_files"] if table in tables}
        result = {"path": str(path), "available": True, "quick_check": db.execute("PRAGMA quick_check").fetchone()[0], "counts": counts}
        if "generations" in tables:
            result["tasks"] = dict(db.execute("SELECT status,COUNT(*) FROM generations GROUP BY status"))
        if {"users", "ledger"}.issubset(tables):
            result["balance_ledger_mismatches"] = db.execute(
                "SELECT COUNT(*) FROM (SELECT u.id FROM users u LEFT JOIN ledger l ON l.user_id=u.id "
                "GROUP BY u.id,u.points HAVING ABS(u.points-COALESCE(SUM(l.delta),0))>0.0001)"
            ).fetchone()[0]
        return result


def database_postgres(uri):
    env = postgres_environment(uri)
    env['PGOPTIONS'] = '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=2000'
    sql = """SELECT json_build_object(
      'backend','postgres','available',true,'query_check','ok',
      'counts',json_build_object('users',(SELECT COUNT(*) FROM users),'ledger',(SELECT COUNT(*) FROM ledger),
        'generations',(SELECT COUNT(*) FROM generations),'payment_orders',(SELECT COUNT(*) FROM payment_orders),
        'workspace_files',(SELECT COUNT(*) FROM workspace_files)),
      'tasks',(SELECT json_object_agg(status,n) FROM (SELECT status,COUNT(*) n FROM generations GROUP BY status) states),
      'balance_ledger_mismatches',(SELECT COUNT(*) FROM (SELECT u.id FROM users u LEFT JOIN ledger l ON l.user_id=u.id
        GROUP BY u.id,u.points HAVING ABS(u.points-COALESCE(SUM(l.delta),0))>0.0001) mismatches))"""
    result = subprocess.run(['psql','-X','-A','-t','-v','ON_ERROR_STOP=1','-c',sql],env=env,text=True,capture_output=True,timeout=15,check=False)
    if result.returncode:
        return {'backend':'postgres','available':False,'error_type':'QueryFailed'}
    return json.loads(result.stdout)


def redis_readiness(uri):
    parsed = urlsplit(uri)
    if parsed.scheme not in ('redis','rediss') or not parsed.hostname:
        return {'available':False}
    env = {key:os.environ[key] for key in ('PATH','LANG') if key in os.environ}
    env['REDISCLI_AUTH'] = unquote(parsed.password or '')
    command = ['redis-cli','--raw','--no-auth-warning','-h',parsed.hostname,'-p',str(parsed.port or 6379)]
    if parsed.username:
        command += ['--user',unquote(parsed.username)]
    if parsed.scheme == 'rediss':
        command += ['--tls']
    if parsed.path.strip('/'):
        index = parsed.path.strip('/')
        if not index.isdigit():
            return {'available':False}
        command += ['-n',index]
    result = subprocess.run(command+['PING'],env=env,text=True,capture_output=True,timeout=5,check=False)
    return {'available':result.returncode==0 and result.stdout.strip()=='PONG'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--unit", default="miaoimg.service")
    parser.add_argument("--db", type=Path, default=Path("/opt/miaoimg/.oip/runtime-data/management.sqlite"))
    parser.add_argument('--env-file',type=Path,default=Path('/etc/miaoimg/main.env'))
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_.@-]+\.service", args.unit):
        parser.error("invalid unit name")
    report = {"collected_at": datetime.now(timezone.utc).isoformat(), "unit": args.unit}
    report["service"] = service(args.unit)
    report["http"] = {str(port): {"health": http("/health", port)} for port in [4173, 4175, 4176, 4184]}
    report["http"]["4176"]["catalog"] = http("/api/catalog", 4176)
    report["http"]["4175"]["config"] = http("/api/imagine/config", 4175)
    report["http"]["4184"]["anonymous_session"] = http("/api/admin/session", 4184)
    try:
        uri = configured_database(args.env_file)
        report['database'] = database_postgres(uri) if uri else database(args.db)
        if uri:
            report['redis'] = redis_readiness(configured_value('MIAO_REDIS_URL',args.env_file))
    except (sqlite3.Error, OSError, ValueError, subprocess.SubprocessError) as exc:
        report["database"] = {"path": str(args.db), "available": False, "error_type": type(exc).__name__}
    disk = shutil.disk_usage("/opt/miaoimg")
    report["disk"] = {"total": disk.total, "used": disk.used, "free": disk.free}
    report["ok"] = (report["service"].get("ActiveState") == "active"
                    and all(value["health"] == 200 for value in report["http"].values())
                    and (report["database"].get("quick_check") == "ok" or report["database"].get("query_check") == "ok")
                    and report.get("redis",{"available":True}).get("available")
                    and report["database"].get("balance_ledger_mismatches") == 0)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
