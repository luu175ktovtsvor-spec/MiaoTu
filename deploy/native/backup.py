#!/usr/bin/env python3
"""Atomically replace the latest consistent native account-database snapshot."""
import argparse
import fcntl
import gzip
import json
import os
import shutil
import sqlite3
import tempfile
import subprocess
from postgres_runtime import configured_database, postgres_environment
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', type=Path, default=Path('/opt/miaoimg/.oip/runtime-data/management.sqlite'))
    parser.add_argument('--output', type=Path)
    parser.add_argument('--lock-file', type=Path, default=Path('/run/lock/miaoimg-deploy.lock'))
    args = parser.parse_args()
    uri = configured_database('/etc/miaoimg/main.env')
    args.output = args.output or Path('/opt/miaoimg/backups/management-native-latest.pgdump' if uri else '/opt/miaoimg/backups/management-native-latest.sqlite.gz')
    if uri:
        return backup_postgres(uri, args.output, args.lock_file)
    if not args.db.is_file() or not args.db.stat().st_size:
        raise SystemExit('Source database missing; refusing to create an empty backup')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with open(args.lock_file, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with tempfile.TemporaryDirectory(prefix='.native-backup-', dir=args.output.parent) as temporary:
            snapshot = Path(temporary) / 'management.sqlite'
            with sqlite3.connect(args.db.resolve().as_uri() + '?mode=ro', uri=True) as source, sqlite3.connect(snapshot) as target:
                source.backup(target)
                if target.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise RuntimeError('Database snapshot integrity check failed')
                users = target.execute('SELECT COUNT(*) FROM users').fetchone()[0]
            snapshot.chmod(0o600)
            compressed = Path(temporary) / 'management.sqlite.gz'
            with snapshot.open('rb') as source, compressed.open('wb') as raw:
                with gzip.GzipFile(fileobj=raw, mode='wb', compresslevel=6) as target:
                    shutil.copyfileobj(source, target)
                raw.flush()
                os.fsync(raw.fileno())
            compressed.chmod(0o600)
            os.replace(compressed, args.output)
            descriptor = os.open(args.output.parent, os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    print(json.dumps({'backup': str(args.output), 'integrity': 'ok', 'users': users}))


def backup_postgres(uri, output, lock_file):
    if output.suffix != '.pgdump':
        raise ValueError('PostgreSQL backups must use a .pgdump filename')
    env = postgres_environment(uri)
    if not shutil.which('pg_dump') or not shutil.which('pg_restore'):
        raise RuntimeError('Matching PostgreSQL client tools are required')
    output.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_file, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with tempfile.TemporaryDirectory(prefix='.postgres-backup-', dir=output.parent) as temporary:
            snapshot = Path(temporary) / 'management.pgdump'
            for command in [
                ['pg_dump','--format=custom','--no-owner','--no-privileges','--lock-wait-timeout=5000','--file',str(snapshot)],
                ['pg_restore','--no-owner','--no-privileges','--file',os.devnull,str(snapshot)],
            ]:
                result = subprocess.run(command, env=env, capture_output=True, timeout=300, check=False)
                if result.returncode:
                    raise RuntimeError('PostgreSQL backup validation failed; previous backup retained')
            listing = subprocess.run(['pg_restore','--list',str(snapshot)], env=env, text=True, capture_output=True, check=True, timeout=30).stdout
            if not all('TABLE DATA public '+table+' ' in listing for table in ('users','ledger','generations','payment_orders')):
                raise RuntimeError('Required business tables missing from PostgreSQL backup')
            snapshot.chmod(0o600)
            with snapshot.open('rb') as source:
                os.fsync(source.fileno())
            size = snapshot.stat().st_size
            if not size:
                raise RuntimeError('Empty PostgreSQL backup refused')
            os.replace(snapshot,output)
            descriptor = os.open(output.parent,os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    print(json.dumps({'backup':str(output),'backend':'postgres','archive':'validated','bytes':size}))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        import sys
        print(json.dumps({'backup':'failed','error_type':type(exc).__name__,'previousBackupRetained':True}),file=sys.stderr)
        raise SystemExit(1)
