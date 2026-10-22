#!/usr/bin/env python3
"""Synchronize the server with upstream database and image Release assets only."""
from __future__ import annotations

import fcntl
import gzip
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.request
import argparse
from datetime import datetime, timezone
from pathlib import Path


SOURCE_ROOT = Path(__file__).resolve().parents[1]
ROOT = Path(os.environ.get("OIP_REPO_ROOT", str(SOURCE_ROOT))).resolve()
def _container_name() -> str:
    """容器改名过渡：优先新名，未迁移时回落到旧名。"""
    configured = os.environ.get("OIP_CONTAINER")
    if configured:
        return configured
    for candidate in ("miaoimg", "open-image-prompts"):
        result = subprocess.run(["docker", "inspect", "-f", "{{.Name}}", candidate], capture_output=True, text=True)
        if result.returncode == 0:
            return candidate
    return "miaoimg"


CONTAINER = _container_name()
UPSTREAM_DATA = "https://raw.githubusercontent.com/NanmiCoder/open-image-prompts/main/data"
SYNC_ROOT = ROOT / ".oip" / "upstream-sync"
RUNTIME_DATA = ROOT / ".oip" / "runtime-data"
LOCK_PATH = ROOT / ".oip" / "upstream-sync.lock"
STATE_PATH = ROOT / ".oip" / "upstream-sync-state.json"
STATUS_PATH = RUNTIME_DATA / "sync-status.json"
OPS_STATUS_PATH = RUNTIME_DATA / "ops-status" / "dataset-sync.json"
DB_ARCHIVE = ROOT / "db" / "prompts.db.gz"
FETCH_SCRIPT = SOURCE_ROOT / "scripts" / "fetch_dataset.py"
PREVIEW_SCRIPT = SOURCE_ROOT / "deploy" / "generate_previews.py"
USER_AGENT = "miaoimg-release-sync/1.0"


def log(message: str) -> None:
    timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    print(f"[{timestamp}] {message}", flush=True)


def fetch_json(name: str) -> dict:
    request = urllib.request.Request(
        f"{UPSTREAM_DATA}/{name}?t={int(time.time())}",
        headers={"Accept": "application/json", "User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        return json.load(response)


def write_json_atomic(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def write_sync_status(value: dict) -> None:
    """Write the host-side status consumed by the read-only admin panel."""
    write_json_atomic(OPS_STATUS_PATH, {
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "command": "systemctl start miaoimg-sync.service",
        "timerUnit": "miaoimg-sync.timer",
        **value,
    })


def copy_atomic(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f"{destination.name}.{os.getpid()}.tmp")
    shutil.copy2(source, temporary)
    os.replace(temporary, destination)


def current_manifest() -> dict:
    runtime_manifest = RUNTIME_DATA / "dataset-manifest.json"
    source = runtime_manifest if runtime_manifest.is_file() else SOURCE_ROOT / "data" / "dataset-manifest.json"
    return json.loads(source.read_text(encoding="utf-8"))


def validate_metadata(manifest: dict, corpus: dict) -> None:
    if manifest.get("schema") != 1:
        raise RuntimeError(f"unsupported manifest schema: {manifest.get('schema')}")
    if corpus.get("dataset_version") != manifest.get("dataset_version"):
        raise RuntimeError("upstream manifest and public-corpus versions do not match")
    if corpus.get("counts") != manifest.get("db", {}).get("counts"):
        raise RuntimeError("upstream manifest and public-corpus counts do not match")


def inspect_database(archive: Path, expected_counts: dict | None = None, root: Path = ROOT) -> tuple[dict, int, int]:
    SYNC_ROOT.mkdir(parents=True, exist_ok=True)
    expanded = SYNC_ROOT / f"prompts-{os.getpid()}.db"
    expanded.unlink(missing_ok=True)
    try:
        with gzip.open(archive, "rb") as source, expanded.open("wb") as target:
            shutil.copyfileobj(source, target, length=1024 * 1024)
        connection = sqlite3.connect(expanded)
        try:
            result = connection.execute("PRAGMA integrity_check").fetchone()
            if not result or result[0] != "ok":
                raise RuntimeError("SQLite integrity_check failed")
            table_names = {
                "translations": "prompt_translations",
                "prompt_labels": "prompt_labels",
                "media_labels": "media_labels",
                "taxonomy_labels": "taxonomy_labels",
            }
            manifest_counts = expected_counts or {
                "prompts": 0, "images": 0, "translations": 0,
                "prompt_labels": 0, "media_labels": 0, "taxonomy_labels": 0,
            }
            available_tables = {
                row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
            counts = {}
            for key in manifest_counts:
                table_name = table_names.get(key, key)
                counts[key] = connection.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()[0] if table_name in available_tables else 0
            if expected_counts is not None and counts != expected_counts:
                raise RuntimeError(f"database counts differ from manifest: expected {expected_counts}, got {counts}")
            missing = 0
            unresolved = 0
            for local_path, url in connection.execute("SELECT local_path, url FROM images"):
                if (root / str(local_path)).is_file():
                    continue
                missing += 1
                if not str(url or "").strip():
                    unresolved += 1
        finally:
            connection.close()
        return counts, missing, unresolved
    finally:
        expanded.unlink(missing_ok=True)


def wait_for_health(expected_counts: dict) -> None:
    deadline = time.monotonic() + 150
    last_error = "not ready"
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen("http://127.0.0.1:4173/health", timeout=5) as response:
                health = json.load(response)
            with urllib.request.urlopen("http://127.0.0.1:4173/api/catalog", timeout=15) as response:
                stats = json.load(response).get("stats", {})
        except Exception as error:
            last_error = str(error)
        else:
            missing_counts = sorted(set(expected_counts) - set(stats))
            if missing_counts:
                raise RuntimeError(
                    "API stats missing manifest counts: "
                    + ", ".join(missing_counts)
                    + "; exposed keys: "
                    + ", ".join(sorted(stats))
                )
            if health.get("ok") and all(stats[key] == expected_counts[key] for key in expected_counts):
                return
            last_error = f"unexpected API counts: {stats}"
        time.sleep(2)
    raise RuntimeError(f"container health validation failed: {last_error}")


def restart_and_verify(expected_counts: dict) -> None:
    subprocess.run(["docker", "restart", CONTAINER], check=True, stdout=subprocess.DEVNULL)
    wait_for_health(expected_counts)


def generate_previews() -> None:
    subprocess.run([sys.executable, str(PREVIEW_SCRIPT)], cwd=ROOT, check=True)


def preview_count() -> int:
    """Count the real WebP files written under the host preview mount."""
    preview_root = ROOT / "previews"
    return sum(1 for path in preview_root.rglob("*.webp") if path.is_file()) if preview_root.is_dir() else 0


def restore_file(backup: Path, destination: Path) -> None:
    if backup.is_file():
        copy_atomic(backup, destination)


def dry_run(scratch_root: Path, assets_dir: Path | None = None) -> int:
    """Validate a release in an isolated checkout without Docker or production paths.

    The DB archive is downloaded and fully inspected. Image packs are deliberately
    not copied in this mode: they are multi-gigabyte optional media; instead we
    report the exact new pack entries and the DB rows that require new files.
    """
    scratch_root = scratch_root.resolve()
    scratch_root.mkdir(parents=True, exist_ok=True)
    scratch_runtime = scratch_root / ".oip" / "runtime-data"
    scratch_runtime.mkdir(parents=True, exist_ok=True)
    upstream_manifest = fetch_json("dataset-manifest.json")
    upstream_corpus = fetch_json("public-corpus.json")
    validate_metadata(upstream_manifest, upstream_corpus)
    staged_manifest = scratch_root / "dataset-manifest.json"
    write_json_atomic(staged_manifest, upstream_manifest)
    environment = {**os.environ, "OIP_DATASET_MANIFEST": str(staged_manifest)}
    # fetch_dataset.py resolves its repository from its own location. A scratch
    # run therefore uses a temporary copy of the script tree and never touches
    # this checkout's db/ or images/.
    scratch_repo = scratch_root / "repo"
    scratch_repo.mkdir(parents=True, exist_ok=True)
    fetch_copy = scratch_repo / "scripts" / "fetch_dataset.py"
    fetch_copy.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(FETCH_SCRIPT, fetch_copy)
    fetch_args = [sys.executable, str(fetch_copy), "--db-only"]
    if assets_dir is not None:
        fetch_args.extend(["--assets-dir", str(assets_dir.resolve())])
    subprocess.run(fetch_args, cwd=scratch_repo, env={**environment, "OIP_DATASET_MANIFEST": str(staged_manifest)}, check=True)
    scratch_archive = scratch_repo / "db" / "prompts.db.gz"
    counts, missing, unresolved = inspect_database(scratch_archive, upstream_manifest["db"]["counts"], scratch_repo)
    old_manifest = current_manifest()
    old_packs = {entry["asset"]: entry.get("sha256") for entry in (old_manifest.get("image_packs", []) + old_manifest.get("video_packs", []))}
    changed_packs = [entry for entry in (upstream_manifest.get("image_packs", []) + upstream_manifest.get("video_packs", [])) if old_packs.get(entry["asset"]) != entry.get("sha256")]
    # Compare the DB key set without retaining prompt text or media bytes.
    previous_db = ROOT / "db" / "prompts.db"
    previous_db_gz = ROOT / "db" / "prompts.db.gz"
    previous_path = previous_db if previous_db.is_file() else previous_db_gz
    added_images = None
    if previous_path.is_file():
        expanded = SYNC_ROOT / f"dry-run-previous-{os.getpid()}.db"
        try:
            source = previous_path
            if previous_path.name.endswith(".gz"):
                with gzip.open(previous_path, "rb") as src, expanded.open("wb") as dst: shutil.copyfileobj(src, dst)
                source = expanded
            expanded_new = scratch_root / "new-prompts.db"
            with gzip.open(scratch_archive, "rb") as src, expanded_new.open("wb") as dst: shutil.copyfileobj(src, dst)
            old = sqlite3.connect(source)
            new = sqlite3.connect(expanded_new)
            old_keys = {tuple(row) for row in old.execute("SELECT tweet_id,image_index FROM images")}
            new_keys = {tuple(row) for row in new.execute("SELECT tweet_id,image_index FROM images")}
            added_images = len(new_keys - old_keys)
            old.close(); new.close(); expanded_new.unlink(missing_ok=True)
        finally:
            expanded.unlink(missing_ok=True)
    log(f"dry-run scratch: {scratch_root}")
    log(f"dry-run database counts PASS: {json.dumps(counts, ensure_ascii=False, sort_keys=True)}")
    log(f"dry-run database rows: +{added_images if added_images is not None else 'unknown'} image rows; local missing={missing:,}; unresolved={unresolved:,}")
    log(f"dry-run image packs to fetch or refresh: {len(changed_packs)} ({', '.join(entry['asset'] for entry in changed_packs) or 'none'})")
    log("dry-run complete: production DB, images, previews, runtime metadata, and Docker were not changed")
    return 0


def sync() -> int:
    SYNC_ROOT.mkdir(parents=True, exist_ok=True)
    RUNTIME_DATA.mkdir(parents=True, exist_ok=True)
    started_at = datetime.now(timezone.utc).isoformat()
    write_sync_status({"status": "running", "startedAt": started_at, "finishedAt": None})

    local_manifest = current_manifest()
    upstream_manifest = fetch_json("dataset-manifest.json")
    upstream_corpus = fetch_json("public-corpus.json")
    validate_metadata(upstream_manifest, upstream_corpus)

    local_assets = {
        "db": local_manifest.get("db", {}).get("sha256"),
        "packs": {entry["asset"]: entry["sha256"] for entry in (local_manifest.get("image_packs", []) + local_manifest.get("video_packs", []))},
    }
    upstream_assets = {
        "db": upstream_manifest["db"]["sha256"],
        "packs": {entry["asset"]: entry["sha256"] for entry in (upstream_manifest.get("image_packs", []) + upstream_manifest.get("video_packs", []))},
    }
    if local_assets == upstream_assets:
        counts, missing, unresolved = inspect_database(DB_ARCHIVE, upstream_manifest["db"]["counts"])
        generate_previews()
        wait_for_health(counts)
        now = datetime.now(timezone.utc).isoformat()
        write_json_atomic(STATE_PATH, {"dataset_version": upstream_manifest["dataset_version"], "updated_at": now, "prompts": counts["prompts"], "image_rows": counts["images"], "missing_images": missing, "unresolved_images": unresolved})
        status = {"status": "success", "dataset_version": upstream_manifest["dataset_version"], "updated_at": now, "missing_images": missing, "unresolved_images": unresolved, "remote_fallback_images": missing - unresolved, "prompts": counts["prompts"], "images": counts["images"], "videos": counts.get("videos", 0), "previews": preview_count(), "startedAt": started_at, "finishedAt": now}
        write_json_atomic(STATUS_PATH, status)
        write_sync_status(status)
        log(f"already synchronized: {upstream_manifest['dataset_version']}")
        return 0

    _, previous_missing, previous_unresolved = inspect_database(DB_ARCHIVE)
    log(
        f"sync {local_manifest.get('dataset_version')} -> {upstream_manifest['dataset_version']}; "
        f"current missing images: {previous_missing:,}"
    )

    staged_manifest = SYNC_ROOT / "dataset-manifest.json"
    staged_corpus = SYNC_ROOT / "public-corpus.json"
    write_json_atomic(staged_manifest, upstream_manifest)
    write_json_atomic(staged_corpus, upstream_corpus)

    previous_db = SYNC_ROOT / "previous-prompts.db.gz"
    previous_manifest = SYNC_ROOT / "previous-dataset-manifest.json"
    previous_corpus = SYNC_ROOT / "previous-public-corpus.json"
    copy_atomic(DB_ARCHIVE, previous_db)
    if (RUNTIME_DATA / "dataset-manifest.json").is_file():
        copy_atomic(RUNTIME_DATA / "dataset-manifest.json", previous_manifest)
    else:
        write_json_atomic(previous_manifest, local_manifest)
    if (RUNTIME_DATA / "public-corpus.json").is_file():
        copy_atomic(RUNTIME_DATA / "public-corpus.json", previous_corpus)
    else:
        copy_atomic(SOURCE_ROOT / "data" / "public-corpus.json", previous_corpus)

    environment = {
        **os.environ,
        "OIP_DATASET_MANIFEST": str(staged_manifest),
        "OIP_DATASET_ROOT": str(ROOT),
    }
    try:
        # Validate the new database first. Image availability can only be
        # compared AFTER the matching packs are extracted; new database rows
        # naturally refer to images that are not on disk before that step.
        subprocess.run([sys.executable, str(FETCH_SCRIPT), "--db-only"], cwd=ROOT, env=environment, check=True)
        inspect_database(DB_ARCHIVE, upstream_manifest["db"]["counts"])
        subprocess.run([sys.executable, str(FETCH_SCRIPT)], cwd=ROOT, env=environment, check=True)
        generate_previews()
        counts, missing, unresolved = inspect_database(DB_ARCHIVE, upstream_manifest["db"]["counts"])
        if unresolved > previous_unresolved:
            raise RuntimeError(
                f"image availability regressed: {previous_unresolved:,} -> {unresolved:,} unresolved files"
            )
        write_json_atomic(RUNTIME_DATA / "dataset-manifest.json", upstream_manifest)
        write_json_atomic(RUNTIME_DATA / "public-corpus.json", upstream_corpus)
        restart_and_verify(counts)
    except Exception as error:
        failed_status = {
            "status": "failed",
            "attempted_dataset_version": upstream_manifest.get("dataset_version"),
            "previous_dataset_version": local_manifest.get("dataset_version"),
            "error": str(error),
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "startedAt": started_at,
            "finishedAt": datetime.now(timezone.utc).isoformat(),
            "failureReason": str(error),
        }
        write_json_atomic(STATUS_PATH, failed_status)
        write_sync_status(failed_status)
        log("sync failed; restoring previous database and metadata")
        restore_file(previous_db, DB_ARCHIVE)
        restore_file(previous_manifest, RUNTIME_DATA / "dataset-manifest.json")
        restore_file(previous_corpus, RUNTIME_DATA / "public-corpus.json")
        subprocess.run(["docker", "restart", CONTAINER], check=False, stdout=subprocess.DEVNULL)
        raise
    finally:
        staged_manifest.unlink(missing_ok=True)
        staged_corpus.unlink(missing_ok=True)

    # 新数据验收完成后清理同步用的旧副本，不在每次成功更新后多留一份。
    for path in (previous_db, previous_manifest, previous_corpus):
        path.unlink(missing_ok=True)

    state = {
        "dataset_version": upstream_manifest["dataset_version"],
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "prompts": counts["prompts"],
        "image_rows": counts["images"],
        "missing_images": missing,
        "unresolved_images": unresolved,
        "remote_fallback_images": missing - unresolved,
    }
    write_json_atomic(STATE_PATH, state)
    status = {
        "status": "success",
        "dataset_version": state["dataset_version"],
        "updated_at": state["updated_at"],
        "missing_images": state["missing_images"],
        "unresolved_images": state["unresolved_images"],
        "remote_fallback_images": state["remote_fallback_images"],
        "prompts": state["prompts"],
        "images": state["image_rows"],
        "videos": counts.get("videos", 0),
        "previews": preview_count(),
        "startedAt": started_at,
        "finishedAt": state["updated_at"],
    }
    write_json_atomic(STATUS_PATH, status)
    write_sync_status(status)
    log(
        f"sync complete: {state['dataset_version']}, {state['prompts']:,} prompts, "
        f"{state['image_rows']:,} image rows, {state['missing_images']:,} local misses, "
        f"{state['remote_fallback_images']:,} remote fallbacks, {state['unresolved_images']:,} unresolved"
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="download and validate into an isolated scratch directory")
    parser.add_argument("--scratch-root", type=Path, default=Path("/tmp/miaoimg-sync-dry-run"), help="scratch directory used by --dry-run")
    parser.add_argument("--assets-dir", type=Path, help="offline assets directory passed to fetch_dataset.py (for a previously downloaded release)")
    args = parser.parse_args()
    if args.dry_run:
        return dry_run(args.scratch_root, args.assets_dir)
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOCK_PATH.open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log("another release sync is already running")
            return 0
        return sync()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        try:
            write_sync_status({"status": "failed", "failureReason": str(error), "finishedAt": datetime.now(timezone.utc).isoformat()})
        except Exception:
            pass
        log(f"ERROR: {error}")
        raise
