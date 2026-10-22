#!/usr/bin/env bash
set -Eeuo pipefail

# Optional first-install helper. It does not inspect or copy secrets from a running
# server. The customer supplies the target host, env file and persistent data
# directory explicitly.

ROOT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
REMOTE_HOST=${REMOTE_HOST:?Set REMOTE_HOST to the customer's SSH host}
REMOTE_ENV_FILE=${REMOTE_ENV_FILE:?Set REMOTE_ENV_FILE to an env file already present on the target}
REMOTE_DATA_DIR=${REMOTE_DATA_DIR:-/opt/miaoimg/data}
REMOTE_CONTAINER=${REMOTE_CONTAINER:-miaoimg}
IMAGE_REF=${IMAGE_REF:-miaoimg:$(date +%Y%m%d-%H%M%S)}
TARGET_PLATFORM=${TARGET_PLATFORM:-linux/amd64}

cd "$ROOT_DIR"
SOURCE_REVISION=$(git rev-parse HEAD)
if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
  echo 'Commit source changes before delivery' >&2
  exit 2
fi
case "$REMOTE_CONTAINER" in ''|-*|*[!A-Za-z0-9_.-]*) echo 'Invalid container name' >&2; exit 2 ;; esac
case "$IMAGE_REF" in ''|-*|*[!A-Za-z0-9_./:@-]*) echo 'Invalid image reference' >&2; exit 2 ;; esac
case "$REMOTE_ENV_FILE$REMOTE_DATA_DIR" in *[!A-Za-z0-9_./-]*) echo 'Use absolute paths without shell metacharacters' >&2; exit 2 ;; esac
[[ "$REMOTE_ENV_FILE" = /* && "$REMOTE_DATA_DIR" = /* ]] || exit 2
# Refuse an update before spending time building/uploading. The second check
# closes the race with another installer; docker run also refuses name reuse.
ssh "$REMOTE_HOST" "if docker inspect '$REMOTE_CONTAINER' >/dev/null 2>&1; then echo 'Container already exists; use the rollback release process' >&2; exit 2; fi"
source_snapshot=$(mktemp -d "${TMPDIR:-/tmp}/miaoimg-delivery.XXXXXX")
trap 'rm -r -- "$source_snapshot"' EXIT
git archive "$SOURCE_REVISION" | tar -x -C "$source_snapshot"
docker buildx build --platform "$TARGET_PLATFORM" --label "org.opencontainers.image.revision=$SOURCE_REVISION" --tag "$IMAGE_REF" --load "$source_snapshot"
image_metadata=$(docker image inspect "$IMAGE_REF" --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}}')
read -r image_id image_revision <<< "$image_metadata"
if [ "$image_revision" != "$SOURCE_REVISION" ] || [[ ! "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo 'Built image does not identify the selected source commit' >&2
  exit 2
fi
docker save "$image_id" | ssh "$REMOTE_HOST" 'docker load'

ssh "$REMOTE_HOST" "IMAGE_ID='$image_id' SOURCE_REVISION='$SOURCE_REVISION' REMOTE_ENV_FILE='$REMOTE_ENV_FILE' REMOTE_DATA_DIR='$REMOTE_DATA_DIR' REMOTE_CONTAINER='$REMOTE_CONTAINER' bash -s" <<'REMOTE'
set -Eeuo pipefail
loaded_revision=$(docker image inspect "$IMAGE_ID" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
if [ "$loaded_revision" != "$SOURCE_REVISION" ]; then
  echo 'Loaded image does not match the selected source commit' >&2
  exit 2
fi
mkdir -p "$REMOTE_DATA_DIR"
if docker inspect "$REMOTE_CONTAINER" >/dev/null 2>&1; then
  echo 'Container already exists; use the rollback release process' >&2
  exit 2
fi
docker run --detach \
  --name "$REMOTE_CONTAINER" \
  --restart unless-stopped \
  --env-file "$REMOTE_ENV_FILE" \
  --publish 127.0.0.1:4173:4173 \
  --mount "type=bind,src=${REMOTE_DATA_DIR},dst=/app/data" \
  "$IMAGE_ID"
REMOTE

printf 'Published %s to %s\n' "$IMAGE_REF" "$REMOTE_HOST"
