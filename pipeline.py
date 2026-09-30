"""GeoTIFF -> Cloud Optimized GeoTIFF -> XYZ web tiles.

Run inside the Docker image (see Dockerfile). Settings come from env vars.
"""

import json
import math
import os
import shutil
import sys
import time
from pathlib import Path

from osgeo import gdal, osr

# must be set before importing gdal2tiles, it touches osr at import time
gdal.UseExceptions()
osr.UseExceptions()

from osgeo_utils import gdal2tiles  # noqa: E402

INPUT = Path(os.getenv("INPUT", "/app/data/input.tif"))
OUT_DIR = Path(os.getenv("OUT_DIR", "/app/output"))
MIN_ZOOM = int(os.getenv("MIN_ZOOM", 14))
MAX_ZOOM = int(os.getenv("MAX_ZOOM", 22))

COG_PATH = OUT_DIR / "cog.tif"
TILES_DIR = OUT_DIR / "tiles"
VIEWER_DIR = Path(__file__).parent / "viewer"

# m/px at zoom 0 on the equator (Web Mercator, 256 px tiles)
ZOOM0_RES = 156543.03392804097

COG_OPTIONS = [
    "COMPRESS=DEFLATE",       # lossless
    "PREDICTOR=2",            # better compression for imagery, still lossless
    "BLOCKSIZE=512",
    "OVERVIEWS=AUTO",
    "RESAMPLING=NEAREST",
    "BIGTIFF=IF_SAFER",
    "NUM_THREADS=ALL_CPUS",
]


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def raster_info(path):
    ds = gdal.Open(str(path))
    srs = osr.SpatialReference(ds.GetProjection())
    srs.AutoIdentifyEPSG()
    epsg = srs.GetAuthorityCode(None)

    return {
        "file": path.name,
        "size_mb": round(path.stat().st_size / 1024**2, 1),
        "width": ds.RasterXSize,
        "height": ds.RasterYSize,
        "bands": ds.RasterCount,
        "crs": f"EPSG:{epsg}" if epsg else srs.GetName(),
        "pixel_size_m": round(ds.GetGeoTransform()[1], 4),
        "compression": ds.GetMetadataItem("COMPRESSION", "IMAGE_STRUCTURE") or "none",
        "layout": ds.GetMetadataItem("LAYOUT", "IMAGE_STRUCTURE") or "GeoTIFF",
        "checksums": [ds.GetRasterBand(b).Checksum() for b in range(1, ds.RasterCount + 1)],
    }


def validate_input(path):
    if not path.exists():
        sys.exit(f"input not found: {path}")

    ds = gdal.Open(str(path))
    if ds.RasterCount < 3:
        sys.exit(f"expected RGB, got {ds.RasterCount} band(s)")
    if not ds.GetProjection():
        sys.exit("input has no CRS")


def to_cog(src, dst):
    gdal.Translate(str(dst), str(src), format="COG", creationOptions=COG_OPTIONS)


def check_same_pixels(src, dst):
    """The COG must keep size, georeferencing and pixel values of the input."""
    a, b = gdal.Open(str(src)), gdal.Open(str(dst))

    if (a.RasterXSize, a.RasterYSize) != (b.RasterXSize, b.RasterYSize):
        raise ValueError("raster size changed")
    if a.GetGeoTransform() != b.GetGeoTransform():
        raise ValueError("geotransform changed")
    if not osr.SpatialReference(a.GetProjection()).IsSame(osr.SpatialReference(b.GetProjection())):
        raise ValueError("CRS changed")

    for band in range(1, a.RasterCount + 1):
        if a.GetRasterBand(band).Checksum() != b.GetRasterBand(band).Checksum():
            raise ValueError(f"pixel values changed in band {band}")


def native_zoom(path):
    """Zoom level whose resolution matches the image once warped to Web Mercator."""
    mercator = osr.SpatialReference()
    mercator.ImportFromEPSG(3857)
    warped = gdal.AutoCreateWarpedVRT(gdal.Open(str(path)), None, mercator.ExportToWkt())
    return math.log2(ZOOM0_RES / warped.GetGeoTransform()[1])


def make_tiles(cog, out_dir):
    shutil.rmtree(out_dir, ignore_errors=True)
    gdal2tiles.main([
        "gdal2tiles",
        "--xyz",
        f"--zoom={MIN_ZOOM}-{MAX_ZOOM}",
        "--resampling=near",
        "--webviewer=none",
        f"--processes={os.cpu_count() or 1}",
        "--quiet",
        str(cog),
        str(out_dir),
    ])


def count_tiles(tiles_dir):
    return {z: len(list((tiles_dir / str(z)).rglob("*.png"))) for z in range(MIN_ZOOM, MAX_ZOOM + 1)}


def wgs84_bounds(path):
    ring = gdal.Info(str(path), format="json")["wgs84Extent"]["coordinates"][0]
    lons, lats = zip(*ring)
    return [min(lats), min(lons), max(lats), max(lons)]


def main():
    start = time.time()
    timings = {}
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    log("checking input")
    validate_input(INPUT)
    src = raster_info(INPUT)
    log(f"{src['width']}x{src['height']} px, {src['bands']} bands, {src['crs']}, "
        f"{src['pixel_size_m']} m/px, {src['compression']}, {src['size_mb']} MB")

    log("converting to COG")
    t = time.time()
    to_cog(INPUT, COG_PATH)
    check_same_pixels(INPUT, COG_PATH)
    cog = raster_info(COG_PATH)
    timings["cog"] = round(time.time() - t, 1)
    log(f"cog.tif {cog['size_mb']} MB, pixels identical, checksums {cog['checksums']}")

    zoom = native_zoom(COG_PATH)
    log(f"native zoom {zoom:.1f}")
    if zoom < MAX_ZOOM - 0.5:
        log(f"zoom {math.ceil(zoom)}+ will be upsampled (no extra detail)")

    log(f"tiling zoom {MIN_ZOOM}-{MAX_ZOOM}")
    t = time.time()
    make_tiles(COG_PATH, TILES_DIR)
    tiles = count_tiles(TILES_DIR)
    timings["tiles"] = round(time.time() - t, 1)
    for z, n in tiles.items():
        log(f"  z{z}: {n}")
    log(f"  total: {sum(tiles.values())}")

    meta = {
        "bounds": wgs84_bounds(COG_PATH),
        "minZoom": MIN_ZOOM,
        "maxZoom": MAX_ZOOM,
        "nativeZoom": round(zoom, 2),
        "input": src,
        "cog": cog,
        "tiles": tiles,
        "timings": timings,
        "gdal": gdal.__version__,
        "created": time.strftime("%Y-%m-%d %H:%M"),
    }
    (OUT_DIR / "meta.json").write_text(json.dumps(meta, indent=2))
    shutil.copytree(VIEWER_DIR, OUT_DIR, dirs_exist_ok=True)

    log(f"done in {time.time() - start:.1f}s")


if __name__ == "__main__":
    main()
