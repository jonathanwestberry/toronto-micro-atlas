"""Choose which Ontario lidar tiles Toronto actually needs.

Selection is against the real municipal boundary, not a bounding box. The
bounding box includes a large slab of Lake Ontario and a strip of Peel and
York, which would cost about a third more tiles for no coverage.
"""

import geopandas as gpd

GTA_2023 = "GTA 2023"


def tiles_for_boundary(index: gpd.GeoDataFrame,
                       boundary: gpd.GeoDataFrame,
                       project: str = GTA_2023) -> gpd.GeoDataFrame:
    scoped = index[index["Project"] == project]
    if scoped.crs != boundary.crs:
        boundary = boundary.to_crs(scoped.crs)
    merged = boundary.union_all()
    return scoped[scoped.intersects(merged)].copy()


def packages_needed(tiles: gpd.GeoDataFrame) -> dict[str, int]:
    counts = tiles["Package"].value_counts().to_dict()
    return {name: int(count) for name, count in sorted(counts.items())}


def dtm_name(dsm_filename: str) -> str:
    if "_DSM" not in dsm_filename:
        raise ValueError(f"not a DSM tile name: {dsm_filename}")
    return dsm_filename.replace("_DSM", "_DTM")
