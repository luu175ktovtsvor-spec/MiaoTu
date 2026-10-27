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
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', type=Path, default=Path('/opt/miaoimg/.oip/runtime-data/management.sqlite'))
    parser.add_argument('--output', type=Path, default=Path('/opt/miaoimg/backups/management-native-latest.sqlite.gz'))
    args = parser.parse_args()
    if not args.db.is_file() or not args.db.stat().st_size:
        raise SystemExit('Source database missing; refusing to create an empty backup')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with open('/run/lock/miaoimg-deploy.lock', 'a') as lock:
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


if __name__ == '__main__':
    main()
