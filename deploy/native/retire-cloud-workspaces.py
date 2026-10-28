#!/usr/bin/env python3
"""Retire explicitly abandoned web workspaces without touching desktop transit or billing."""
import argparse
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--db', type=Path, required=True)
parser.add_argument('--apply', action='store_true')
args = parser.parse_args()
with sqlite3.connect(args.db.resolve().as_uri() + ('?mode=rw' if args.apply else '?mode=ro'), uri=True, timeout=15) as db:
    db.execute('PRAGMA busy_timeout=15000')
    if args.apply:
        db.execute('BEGIN IMMEDIATE')
    if db.execute("SELECT COUNT(*) FROM generations WHERE status IN ('queued','running')").fetchone()[0]:
        raise SystemExit('Active generation tasks exist; workspace retirement stopped')

    def financial_state():
        return {table: list(db.execute(sql)) for table, sql in {
            'users': 'SELECT id,points FROM users ORDER BY id',
            'ledger': 'SELECT COUNT(*),COALESCE(SUM(delta),0) FROM ledger',
            'orders': 'SELECT COUNT(*) FROM payment_orders',
            'generations': 'SELECT status,COUNT(*) FROM generations GROUP BY status ORDER BY status',
        }.items()}

    before = financial_state()
    candidates = db.execute('''SELECT COUNT(*),COALESCE(SUM(size),0) FROM workspace_files w
      WHERE NOT EXISTS (SELECT 1 FROM desktop_media_outputs o WHERE o.user_id=w.user_id AND o.path=w.path)
      AND NOT EXISTS (SELECT 1 FROM desktop_media_references r WHERE r.user_id=w.user_id AND r.path=w.path)''').fetchone()
    result = {'apply': args.apply, 'retiredWorkspaceRows': candidates[0], 'indexedBytes': candidates[1],
              'protectedDesktopOutputs': db.execute('SELECT COUNT(*) FROM desktop_media_outputs').fetchone()[0],
              'protectedDesktopReferences': db.execute('SELECT COUNT(*) FROM desktop_media_references').fetchone()[0],
              'workspaceStates': db.execute('SELECT COUNT(*) FROM workspace_state').fetchone()[0]}
    if args.apply:
        db.execute('''DELETE FROM workspace_files WHERE rowid IN (
          SELECT w.rowid FROM workspace_files w
          WHERE NOT EXISTS (SELECT 1 FROM desktop_media_outputs o WHERE o.user_id=w.user_id AND o.path=w.path)
          AND NOT EXISTS (SELECT 1 FROM desktop_media_references r WHERE r.user_id=w.user_id AND r.path=w.path))''')
        db.execute('DELETE FROM workspace_state')
        at = datetime.now(timezone.utc).isoformat()
        db.execute("UPDATE generations SET parameters=json_set(json_remove(parameters,'$.outputDirectory'),'$.cloudWorkspaceRetiredAt',?) WHERE COALESCE(json_extract(parameters,'$.desktopDelivery'),0)<>1", (at,))
        db.execute("UPDATE video_results SET video_url='',thumbnail_url='',metadata=json_remove(metadata,'$.workspacePath','$.upstreamUrl','$.raw') WHERE generation_id IN (SELECT id FROM generations WHERE COALESCE(json_extract(parameters,'$.desktopDelivery'),0)<>1)")
        if before != financial_state():
            raise RuntimeError('Financial/history invariant changed; transaction rolled back')
        if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise RuntimeError('Database integrity check failed; transaction rolled back')
        db.commit()
    result['financialHistoryUnchanged'] = before == financial_state()
    print(json.dumps(result, ensure_ascii=False))
