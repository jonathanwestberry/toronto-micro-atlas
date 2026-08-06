import io
import struct
import unittest
import zipfile

from fg04_lidar import ZipEntry, parse_central_directory


def build_zip(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, payload in files.items():
            zf.writestr(name, payload)
    return buf.getvalue()


def central_directory_offset(blob: bytes) -> int:
    eocd = blob.rfind(b"PK\x05\x06")
    return struct.unpack("<I", blob[eocd + 16:eocd + 20])[0]


class CentralDirectoryTests(unittest.TestCase):
    def test_parses_every_entry_with_names_and_offsets(self):
        blob = build_zip({"a.tif": b"x" * 5000, "b.tif": b"y" * 7000})

        entries = parse_central_directory(blob, absolute_offset=0)

        self.assertEqual([e.name for e in entries], ["a.tif", "b.tif"])
        self.assertEqual([e.uncompressed_size for e in entries], [5000, 7000])
        for entry in entries:
            self.assertIsInstance(entry, ZipEntry)
            self.assertLess(entry.header_offset, len(blob))

    def test_parses_a_tail_slice_using_the_absolute_offset(self):
        blob = build_zip({"a.tif": b"x" * 5000, "b.tif": b"y" * 7000})
        cd_start = central_directory_offset(blob)
        tail = blob[cd_start:]

        entries = parse_central_directory(tail, absolute_offset=cd_start)

        self.assertEqual([e.name for e in entries], ["a.tif", "b.tif"])

    def test_header_offset_points_at_a_local_file_header(self):
        blob = build_zip({"only.tif": b"z" * 4096})

        entry = parse_central_directory(blob, absolute_offset=0)[0]

        self.assertEqual(blob[entry.header_offset:entry.header_offset + 4],
                         b"PK\x03\x04")
