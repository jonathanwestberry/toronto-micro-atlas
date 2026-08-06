"""Pull single tiles out of Ontario's remote lidar zip packages.

The GTA 2023 packages are 2.4 to 3.4 GB each and Toronto needs only part of
five of them. The download server honours HTTP byte ranges, so the central
directory can be read remotely and individual entries extracted without
transferring the package.
"""

import json
import os
import struct
import subprocess
import zlib
from dataclasses import dataclass

CURL_TIMEOUT = "300"


@dataclass(frozen=True)
class ZipEntry:
    name: str
    compression: int
    compressed_size: int
    uncompressed_size: int
    header_offset: int


def _byte_range(url: str, start: int, end: int) -> bytes:
    result = subprocess.run(
        ["curl", "-s", "--max-time", CURL_TIMEOUT, "-r", f"{start}-{end}", url],
        capture_output=True,
        check=True,
    )
    return result.stdout


def _content_length(url: str) -> int:
    result = subprocess.run(
        ["curl", "-sIL", "--max-time", "60", url],
        capture_output=True, text=True, check=True,
    )
    length = None
    for line in result.stdout.splitlines():
        if line.lower().startswith("content-length:"):
            length = int(line.split(":", 1)[1].strip())
    if length is None:
        raise RuntimeError(f"no content-length for {url}")
    return length


def _read_zip64_extra(extra: bytes, uncompressed, compressed, offset):
    cursor = 0
    while cursor < len(extra):
        header_id, size = struct.unpack("<HH", extra[cursor:cursor + 4])
        block = extra[cursor + 4:cursor + 4 + size]
        if header_id == 1:
            pos = 0
            if uncompressed == 0xFFFFFFFF:
                uncompressed = struct.unpack("<Q", block[pos:pos + 8])[0]
                pos += 8
            if compressed == 0xFFFFFFFF:
                compressed = struct.unpack("<Q", block[pos:pos + 8])[0]
                pos += 8
            if offset == 0xFFFFFFFF:
                offset = struct.unpack("<Q", block[pos:pos + 8])[0]
        cursor += 4 + size
    return uncompressed, compressed, offset


def parse_central_directory(data: bytes, absolute_offset: int) -> list[ZipEntry]:
    """Parse central directory records out of `data`.

    `absolute_offset` is the position of `data[0]` within the whole zip, so
    that header offsets come back as absolute positions usable in a range
    request. Pass 0 when `data` is the entire file.
    """
    start = data.find(b"PK\x01\x02")
    if start < 0:
        return []
    entries: list[ZipEntry] = []
    cursor = start
    while data[cursor:cursor + 4] == b"PK\x01\x02":
        fields = struct.unpack("<HHHHHHIIIHHHHHII", data[cursor + 4:cursor + 46])
        compression = fields[3]
        compressed, uncompressed = fields[7], fields[8]
        name_len, extra_len, comment_len = fields[9], fields[10], fields[11]
        offset = fields[15]
        name = data[cursor + 46:cursor + 46 + name_len].decode()
        extra = data[cursor + 46 + name_len:cursor + 46 + name_len + extra_len]
        if 0xFFFFFFFF in (compressed, uncompressed, offset):
            uncompressed, compressed, offset = _read_zip64_extra(
                extra, uncompressed, compressed, offset)
        entries.append(ZipEntry(
            name=name,
            compression=compression,
            compressed_size=compressed,
            uncompressed_size=uncompressed,
            header_offset=offset,
        ))
        cursor += 46 + name_len + extra_len + comment_len
    del absolute_offset  # offsets in the record are already absolute
    return entries


def remote_entries(url: str, cache_path: str | None = None) -> list[ZipEntry]:
    if cache_path and os.path.exists(cache_path):
        return [ZipEntry(**row) for row in json.load(open(cache_path))]

    size = _content_length(url)
    tail_length = min(size, 400_000)
    tail_start = size - tail_length
    tail = _byte_range(url, tail_start, size - 1)

    zip64 = tail.rfind(b"PK\x06\x06")
    if zip64 >= 0:
        cd_offset = struct.unpack("<Q", tail[zip64 + 48:zip64 + 56])[0]
    else:
        eocd = tail.rfind(b"PK\x05\x06")
        cd_offset = struct.unpack("<I", tail[eocd + 16:eocd + 20])[0]

    if cd_offset < tail_start:
        tail = _byte_range(url, cd_offset, size - 1)
        tail_start = cd_offset

    entries = parse_central_directory(tail, absolute_offset=tail_start)
    if cache_path:
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        json.dump([e.__dict__ for e in entries], open(cache_path, "w"))
    return entries


def extract_entry(url: str, entry: ZipEntry, out_path: str) -> str:
    header = _byte_range(url, entry.header_offset, entry.header_offset + 29)
    signature = struct.unpack("<I", header[:4])[0]
    if signature != 0x04034B50:
        raise RuntimeError(f"bad local header for {entry.name}")
    name_len, extra_len = struct.unpack("<HH", header[26:30])
    start = entry.header_offset + 30 + name_len + extra_len
    blob = _byte_range(url, start, start + entry.compressed_size - 1)
    raw = zlib.decompress(blob, -15) if entry.compression == 8 else blob
    if len(raw) != entry.uncompressed_size:
        raise RuntimeError(
            f"{entry.name}: got {len(raw)} bytes, expected {entry.uncompressed_size}")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "wb") as handle:
        handle.write(raw)
    return out_path
