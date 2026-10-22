#!/bin/sh
set -eu

mkdir -p /app/data /app/.oip "${OIP_MEDIA_ROOT:-/app/media}"
chown -R node:node /app/data /app/.oip
# 媒体目录只改顶层：里面的文件都是 node 进程自己写的，属主本来就对；
# 递归 chown 会随素材数量增长拖慢每一次容器启动。
chown node:node "${OIP_MEDIA_ROOT:-/app/media}"

if [ "$#" -eq 5 ] && [ "$1" = "npm" ] && [ "$2" = "--prefix" ] && [ "$3" = "web" ] && [ "$4" = "run" ] && [ "$5" = "preview" ]; then
  set -- node /app/web/scripts/with_api.ts preview
fi

# Keep the supervisor as PID 1 so Docker's stop signal and grace period reach
# the process that joins the API children. Preserve each argument verbatim.
# Match the account environment previously set by su, including when deployment
# carries an older container's explicit environment into the new image.
export HOME=/home/node USER=node LOGNAME=node SHELL=/bin/sh
exec setpriv --reuid=node --regid=node --init-groups -- "$@"
