# cog-to-tiles

GeoTIFF → Cloud Optimized GeoTIFF → XYZ tiles (zoom 14–22), using GDAL in a single Docker container.
Pixel values and resolution are preserved.

**Live demo:** https://cog-to-tiles.netlify.app

## Run

Put an RGB GeoTIFF at `data/input.tif`, then:

```
docker compose up --build
```

Open http://localhost:8080 when the log says `done`.

## Pipeline

1. Validate input (exists, ≥3 bands, has CRS)
2. Convert to COG: DEFLATE + PREDICTOR=2, 512 px blocks, nearest-neighbour overviews
3. Check the COG against the input: size, geotransform, CRS and per-band checksums must match
4. Tile with `gdal2tiles --xyz --zoom=14-22 --resampling=near`
5. Write `meta.json` and copy the viewer into `output/`

```
output/
├── cog.tif
├── tiles/{z}/{x}/{y}.png
├── meta.json
└── index.html, app.js, style.css
```

## Design notes

| Choice | Reason |
|---|---|
| COG before tiling | Internal blocks + overviews, fast windowed reads |
| DEFLATE | Lossless. JPEG/WEBP would change pixel values |
| Nearest neighbour | Reprojection to Web Mercator creates no new pixel values |
| PNG tiles | Lossless, transparent outside the image footprint |
| XYZ (`--xyz`) | gdal2tiles defaults to TMS; Leaflet expects XYZ |
| Pinned GDAL image | Same result on every machine |
| Data as a read-only volume | Any GeoTIFF without rebuilding, input never modified |
| Static tiles | No tile server needed; for many images a dynamic tiler (TiTiler) would fit better |

## Test data

Drone orthophoto, 2.5 cm/px, EPSG:32615, from [OpenAerialMap](https://openaerialmap.org) (CC-BY 4.0).

| | Input | COG |
|---|---|---|
| Size | 19.6 MB | 133.8 MB |
| Compression | JPEG (lossy) | DEFLATE (lossless) |
| Checksums | 15228, 50005, 5205 | 15228, 50005, 5205 |

1,884 tiles, native zoom ≈ 22.3. The COG is larger because the input was lossy JPEG and the output is lossless.

## Settings

| Env var | Default |
|---|---|
| `INPUT` | `/app/data/input.tif` |
| `OUT_DIR` | `/app/output` |
| `MIN_ZOOM` | `14` |
| `MAX_ZOOM` | `22` |
