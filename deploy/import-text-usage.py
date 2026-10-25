#!/usr/bin/env python3
"""Import gateway text receipts without attributing users or changing balances."""
import argparse
import json
import pathlib
import re
import sqlite3
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--database', required=True)
parser.add_argument('--gateway-container', required=True)
parser.add_argument('--key-channel', action='append', required=True, help='Gateway API key ID=channel ID')
args = parser.parse_args()
routes = []
for value in args.key_channel:
    match = re.fullmatch(r'([1-9][0-9]*)=([A-Za-z0-9_.-]+)', value)
    if not match:
        parser.error('Invalid key-channel mapping')
    routes.append((int(match[1]), match[2]))
path = pathlib.Path(args.database).resolve(strict=True)
sql = """SET TIME ZONE 'UTC';
SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM (
 SELECT id::text AS id, model, input_tokens+cache_read_tokens+cache_creation_tokens AS input_tokens,
 output_tokens,cache_read_tokens,cache_creation_tokens AS cache_write_tokens,
 actual_cost AS gateway_cost_usd,request_id,session_id,upstream_request_id,account_id,
 CASE %s END AS channel,
 duration_ms,first_token_ms,to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
 FROM usage_logs WHERE (%s) AND COALESCE(image_count,0)=0 AND COALESCE(video_count,0)=0
 ORDER BY id
) t;""" % (' '.join("WHEN api_key_id=%d THEN '%s'" % route for route in routes), ' OR '.join('api_key_id=%d' % route[0] for route in routes))
result = subprocess.run(['docker','exec','-i',args.gateway_container,'sh','-c',
                         'exec psql -XAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],
                        input=sql,text=True,check=True,capture_output=True)
rows = json.loads(result.stdout.strip().splitlines()[-1])
columns = ['id','model','input_tokens','output_tokens','cache_read_tokens','cache_write_tokens',
           'gateway_cost_usd','request_id','session_id','upstream_request_id','account_id','channel',
           'duration_ms','first_token_ms','created_at']
with sqlite3.connect(path, timeout=30) as db:
    before = db.total_changes
    db.executemany('INSERT INTO text_upstream_usage ('+','.join(columns)+') VALUES ('+','.join('?' for _ in columns)+') ON CONFLICT(id) DO UPDATE SET '+','.join(c+'=excluded.'+c for c in columns[1:]),
                   [[row.get(column) for column in columns] for row in rows])
    total = db.execute('SELECT COUNT(*) FROM text_upstream_usage').fetchone()[0]
print(json.dumps({'gatewayReceipts':len(rows),'storedReceipts':total,'balanceChanges':0}))
