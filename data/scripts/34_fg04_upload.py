"""Put the shade tile pyramid on Cloudflare R2.

The pyramid is 9,555 files. Cloudflare Pages allows 20,000 per deployment,
so shipping it inside the site would spend half the atlas's lifetime file
budget on one guide, and would add the whole pyramid to git history again on
every rebuild. Tiles are already compressed, so git cannot delta them: the
January frame alone would double it.

R2 has neither limit. The deployment stays at its current ~450 files however
many map guides ship, the repo stays small, and a rebuild replaces objects
instead of appending to history forever. Egress to Cloudflare's own CDN is
free.

Credentials come from the environment, never from a committed file:

    R2_ACCESS_KEY_ID       S3-compatible access key for the account
    R2_SECRET_ACCESS_KEY   its secret
    CLOUDFLARE_ACCOUNT_ID  the account the bucket lives in

The Cloudflare API token used for DNS and Pages does **not** carry R2
permission; the R2 endpoints answer "Authentication error" with it. Either
widen that token with "Workers R2 Storage: Edit" or mint an R2 API token,
which is what produces the two S3 keys above.

Usage: python 34_fg04_upload.py [--dry-run] [--prefix fg04]
"""

import argparse
import concurrent.futures
import mimetypes
import os
import sys
import time

import fg04_pyramid as pyramid

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.abspath(os.path.join(HERE, ".."))
ROOT = os.path.abspath(os.path.join(DATA, ".."))
TILES = os.path.join(ROOT, "public", "data", "fg04", "tiles")

CONTENT_TYPE = f"image/{pyramid.TILE_FORMAT}"
# A tile is immutable: its coordinates and its date fully determine it. A
# rebuild for a different date writes a different prefix rather than
# overwriting this one, so a year is safe and the CDN never revalidates.
CACHE_CONTROL = "public, max-age=31536000, immutable"


def local_tiles():
    for folder, _, names in os.walk(TILES):
        for name in names:
            path = os.path.join(folder, name)
            yield path, os.path.relpath(path, TILES).replace(os.sep, "/")


def client():
    try:
        import boto3
        from botocore.config import Config
    except ImportError:
        raise SystemExit(
            "boto3 is not installed. It is the S3 client R2 speaks:\n"
            "  data/scripts/.venv/bin/pip install boto3")

    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    key = os.environ.get("R2_ACCESS_KEY_ID")
    secret = os.environ.get("R2_SECRET_ACCESS_KEY")
    missing = [name for name, value in
               (("CLOUDFLARE_ACCOUNT_ID", account),
                ("R2_ACCESS_KEY_ID", key),
                ("R2_SECRET_ACCESS_KEY", secret)) if not value]
    if missing:
        raise SystemExit(
            "missing credentials: " + ", ".join(missing) + "\n"
            "The Cloudflare token used for DNS and Pages has no R2 "
            "permission. Mint an R2 API token in the dashboard under "
            "R2 > Manage API tokens; it gives an access key and a secret.")

    return boto3.client(
        "s3",
        endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
        aws_access_key_id=key,
        aws_secret_access_key=secret,
        config=Config(signature_version="s3v4", retries={"max_attempts": 5}),
        region_name="auto")


def ensure_bucket(s3, bucket: str) -> None:
    """Check the bucket by name, not by listing.

    An "Object Read & Write" R2 token cannot list buckets, and it should not
    need to. `head_bucket` answers the only question that matters.
    """
    from botocore.exceptions import ClientError

    try:
        s3.head_bucket(Bucket=bucket)
        print(f"bucket {bucket}: reachable")
        return
    except ClientError as error:
        code = error.response["Error"].get("Code")
        if code not in ("404", "NoSuchBucket"):
            raise SystemExit(
                f"cannot reach bucket {bucket}: {code} "
                f"{error.response['Error'].get('Message')}")

    print(f"bucket {bucket} does not exist; creating it")
    s3.create_bucket(Bucket=bucket)


def upload(dry_run: bool, prefix: str) -> None:
    if not os.path.isdir(TILES):
        raise SystemExit("no tiles on disk; run 33_fg04_tiles.py first")

    tiles = list(local_tiles())
    total_bytes = sum(os.path.getsize(path) for path, _ in tiles)
    print(f"{len(tiles):,} tiles, {total_bytes / 1e6:.1f} MB")
    print(f"bucket {pyramid.R2_BUCKET}, prefix {prefix}/")
    for surface, template in pyramid.tile_url_templates().items():
        print(f"  {surface:<10} {template}")
    if dry_run:
        print("dry run, nothing uploaded")
        return

    s3 = client()
    ensure_bucket(s3, pyramid.R2_BUCKET)

    started = time.time()
    done = 0

    def put(item):
        path, key = item
        with open(path, "rb") as handle:
            s3.put_object(Bucket=pyramid.R2_BUCKET, Key=f"{prefix}/{key}",
                          Body=handle.read(), ContentType=CONTENT_TYPE,
                          CacheControl=CACHE_CONTROL)
        return key

    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        for _ in pool.map(put, tiles):
            done += 1
            if done % 500 == 0:
                rate = done / max(time.time() - started, 1e-9)
                print(f"  {done:,}/{len(tiles):,}, {rate:.0f}/s", flush=True)

    print(f"{done:,} objects in {time.time() - started:.0f} s")
    print("\nRemaining, once: attach a custom domain to the bucket so the "
          f"tiles answer on {pyramid.TILE_BASE_URL.split('/fg04')[0]}, "
          "or make the bucket public and put its r2.dev host in "
          "fg04_pyramid.TILE_BASE_URL.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--prefix",
                        default=f"fg04/{pyramid.TILE_VERSION}")
    args = parser.parse_args()
    upload(dry_run=args.dry_run, prefix=args.prefix)
