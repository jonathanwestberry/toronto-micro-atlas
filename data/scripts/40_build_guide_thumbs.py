"""Render one thumbnail per guide, all four framed identically.

The three that existed were made by hand on 2026-07-26 at three different
aspect ratios, 1.71, 1.30 and 2.38, and the card crops to 16:10 with
object-fit: cover. So each one was cropped by a different amount in a
different direction, which is what "inconsistent framing and zoom" turned out
to mean. Out of the Sun had no thumbnail at all: it fell back to its Open
Graph share image, which carries a burned-in title bar, so the card printed
the guide's name twice in two typefaces, the second one cropped mid-word.

Everything here is drawn at one projection, one extent and one size, so the
four cards read as four views of one city rather than four unrelated pictures.
Each guide keeps its own subject and its own ground, because a shared frame is
what makes them a set and a shared palette would make them a smear.

Usage: python 40_build_guide_thumbs.py
"""

import os

import geopandas as gpd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import rasterio
from matplotlib.path import Path as MplPath
from matplotlib.patches import PathPatch
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.abspath(os.path.join(HERE, ".."))
ROOT = os.path.abspath(os.path.join(DATA, ".."))
PUBLIC = os.path.join(ROOT, "public")
OUT_DIR = os.path.join(PUBLIC, "hero", "thumbs")

# 16:10, matching .guide-card-media's aspect-ratio exactly so the card never
# has to crop. The widest a card ever gets is around 450 CSS px, so 1200 is
# comfortably past 2x for retina and 2000 was paying for detail no screen
# resolves: it cost 440 KB on the shade card alone, and these four all load on
# the homepage together.
WIDTH, HEIGHT = 1200, 750
DPI = 150

# Toronto, framed once. Padded a little on each side so the city sits inside
# the frame with air around it rather than bleeding off the corners.
PAD = 0.02

INK = "#27241D"
PAPER = "#FAF6EC"

# The CRS the shade surface was computed in. Read once here rather than
# hardcoded in two places, so the frame follows the data if the pipeline ever
# reprojects.
SHADE_PATH = os.path.join(DATA, "processed", "fg04", "shade-raw.tif")


def shade_crs():
    with rasterio.open(SHADE_PATH) as src:
        return src.crs




def city_extent(boundary):
    minx, miny, maxx, maxy = boundary.total_bounds
    span_x, span_y = maxx - minx, maxy - miny
    # Widen or heighten to 16:10 around the centre, so every guide gets the
    # same window regardless of what it draws inside it.
    target = WIDTH / HEIGHT
    if span_x / span_y < target:
        grow = (span_y * target - span_x) / 2
        minx, maxx = minx - grow, maxx + grow
    else:
        grow = (span_x / target - span_y) / 2
        miny, maxy = miny - grow, maxy + grow
    px, py = (maxx - minx) * PAD, (maxy - miny) * PAD
    return minx - px, maxx + px, miny - py, maxy + py


def new_figure(extent, background):
    figure = plt.figure(figsize=(WIDTH / DPI, HEIGHT / DPI), dpi=DPI)
    axes = figure.add_axes([0, 0, 1, 1])
    axes.set_facecolor(background)
    figure.patch.set_facecolor(background)
    axes.set_xlim(extent[0], extent[1])
    axes.set_ylim(extent[2], extent[3])
    axes.set_axis_off()
    return figure, axes


def save(figure, slug):
    os.makedirs(OUT_DIR, exist_ok=True)
    png = os.path.join(OUT_DIR, f"{slug}.png")
    figure.savefig(png, dpi=DPI, facecolor=figure.get_facecolor())
    plt.close(figure)
    webp = os.path.join(OUT_DIR, f"{slug}.webp")
    with Image.open(png) as image:
        image.convert("RGB").save(webp, "WEBP", quality=76, method=6)
    os.remove(png)
    return webp


def draw_land(axes, boundary, face, edge, linewidth=1.6):
    boundary.plot(ax=axes, facecolor=face, edgecolor=edge, linewidth=linewidth)


def city_clip(axes, boundary):
    """A clip path in the shape of Toronto.

    The lidar mosaic is a rectangle of flight tiles and runs well past the
    city, so an unclipped raster draws a stepped tile edge across the top of
    the thumbnail and puts measured ground outside the boundary line, which
    reads as the map being wrong about where Toronto ends.
    """
    vertices, codes = [], []
    for geometry in boundary.geometry:
        polygons = (geometry.geoms
                    if geometry.geom_type == "MultiPolygon" else [geometry])
        for polygon in polygons:
            for ring in [polygon.exterior, *polygon.interiors]:
                points = list(ring.coords)
                vertices.extend(points)
                codes.extend([MplPath.MOVETO]
                             + [MplPath.LINETO] * (len(points) - 2)
                             + [MplPath.CLOSEPOLY])
    return PathPatch(MplPath(vertices, codes), transform=axes.transData,
                     facecolor="none", edgecolor="none")


def build_hidden_landscapes(boundary, extent):
    """Ravines and buried water, with the eight thresholds marked."""
    figure, axes = new_figure(extent, PAPER)
    draw_land(axes, boundary, "#F0E9D8", INK)
    green = gpd.read_file(
        os.path.join(DATA, "processed", "green-spaces.geojson")).to_crs(boundary.crs)
    green.plot(ax=axes, facecolor="#45A26A", edgecolor="none", alpha=0.95)

    lats, lngs = [], []
    location_dir = os.path.join(ROOT, "src", "content", "locations")
    for name in sorted(os.listdir(location_dir)):
        if not name.endswith(".md"):
            continue
        with open(os.path.join(location_dir, name)) as handle:
            for line in handle:
                if line.startswith("lat:"):
                    lats.append(float(line.split(":", 1)[1]))
                elif line.startswith("lng:"):
                    lngs.append(float(line.split(":", 1)[1]))
    marks = gpd.GeoDataFrame(
        geometry=gpd.points_from_xy(lngs, lats), crs="EPSG:4326").to_crs(boundary.crs)
    marks.plot(ax=axes, color="#2A5BD0", markersize=90,
               edgecolor=PAPER, linewidth=2.2, zorder=5)
    return save(figure, "hidden-landscapes")


def build_sidewalk_forest(boundary, extent):
    """Every street tree, one dot each, on the guide's own dark ground."""
    figure, axes = new_figure(extent, "#12331f")
    draw_land(axes, boundary, "#12331f", "#2f5f42", linewidth=1.4)
    trees = gpd.read_file(os.path.join(DATA, "raw", "street-trees-4326.geojson"))
    # The city publishes each tree as a single-point MultiPoint, which has no
    # .x, so explode to real points before reading coordinates off them.
    trees = trees.explode(index_parts=False).to_crs(boundary.crs)
    # Every tree is 688,335 points, which at thumbnail scale is a solid block
    # of colour and a very slow render. A deterministic sample keeps the shape
    # of the canopy, which is the only thing readable at this size.
    if len(trees) > 90000:
        step = len(trees) // 90000 + 1
        trees = trees.iloc[::step]
    axes.scatter(trees.geometry.x, trees.geometry.y, s=0.35,
                 c="#E8A6A0", linewidths=0, alpha=0.9)
    return save(figure, "sidewalk-forest")


def build_when_toronto_has_to_go(boundary, extent):
    """Documented public washrooms."""
    figure, axes = new_figure(extent, PAPER)
    draw_land(axes, boundary, "#ece4d0", INK)
    facilities = gpd.read_file(os.path.join(
        PUBLIC, "data", "fg03", "2026-07-21", "facilities.geojson")).to_crs(boundary.crs)
    facilities.plot(ax=axes, color="#1A2F66", markersize=26,
                    edgecolor=PAPER, linewidth=0.7, zorder=5)
    return save(figure, "when-toronto-has-to-go")


def build_out_of_the_sun(boundary, extent):
    """Shaded hours per day on the measured surface, citywide.

    The subject of this guide is a raster, so this one is sampled from the
    shade surface itself rather than drawn from vectors.

    Hours of shade across the day rather than a single clock hour. 13:00 is
    the hour the guide leads with, and it was tried here first: at 13:00 only
    10.73 per cent of the ground is shaded, so citywide it renders as faint
    speckle on sand and says nothing at card size. Counting the day's shaded
    frames instead gives the ravines, the tower districts and the bare
    arterials visible structure, and it is the same surface either way.
    """
    figure, axes = new_figure(extent, PAPER)
    # The land takes the sunlit sand exactly, so ground the flight never
    # measured is indistinguishable from ground that was measured and sunlit.
    # A land fill one shade off the raster drew a visible rectangle across the
    # thumbnail wherever the raster's own extent ended.
    draw_land(axes, boundary, "#EAE3C7", INK)

    with rasterio.open(SHADE_PATH) as src:
        # Read heavily decimated: the full surface is around 946 million
        # pixels and the thumbnail is two thousand across.
        scale = max(1, src.width // (WIDTH * 2))
        bits = src.read(
            1,
            out_shape=(1, src.height // scale, src.width // scale),
            resampling=rasterio.enums.Resampling.nearest,
        )
        bounds = src.bounds
        raster_crs = src.crs

    # Count the set bits in positions 0 to 14, the modelled daylight hours.
    # Bit 15 is never set and is not an hour, so it is masked off rather than
    # allowed to inflate a pixel to a sixteenth frame.
    hours = np.zeros(bits.shape, dtype=np.uint8)
    for position in range(15):
        hours += ((bits >> position) & 1).astype(np.uint8)
    measured = bits > 0

    # Sand to ink across nought to fifteen hours. Every pixel the flight
    # measured gets a value, so the field is continuous rather than speckled.
    sun = np.array([0.918, 0.890, 0.780])
    ink = np.array([0.153, 0.141, 0.114])
    t = (hours / 15.0)[..., None]
    image = np.zeros((*bits.shape, 4), dtype=float)
    image[..., :3] = sun * (1 - t) + ink * t
    image[..., 3] = measured.astype(float)

    if raster_crs != boundary.crs:
        raise SystemExit(
            f"shade raster is {raster_crs} and the frame is {boundary.crs}")
    drawn = axes.imshow(image, extent=(bounds.left, bounds.right,
                                       bounds.bottom, bounds.top),
                        interpolation="nearest", zorder=3)
    clip = city_clip(axes, boundary)
    axes.add_patch(clip)
    drawn.set_clip_path(clip)
    # The boundary again, over the raster, so the city keeps its edge.
    boundary.plot(ax=axes, facecolor="none", edgecolor=INK,
                  linewidth=1.6, zorder=4)
    return save(figure, "out-of-the-sun")


def main() -> None:
    boundary = gpd.read_file(os.path.join(
        PUBLIC, "data", "toronto-boundary.geojson"))
    # Everything is framed in the shade raster's own CRS. Out of the Sun is
    # sampled straight from that raster, and reprojecting 946 million pixels to
    # match a web-mercator frame would be both slow and lossy, where
    # reprojecting four vector layers the other way is neither. The assertion
    # in build_out_of_the_sun() holds this honest: a raster quietly drawn in
    # the wrong projection lands somewhere plausible and slightly wrong, which
    # is the hardest kind of map error to see.
    boundary = boundary.to_crs(shade_crs())
    extent = city_extent(boundary)
    print(f"frame {WIDTH}x{HEIGHT} at {WIDTH / HEIGHT:.2f}, one extent for all four")

    for build in (build_hidden_landscapes, build_sidewalk_forest,
                  build_when_toronto_has_to_go, build_out_of_the_sun):
        out = build(boundary, extent)
        size_kb = os.path.getsize(out) / 1024
        print(f"  {os.path.basename(out):32s} {size_kb:7.1f} KB")


if __name__ == "__main__":
    main()
