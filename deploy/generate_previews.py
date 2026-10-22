#!/usr/bin/env python3
"""Incrementally generate small static WebP previews for gallery cards."""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


ROOT = Path(os.environ.get("OIP_REPO_ROOT", "/opt/miaoimg")).resolve()
IMAGES_ROOT = ROOT / "images"
PREVIEWS_ROOT = ROOT / "previews"
SUPPORTED_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}


def target_for(source: Path) -> Path:
    return (PREVIEWS_ROOT / source.relative_to(IMAGES_ROOT)).with_suffix(".webp")


def valid_webp(path: Path) -> bool:
    if not path.is_file() or path.stat().st_size < 16:
        return False
    with path.open("rb") as source:
        header = source.read(12)
    return header.startswith(b"RIFF") and header[8:12] == b"WEBP"


def convert(source: Path, cwebp: str, width: int, quality: int) -> tuple[Path, bool, str]:
    target = target_for(source)
    if valid_webp(target):
        return target, False, "present"
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f"{target.name}.{os.getpid()}.tmp")
    temporary.unlink(missing_ok=True)
    try:
        result = subprocess.run(
            [
                cwebp,
                "-quiet",
                "-mt",
                "-low_memory",
                "-metadata",
                "none",
                "-q",
                str(quality),
                "-resize",
                str(width),
                "0",
                str(source),
                "-o",
                str(temporary),
            ],
            text=True,
            capture_output=True,
            timeout=90,
            check=False,
        )
        if result.returncode != 0 or not valid_webp(temporary):
            detail = result.stderr.strip() or f"cwebp exit {result.returncode}"
            return target, False, detail
        os.replace(temporary, target)
        return target, True, "generated"
    except Exception as error:
        return target, False, str(error)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--width", type=int, default=480)
    parser.add_argument("--quality", type=int, default=65)
    parser.add_argument("--workers", type=int, default=1)
    args = parser.parse_args()
    if args.width < 240 or args.width > 1280:
        raise SystemExit("--width must be between 240 and 1280")
    if args.quality < 35 or args.quality > 90:
        raise SystemExit("--quality must be between 35 and 90")
    if args.workers < 1 or args.workers > 8:
        raise SystemExit("--workers must be between 1 and 8")

    cwebp = shutil.which("cwebp")
    if not cwebp:
        raise SystemExit("cwebp is required; install the Ubuntu package: webp")
    sources = sorted(
        path
        for path in IMAGES_ROOT.rglob("*")
        if path.is_file() and path.suffix.lower() in SUPPORTED_SUFFIXES
    )
    pending = [source for source in sources if not valid_webp(target_for(source))]
    if not pending:
        print(f"previews current: {len(sources):,} files", flush=True)
        return 0

    print(f"generating {len(pending):,} of {len(sources):,} previews", flush=True)
    generated = 0
    failures: list[tuple[str, str]] = []
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        source_iterator = iter(pending)
        futures = {}
        for _ in range(args.workers * 2):
            try:
                source = next(source_iterator)
            except StopIteration:
                break
            futures[executor.submit(convert, source, cwebp, args.width, args.quality)] = source

        completed = 0
        while futures:
            future = next(as_completed(futures))
            source = futures.pop(future)
            completed += 1
            _, created, detail = future.result()
            if created:
                generated += 1
            elif detail != "present":
                failures.append((str(source.relative_to(ROOT)), detail))
            if completed % 500 == 0 or completed == len(pending):
                print(f"  processed {completed:,}/{len(pending):,}", flush=True)
            try:
                next_source = next(source_iterator)
            except StopIteration:
                continue
            futures[executor.submit(convert, next_source, cwebp, args.width, args.quality)] = next_source

    preview_files = sum(1 for path in PREVIEWS_ROOT.rglob("*.webp") if valid_webp(path))
    preview_bytes = sum(path.stat().st_size for path in PREVIEWS_ROOT.rglob("*.webp") if path.is_file())
    print(
        f"previews ready: {preview_files:,} files, {preview_bytes:,} bytes; "
        f"generated {generated:,}, failed {len(failures):,}",
        flush=True,
    )
    for path, detail in failures[:10]:
        print(f"warning: {path}: {detail}", flush=True)
    return 1 if failures and generated == 0 else 0


if __name__ == "__main__":
    raise SystemExit(main())
