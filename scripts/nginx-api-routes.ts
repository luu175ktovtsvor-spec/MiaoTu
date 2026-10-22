#!/usr/bin/env node
// 从 web/vite.config.ts 的 preview.proxy 表生成 nginx 的 /api 路由块。
//
// 为什么要有这个脚本：nginx 上线站点配置里那张「哪个前缀归哪个内层端口」的表，
// 和 vite 的 dev/preview 代理表是同一套东西的两份抄写。2026-10-06 就因为手抄漏了
// 新加的 /api/plugins，`/api/plugins` 落到了档案 API 上、静默 404。vite 那份是
// 开发时天天在用、加新路由必然会跟着改的，所以以它为唯一来源，nginx 这份用脚本生成。
//
// 用法：node scripts/nginx-api-routes.ts   → 打印可直接粘进站点配置的 location 块。
// 端口固定值由部署脚本的 --env 决定（见 deploy/deploy-production.sh），这里必须一致。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { fileContentHeaders } from '../server/file-content-policy.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Static archive aliases bypass Node. Generate their HTTP-context map and
// location-context headers from the same file policy as the native byte relay.
if (process.argv.includes('--file-policy-map')) {
  process.stdout.write(`# Place inside http {}, before the site server blocks.\nmap $sent_http_content_type $miaoimg_file_policy {\n    default ${JSON.stringify(fileContentHeaders('')['content-security-policy'])};\n    ~*^(?:audio|video)/ ${JSON.stringify(fileContentHeaders('video/mp4')['content-security-policy'])};\n}\n`)
  process.exit(0)
}
if (process.argv.includes('--file-policy-headers')) {
  process.stdout.write(`# Only for archive/material locations, after installing the HTTP map.\nadd_header Content-Security-Policy $miaoimg_file_policy always;\nadd_header X-Content-Type-Options nosniff always;\n`)
  process.exit(0)
}
// 媒体内部 location 也集中生成；显式 --media 只输出这一块，避免默认 API 块粘贴时重复定义。
if (process.argv.includes('--media')) {
  process.stdout.write(`    # 本块由 node scripts/nginx-api-routes.ts --media 生成。
    location /__media_internal/ {
        internal;
        alias /opt/miaoimg/media/;
        # 工作区用原子 rename 更新字节，不能继承静态站点的旧文件描述符缓存。
        open_file_cache off;
        # ETag 与 Node 已确认的 revision 保持一致，避免 mtime+size 碰撞。
        etag off;
        add_header ETag $upstream_http_etag always;
        add_header x-workspace-revision $upstream_http_x_workspace_revision always;
        add_header X-Content-Type-Options $upstream_http_x_content_type_options always;
        add_header Content-Security-Policy $upstream_http_content_security_policy always;
    }
`)
  process.exit(0)
}
const PORTS = { IMAGE_API_PORT: 4175, API_PORT: 4176, ADMIN_API_PORT: 4184 }
// 需要单独成块的前缀：/api/imagine 要带媒体直出开关。
//
// /api/admin **故意不直连 4184**：管理端口带着 OIP_ADMIN_LOCAL_ONLY=true 的「只允许本机」
// 保护，它只监听容器内的 127.0.0.1，宿主机根本连不上（实测 4184 从宿主侧是 000）。
// 所以它保持 nginx → 4173（vite 预览）→ 4184，和砍跳之前逐字节一致。
// 注意**必须显式写出这条**：nginx 是「最长前缀优先」，不写的话 /api/admin 会落到 /api/
// 那条兜底上、被送进档案 API 变成 404（2026-10-06 第一次切换时就踩了，回头补的）。
const SPECIAL = { '/api/imagine': 'IMAGE_API_PORT', '/api/admin': null }

const config = readFileSync(resolve(ROOT, 'web/vite.config.ts'), 'utf8')
const start = config.indexOf('  preview: {')
if (start < 0) throw new Error('vite.config.ts 里找不到 preview 段')
const preview = config.slice(start, config.indexOf('\n  },', start))
const pairs = [...preview.matchAll(/'(?<path>\/[a-zA-Z0-9/_-]*)':\s*apiProxy\((?<port>[A-Z_]+)\)/g)]
  .map((match) => ({ path: match.groups.path, port: match.groups.port }))
if (!pairs.length) throw new Error('preview.proxy 表解析为空，检查 vite.config.ts 的写法是否变了')

const unknown = pairs.find((pair) => !PORTS[pair.port])
if (unknown) throw new Error(`未知的端口环境变量 ${unknown.port}（前缀 ${unknown.path}）：新增了目标端口就要同步本脚本的 PORTS`)

const byPort = (port) => pairs.filter((pair) => pair.port === port && !Object.hasOwn(SPECIAL, pair.path)).map((pair) => pair.path)
const imageRest = byPort('IMAGE_API_PORT')
const archive = byPort('API_PORT')

const proxyHeaders = (port) => `        proxy_http_version 1.1;
        proxy_set_header Host 127.0.0.1:${port};
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;`

// 精确匹配用 (/|$) 收尾：`/api/ext` 不该吃掉 `/api/extra` 这种同前缀的别的路径。
const alternation = (paths) => paths.map((path) => `${path}(/|$)`).join('|')
const regexPrefixes = imageRest.filter((path) => path.startsWith('/api/')).map((path) => path.slice('/api/'.length))
const barePrefixes = imageRest.filter((path) => !path.startsWith('/api/'))
const regex = `^/(api/(${regexPrefixes.join('|')})(/|$)|${barePrefixes.map((path) => path.slice(1)).join('|')}(/|$))`

process.stdout.write(`    # 本块由 scripts/nginx-api-routes.ts 从 web/vite.config.ts 生成，别手改。
    location ^~ /api/imagine {
        # 直出开关：Node 只做鉴权，字节由 nginx 发；注释掉本行即回到 Node 直发。
        proxy_set_header X-Miaoimg-Media-Accel 1;
        # 直出时 nginx 会用静态模块的响应头替换 Node 的，revision 必须显式带出来，
        # 否则前端读不到修订号，后续保存会被判成过期（409）。空值不会发这个头。
        gzip off;
        proxy_pass http://127.0.0.1:${PORTS.IMAGE_API_PORT};
${proxyHeaders(PORTS.IMAGE_API_PORT)}
    }

    # 管理后台：保持经 vite 预览转给容器内的 4184（它只绑容器内 loopback，宿主连不上）
    location ^~ /api/admin {
        gzip off;
        proxy_pass http://127.0.0.1:4173;
        proxy_http_version 1.1;
        proxy_set_header Host 127.0.0.1:4173;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    # 其余内层 API：${imageRest.filter((path) => path !== '/api/imagine').join('、')}
    location ~ ${regex} {
        gzip off;
        proxy_pass http://127.0.0.1:${PORTS.IMAGE_API_PORT};
${proxyHeaders(PORTS.IMAGE_API_PORT)}
    }

    # 兜底：档案 API（${archive.join('、')}）
    location /api/ {
        proxy_pass http://127.0.0.1:${PORTS.API_PORT};
${proxyHeaders(PORTS.API_PORT)}
    }

    location = /health {
        proxy_pass http://127.0.0.1:${PORTS.API_PORT};
${proxyHeaders(PORTS.API_PORT)}
        access_log off;
    }
`)
