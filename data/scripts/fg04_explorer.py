"""Pure contracts for the FG04 clock-hour explorer data products.

The shipped v3 tiles remain immutable. This module defines the separate point
classification and named-street profile rules used by the Phase 3 builder.
File I/O belongs in ``37_fg04_explorer.py`` and R2 writes belong in
``38_fg04_explorer_upload.py``.
"""

from collections import Counter, defaultdict
from dataclasses import dataclass
import hashlib
import re
import unicodedata

import numpy as np
from shapely.ops import unary_union

from fg04_pyramid import ALL_HOURS

MISSING = 0
NON_GROUND = 1
GROUND = 2
UNDER_CANOPY = 3
CLASS_NAMES = {
    MISSING: "missing",
    NON_GROUND: "non-ground",
    GROUND: "ground",
    UNDER_CANOPY: "ground under leaf-on canopy",
}
CLASS_VERSION = "v2"
CLASS_BASE_URL = (
    f"https://tiles.torontomicroatlas.com/fg04/class/{CLASS_VERSION}")
CLASS_LOCAL_BASE_URL = "/data/fg04/class-tiles"
POINT_CLASS_ALGORITHM = "coverage-ground-canopy-v1"

INNER_WALK_M = 8.0
OUTER_WALK_M = 15.0
MINIMUM_STREET_LENGTH_M = 100.0

EXCLUDED_HIGHWAYS = {
    "construction",
    "motorway",
    "motorway_link",
    "proposed",
    "raceway",
    "service",
}
BLOCKED_ACCESS = {"no", "private"}


@dataclass(frozen=True)
class StreetGroup:
    id: str
    name: str
    geometry: object


@dataclass(frozen=True)
class PairedProfile:
    measured: list
    corrected: list
    ground_pixels: int
    corrected_bits: np.ndarray


def classify_pixels(coverage: np.ndarray, ground: np.ndarray,
                    canopy: np.ndarray) -> np.ndarray:
    """Classify each source pixel with missing and non-ground kept distinct."""
    coverage = np.asarray(coverage, dtype=bool)
    ground = np.asarray(ground, dtype=bool)
    canopy = np.asarray(canopy, dtype=bool)
    if coverage.shape != ground.shape or ground.shape != canopy.shape:
        raise ValueError("coverage, ground and canopy must have one shape")

    classes = np.full(coverage.shape, MISSING, dtype=np.uint8)
    classes[coverage] = NON_GROUND
    classes[coverage & ground] = GROUND
    classes[coverage & ground & canopy] = UNDER_CANOPY
    return classes


def downsample_classes(classes: np.ndarray) -> np.ndarray:
    """Halve classes with majority coverage, ground, then canopy votes.

    At least two of four source pixels must be covered for a covered parent.
    At least two must be ground for a ground parent. Canopy is then a majority
    among the ground voters, with a tie kept as canopy so corrected shade does
    not disappear at overview boundaries.
    """
    classes = np.asarray(classes, dtype=np.uint8)
    if classes.ndim != 2:
        raise ValueError("classes must be a two-dimensional array")
    height, width = classes.shape
    if height % 2 or width % 2:
        raise ValueError(f"cannot halve a {height}x{width} classification")
    if classes.size and int(classes.max()) > UNDER_CANOPY:
        raise ValueError("unknown point classification value")

    blocks = classes.reshape(height // 2, 2, width // 2, 2)
    covered = (blocks != MISSING).sum(axis=(1, 3))
    ground = (blocks >= GROUND).sum(axis=(1, 3))
    canopy = (blocks == UNDER_CANOPY).sum(axis=(1, 3))

    result = np.full(covered.shape, MISSING, dtype=np.uint8)
    result[covered >= 2] = NON_GROUND
    ground_parent = ground >= 2
    result[ground_parent] = GROUND
    canopy_parent = ground_parent & (canopy * 2 >= ground)
    result[canopy_parent] = UNDER_CANOPY
    return result


def encode_class_tile(classes: np.ndarray) -> np.ndarray:
    """Encode one exact classification byte in red, with G and B reserved."""
    classes = np.asarray(classes, dtype=np.uint8)
    if classes.ndim != 2:
        raise ValueError("classes must be a two-dimensional array")
    if classes.size and int(classes.max()) > UNDER_CANOPY:
        raise ValueError("unknown point classification value")
    pixels = np.zeros(classes.shape + (3,), dtype=np.uint8)
    pixels[:, :, 0] = classes
    return pixels


def decode_class_tile(pixels: np.ndarray, verify: bool = False) -> np.ndarray:
    """Decode a class tile and optionally reject non-zero reserved channels."""
    pixels = np.asarray(pixels, dtype=np.uint8)
    if pixels.ndim != 3 or pixels.shape[2] != 3:
        raise ValueError("classification tile must be an RGB array")
    classes = pixels[:, :, 0]
    if classes.size and int(classes.max()) > UNDER_CANOPY:
        raise ValueError("unknown point classification value")
    if verify and pixels[:, :, 1:].any():
        raise ValueError("classification tile reserved channels are not zero")
    return classes


def classification_tile_url(base_url: str = None) -> str:
    base = CLASS_BASE_URL if base_url is None else base_url.rstrip("/")
    return f"{base}/{{z}}/{{x}}/{{y}}.webp"


def normalize_street_name(name: str) -> str:
    """Stable key for OSM names without inventing abbreviation equivalence."""
    if not isinstance(name, str):
        return ""
    text = unicodedata.normalize("NFKC", name)
    return " ".join(text.split()).casefold()


def street_slug(name: str) -> str:
    text = unicodedata.normalize("NFKD", normalize_street_name(name))
    ascii_text = text.encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_text).strip("-")
    if slug:
        return slug
    return "street-" + hashlib.sha1(text.encode("utf-8")).hexdigest()[:10]


def is_walkable_street(tags: dict) -> bool:
    """Whether one named OSM way belongs in the walking-band explorer."""
    if not isinstance(tags, dict) or not normalize_street_name(tags.get("name")):
        return False
    highway = tags.get("highway")
    if not isinstance(highway, str) or highway in EXCLUDED_HIGHWAYS:
        return False
    if tags.get("foot") in BLOCKED_ACCESS:
        return False
    if tags.get("access") in BLOCKED_ACCESS and tags.get("foot") != "yes":
        return False
    return True


def group_named_streets(features) -> list[StreetGroup]:
    """Merge walkable OSM linework by normalized displayed name."""
    geometry_by_name = defaultdict(list)
    display_by_name = defaultdict(Counter)
    for feature in features:
        tags = feature.get("tags", {})
        geometry = feature.get("geometry")
        if not is_walkable_street(tags) or geometry is None or geometry.is_empty:
            continue
        key = normalize_street_name(tags["name"])
        display = " ".join(unicodedata.normalize("NFKC", tags["name"]).split())
        geometry_by_name[key].append(geometry)
        display_by_name[key][display] += 1

    groups = []
    used_ids = {}
    for key in sorted(geometry_by_name):
        displays = display_by_name[key]
        name = min(displays, key=lambda item: (-displays[item], item.casefold(), item))
        identifier = street_slug(name)
        if identifier in used_ids and used_ids[identifier] != key:
            suffix = hashlib.sha1(key.encode("utf-8")).hexdigest()[:8]
            identifier = f"{identifier}-{suffix}"
        used_ids[identifier] = key
        groups.append(StreetGroup(
            id=identifier,
            name=name,
            geometry=unary_union(geometry_by_name[key]),
        ))
    return groups


def walking_band(geometry, inner: float = INNER_WALK_M,
                 outer: float = OUTER_WALK_M):
    """The guide's walking sample band, excluding the carriageway core."""
    if not 0 <= inner < outer:
        raise ValueError("walking band requires 0 <= inner < outer")
    return geometry.buffer(outer).difference(geometry.buffer(inner))


def paired_hourly_profile(measured_bits: np.ndarray,
                          corrected_bits: np.ndarray,
                          sample: np.ndarray,
                          classes: np.ndarray,
                          hours: int = 15) -> PairedProfile:
    """Paired fractions on sampled ground, with corrected canopy override."""
    measured_bits = np.asarray(measured_bits, dtype=np.uint16)
    corrected_bits = np.asarray(corrected_bits, dtype=np.uint16)
    sample = np.asarray(sample, dtype=bool)
    classes = np.asarray(classes, dtype=np.uint8)
    shapes = {value.shape for value in
              (measured_bits, corrected_bits, sample, classes)}
    if len(shapes) != 1:
        raise ValueError("bits, sample and classes must have one shape")
    if not 1 <= hours <= 15:
        raise ValueError("hours must be between 1 and 15")

    ground = sample & (classes >= GROUND)
    corrected_with_canopy = np.where(
        classes == UNDER_CANOPY, ALL_HOURS, corrected_bits).astype(np.uint16)
    count = int(ground.sum())
    if count == 0:
        empty = [None] * hours
        return PairedProfile(empty, empty.copy(), 0, corrected_with_canopy)

    def fractions(bits):
        return [float((((bits >> position) & 1).astype(bool) & ground).sum())
                      / count for position in range(hours)]

    return PairedProfile(
        measured=fractions(measured_bits),
        corrected=fractions(corrected_with_canopy),
        ground_pixels=count,
        corrected_bits=corrected_with_canopy,
    )
