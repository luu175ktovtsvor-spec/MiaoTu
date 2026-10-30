# 妙图官网与管理后台

React + Vite 工程：官网首页、更新日志与管理后台（admin.miaoimg.cn）。网页版灵感库与画布已下线，灵感库数据只经下面的档案 API 供桌面版读取。

在仓库根目录运行：

```bash
npm run setup:web
npm run dev:web
```

The first run expands `../db/prompts.db.gz` once under the ignored
`.oip/runtime/` directory. The cross-platform Node launcher finds Python,
starts the read-only SQLite archive API, and then starts Vite, which also
serves the fetched images from `../images/`.

Useful environment variables:

- `OIP_DB_PATH`: decompressed SQLite path.
- `OIP_DB_ARCHIVE_PATH`: source `.db.gz` path.
- `OIP_WEB_HOST`: frontend bind address (default `127.0.0.1`).
- `OIP_WEB_PORT`: frontend port. When set, the port is strict: a collision fails
  loudly instead of moving to another port. When unset, Vite picks the next free
  port starting at `5173` and prints the URL it actually serves.
- `OIP_STARTUP_TIMEOUT`: seconds to wait for the SQLite API to report ready
  (default `180`). The first start expands the archive into a ~270 MB database,
  which can exceed a short budget on a constrained machine.
- `OIP_API_HOST`: API bind address (default `127.0.0.1`).
- `OIP_API_PORT`: API port (default `8787`).
- `OIP_API_QUERY_CONCURRENCY`: maximum concurrent SQLite page/search queries
  (default `4`).
- `OIP_API_QUERY_WAIT_SECONDS`: how long a request waits for a query slot before
  receiving `503` (default `3`).
- `OIP_API_CACHE_ENTRIES`: maximum in-memory paginated response cache entries
  (default `128`).

Search uses the archive's SQLite FTS5 index across source prompts,
translations, authors, tools, and visual labels. The API bounds concurrent
queries and keeps a small LRU response cache so one busy search cannot create
an unbounded number of SQLite scans.

`npm run preview` builds the frontend and runs the production preview with the
same local API and image service on Windows, macOS, and Linux.
