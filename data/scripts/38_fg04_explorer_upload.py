"""Upload only the FG04 class/v1 explorer tile product to Cloudflare R2.

The shade v3 prefix is never opened or written by this script. Local files are
staged outside ``public/`` so they cannot enter the Pages deployment.

Usage: python 38_fg04_explorer_upload.py [--dry-run]
"""

import argparse
import concurrent.futures
from io import BytesIO
import os
from pathlib import Path
import time
from urllib.request import Request, urlopen

import numpy as np
from PIL import Image

import fg04_explorer as explorer
import fg04_pyramid as pyramid

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
TILES = (ROOT / "data" / "processed" / "fg04"
         / f"class-tiles-{explorer.CLASS_VERSION}")
PREFIX = f"fg04/class/{explorer.CLASS_VERSION}"
CONTENT_TYPE = f"image/{pyramid.TILE_FORMAT}"
CACHE_CONTROL = "public, max-age=31536000, immutable"


def load_repo_credentials() -> None:
    """Load only the three R2 values from the ignored repo-root .env file."""
    path = ROOT / ".env"
    if not path.exists():
        return
    allowed = {
        "CLOUDFLARE_ACCOUNT_ID",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
    }
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name = name.strip()
        if name not in allowed or os.environ.get(name):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ[name] = value


def local_tiles():
    for path in sorted(TILES.rglob(f"*.{pyramid.TILE_FORMAT}")):
        yield path, path.relative_to(TILES).as_posix()


def client():
    try:
        import boto3
        from botocore.config import Config
    except ImportError:
        raise SystemExit("boto3 is required in the FG04 Python environment")

    load_repo_credentials()
    values = {
        "CLOUDFLARE_ACCOUNT_ID": os.environ.get("CLOUDFLARE_ACCOUNT_ID"),
        "R2_ACCESS_KEY_ID": os.environ.get("R2_ACCESS_KEY_ID"),
        "R2_SECRET_ACCESS_KEY": os.environ.get("R2_SECRET_ACCESS_KEY"),
    }
    missing = [name for name, value in values.items() if not value]
    if missing:
        raise SystemExit("missing credentials: " + ", ".join(missing))
    return boto3.client(
        "s3",
        endpoint_url=(f"https://{values['CLOUDFLARE_ACCOUNT_ID']}"
                      ".r2.cloudflarestorage.com"),
        aws_access_key_id=values["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=values["R2_SECRET_ACCESS_KEY"],
        config=Config(signature_version="s3v4", retries={"max_attempts": 5}),
        region_name="auto",
    )


def verify_public(sample) -> dict:
    path, relative = sample
    url = f"{explorer.CLASS_BASE_URL}/{relative}"
    request = Request(url, headers={"User-Agent": "Mozilla/5.0 FG04 verifier"})
    with urlopen(request, timeout=30) as response:
        body = response.read()
        headers = response.headers
        status = response.status
    with Image.open(path) as local_image, Image.open(BytesIO(body)) as remote_image:
        local = np.asarray(local_image.convert("RGB"))
        remote = np.asarray(remote_image.convert("RGB"))
    if status != 200 or headers.get_content_type() != CONTENT_TYPE:
        raise RuntimeError(f"public class tile contract failed: {status} {headers}")
    if CACHE_CONTROL not in headers.get("Cache-Control", ""):
        raise RuntimeError("public class tile lacks immutable cache policy")
    if not np.array_equal(local, remote):
        raise RuntimeError("public class tile bytes decode differently from local")
    explorer.decode_class_tile(remote, verify=True)
    return {
        "url": url,
        "status": status,
        "contentType": headers.get_content_type(),
        "cacheControl": headers.get("Cache-Control"),
        "cors": headers.get("Access-Control-Allow-Origin"),
    }


def upload(dry_run=False) -> None:
    tiles = list(local_tiles())
    if not tiles:
        raise SystemExit("no class tiles; run 37_fg04_explorer.py first")
    total_bytes = sum(path.stat().st_size for path, _ in tiles)
    print(f"{len(tiles):,} class tiles, {total_bytes / 1e6:.1f} MB")
    print(f"bucket {pyramid.R2_BUCKET}, prefix {PREFIX}/")
    if dry_run:
        print("dry run, nothing uploaded")
        return

    s3 = client()
    s3.head_bucket(Bucket=pyramid.R2_BUCKET)
    started = time.time()

    def put(item):
        path, relative = item
        with path.open("rb") as handle:
            s3.put_object(
                Bucket=pyramid.R2_BUCKET,
                Key=f"{PREFIX}/{relative}",
                Body=handle.read(),
                ContentType=CONTENT_TYPE,
                CacheControl=CACHE_CONTROL,
                IfNoneMatch="*",
            )
        return relative

    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        for _ in pool.map(put, tiles):
            done += 1
            if done % 500 == 0:
                rate = done / max(time.time() - started, 1e-9)
                print(f"  {done:,}/{len(tiles):,}, {rate:.0f}/s", flush=True)
    print(f"{done:,} objects in {time.time() - started:.0f} s")

    samples = [tiles[0], tiles[len(tiles) // 2], tiles[-1]]
    for result in [verify_public(sample) for sample in samples]:
        print(result)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    arguments = parser.parse_args()
    upload(dry_run=arguments.dry_run)
