FROM node:22-bookworm-slim AS node-runtime

FROM python:3.12-slim-bookworm AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Agent 的 probeMedia 工具依赖 ffprobe/ffmpeg 读取工作区媒体元信息。
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg util-linux \
    && rm -rf /var/lib/apt/lists/*

# Keep the application image self-contained without a build-time apt mirror.
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && groupadd --system --gid 1000 node \
    && useradd --uid 1000 --gid 1000 --create-home node

WORKDIR /app

FROM base AS verification

# 网页画布下线后，官网 + 管理后台的 vite build 只剩约 4.6k 个模块，几秒完成；
# 5120 的堆上限是旧网页画布时代留下的余量，保留不影响构建。
ENV NODE_OPTIONS=--max-old-space-size=5120

# The public deployment prefers pre-generated WebP previews, with the existing
# Nginx image-filter route as a fallback while a new preview is being prepared.
ENV VITE_OIP_THUMBNAIL_PREFIX=previews \
    VITE_OIP_THUMBNAIL_FALLBACK_PREFIX=thumbs \
    VITE_OIP_THUMBNAIL_FORMAT=webp

# 根依赖是服务端 Agent 运行时用的（与上游同款的 SDK，见 server/agent-runtime.ts）；
# web 依赖是前端的。两边都要装，少一边镜像里就会缺模块（服务端启动即失败）。
COPY package.json package-lock.json ./
COPY web/package.json web/package-lock.json ./web/
COPY web/runtime/package.json web/runtime/package-lock.json ./web/runtime/
RUN npm ci --omit=dev && npm --prefix web ci \
    && npm --prefix web/runtime ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

COPY . .

# 数据集与媒体属于服务器挂载，不重复下载、封装进每个应用镜像。
RUN npm run build:web

FROM base AS runtime

ENV NODE_ENV=production \
    HOME=/home/node \
    USER=node \
    LOGNAME=node \
    SHELL=/bin/sh \
    OIP_WEB_HOST=0.0.0.0 \
    OIP_WEB_PORT=4173 \
    OIP_ADMIN_HOST=0.0.0.0 \
    OIP_ADMIN_PORT=4184 \
    OIP_ADMIN_LOCAL_ONLY=true \
    OIP_DATA_DIR=/app/data

# 运行期只复制服务端、静态 bundle、词典和最小 Vite 预览依赖。
COPY --from=verification --chown=node:node /app/package*.json /app/
COPY --from=verification --chown=node:node /app/LICENSE /app/LICENSE
COPY --from=verification --chown=node:node /app/node_modules /app/node_modules
COPY --from=verification --chown=node:node /app/server /app/server
COPY --from=verification --chown=node:node /app/runtime /app/runtime
COPY --from=verification --chown=node:node /app/retrieval /app/retrieval
COPY --from=verification --chown=node:node /app/taxonomy /app/taxonomy
COPY --from=verification --chown=node:node /app/scripts /app/scripts
COPY --from=verification --chown=node:node /app/skills /app/skills
COPY --from=verification --chown=node:node /app/data /app/data
COPY --from=verification --chown=node:node /app/web/package.json /app/web/vite.config.ts /app/web/preview.config.ts /app/web/
COPY --from=verification --chown=node:node /app/web/scripts /app/web/scripts
COPY --from=verification --chown=node:node /app/web/dist /app/web/dist
COPY --from=verification --chown=node:node /app/web/runtime/node_modules /app/web/node_modules

COPY --chown=root:root docker-entrypoint.sh /usr/local/bin/miaoimg-entrypoint
RUN chmod 0755 /usr/local/bin/miaoimg-entrypoint

EXPOSE 4173
EXPOSE 4184

# 探 web 端口 + 部署指定的内层 API 端口：只探 web 会让「API 死了」被判成健康（2026-10-06 的 502 就是这么漏过去的）。
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "/app/scripts/container-health.ts"]

ENTRYPOINT ["/usr/local/bin/miaoimg-entrypoint"]
CMD ["node", "/app/web/scripts/with_api.ts", "preview"]

# Browser-only administration can be released independently of the public app.
FROM base AS admin-build
ENV NODE_OPTIONS=--max-old-space-size=5120
ENV VITE_OIP_THUMBNAIL_PREFIX=previews VITE_OIP_THUMBNAIL_FALLBACK_PREFIX=thumbs VITE_OIP_THUMBNAIL_FORMAT=webp
COPY package.json package-lock.json ./
COPY web/package.json web/package-lock.json ./web/
COPY web/runtime/package.json web/runtime/package-lock.json ./web/runtime/
RUN npm ci --omit=dev && npm --prefix web ci \
    && npm --prefix web/runtime ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force
COPY web/src/admin ./web/src/admin
COPY web/src/i18n.ts web/src/LangProvider.tsx web/src/LanguageControl.tsx web/src/shellLanguage.ts web/src/siteOrigins.ts ./web/src/
COPY web/admin.html web/admin.config.ts ./web/
RUN cd web && node node_modules/vite/bin/vite.js build --config admin.config.ts

FROM base AS admin-runtime
ENV NODE_ENV=production OIP_ADMIN_PORT=4184 OIP_ADMIN_LOCAL_ONLY=true OIP_ADMIN_WEB_PORT=4173 OIP_DATA_DIR=/app/data
COPY --from=admin-build --chown=node:node /app/package*.json /app/
COPY --chown=node:node LICENSE /app/LICENSE
COPY --from=admin-build --chown=node:node /app/node_modules /app/node_modules
COPY --from=admin-build --chown=node:node /app/web/admin-dist /app/admin-web
COPY --chown=node:node web/public/miaoimg-logo.png /app/admin-web/miaoimg-logo.png
COPY --chown=node:node server /app/server
COPY --chown=node:node scripts /app/scripts
USER node
EXPOSE 4173
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:4173/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","/app/server/admin-web.ts"]

# Keep the default image as the complete application; admin releases use --target admin-runtime.
FROM runtime AS application
