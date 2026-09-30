const EARTH = 156543.03392;  // m/px at zoom 0, equator

function groundRes(z, lat) {
  return EARTH * Math.cos(lat * Math.PI / 180) / Math.pow(2, z);
}
function fmtRes(m) {
  return m < 1 ? (m * 100).toFixed(1) + " cm/px" : m.toFixed(2) + " m/px";
}

fetch("meta.json")
  .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
  .then(start)
  .catch(() => { document.getElementById("error").style.display = "grid"; });

function start(meta) {
  const b = meta.bounds;  // [south, west, north, east]
  const bounds = L.latLngBounds([b[0], b[1]], [b[2], b[3]]);
  const center = bounds.getCenter();
  const nativeZ = meta.nativeZoom;

  // map + layers
  const map = L.map("map", { minZoom: meta.minZoom, maxZoom: meta.maxZoom, zoomControl: true });

  const basemaps = {
    street: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxNativeZoom: 19, maxZoom: 22, attribution: "&copy; OpenStreetMap contributors"
    }),
    satellite: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxNativeZoom: 19, maxZoom: 22, attribution: "Satellite &copy; Esri"
    })
  };
  let currentBase = basemaps.street.addTo(map);

  map.createPane("drone");
  map.getPane("drone").style.zIndex = 450;
  const drone = L.tileLayer("tiles/{z}/{x}/{y}.png", {
    pane: "drone", minZoom: meta.minZoom, maxZoom: meta.maxZoom, bounds: bounds
  }).addTo(map);

  const grid = L.GridLayer.extend({
    createTile(c) {
      const d = document.createElement("div");
      d.className = "tile-grid";
      d.textContent = c.z + "/" + c.x + "/" + c.y;
      return d;
    }
  });
  const gridLayer = new grid({ zIndex: 500 });

  map.fitBounds(bounds);
  L.control.scale({ imperial: false }).addTo(map);

  // zoom panel
  const ladder = document.getElementById("ladder");
  for (let z = meta.minZoom; z <= meta.maxZoom; z++) {
    const btn = document.createElement("button");
    btn.textContent = z;
    btn.title = "Zoom " + z + ": " + fmtRes(groundRes(z, center.lat));
    if (z > nativeZ + 0.5) btn.classList.add("up");
    btn.onclick = () => map.setView(map.getCenter(), z);
    ladder.appendChild(btn);
  }

  function updateZoom() {
    const z = map.getZoom();
    document.getElementById("z").textContent = z;
    const r = groundRes(z, map.getCenter().lat);
    const up = z > nativeZ + 0.5;
    document.getElementById("res").innerHTML =
      "Screen: " + fmtRes(r) + " &nbsp;|&nbsp; image: " + fmtRes(meta.cog.pixel_size_m) +
      (up ? ' <span class="up">(upsampled)</span>' : "");
    [...ladder.children].forEach(btn => btn.classList.toggle("on", +btn.textContent === z));
  }
  map.on("zoomend", updateZoom);
  updateZoom();

  // background + opacity
  document.querySelectorAll("#basemaps button").forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll("#basemaps button").forEach(x => x.classList.remove("on"));
      btn.classList.add("on");
      if (currentBase) map.removeLayer(currentBase);
      currentBase = basemaps[btn.dataset.b] || null;
      if (currentBase) currentBase.addTo(map);
    };
  });

  const op = document.getElementById("opacity");
  op.oninput = () => {
    drone.setOpacity(op.value / 100);
    document.getElementById("opv").textContent = op.value + "%";
  };

  document.getElementById("grid").onchange = e => {
    e.target.checked ? gridLayer.addTo(map) : map.removeLayer(gridLayer);
  };

  // swipe compare
  // drone on the left of the line, satellite on the right
  const divider = document.getElementById("divider");
  const handle = document.getElementById("handle");
  const pane = map.getPane("drone");
  let split = 0.5, swipeOn = false, dragging = false;

  function clip() {
    if (!swipeOn) { pane.style.clip = ""; return; }
    const size = map.getSize();
    const x = size.x * split;
    const nw = map.containerPointToLayerPoint([0, 0]);
    const se = map.containerPointToLayerPoint(size);
    const cut = map.containerPointToLayerPoint([x, 0]).x;
    pane.style.clip = "rect(" + nw.y + "px," + cut + "px," + se.y + "px," + nw.x + "px)";
    divider.style.left = x + "px";
  }
  map.on("move zoom resize", clip);

  document.getElementById("swipe").onchange = e => {
    swipeOn = e.target.checked;
    divider.style.display = swipeOn ? "block" : "none";
    if (swipeOn) document.querySelector('#basemaps [data-b="satellite"]').click();
    clip();
  };

  handle.addEventListener("pointerdown", e => {
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    map.dragging.disable();
  });
  handle.addEventListener("pointermove", e => {
    if (!dragging) return;
    const rect = map.getContainer().getBoundingClientRect();
    split = Math.min(0.98, Math.max(0.02, (e.clientX - rect.left) / rect.width));
    clip();
  });
  handle.addEventListener("pointerup", () => { dragging = false; map.dragging.enable(); });


  // click tools: read pixel / measure
  let tool = "pixel";
  const result = document.getElementById("result");
  const clearBtn = document.getElementById("clear");
  const hints = {
    pixel: "Click on the drone image to read its RGB value.",
    distance: "Click points along a line. Each click adds a point.",
    area: "Click at least 3 points around a shape."
  };
  let pts = [], shape = null, markers = L.layerGroup().addTo(map);

  function resetMeasure() {
    pts = [];
    markers.clearLayers();
    if (shape) { map.removeLayer(shape); shape = null; }
    clearBtn.hidden = true;
    result.textContent = hints[tool];
  }

  document.querySelectorAll("#tools button").forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll("#tools button").forEach(x => x.classList.remove("on"));
      btn.classList.add("on");
      tool = btn.dataset.t;
      document.body.classList.toggle("measuring", tool !== "pixel");
      tool === "pixel" ? map.doubleClickZoom.enable() : map.doubleClickZoom.disable();
      map.closePopup();
      resetMeasure();
    };
  });
  clearBtn.onclick = resetMeasure;
  result.textContent = hints.pixel;

  function fmtLen(m) { return m < 1000 ? m.toFixed(2) + " m" : (m / 1000).toFixed(3) + " km"; }
  function fmtArea(m2) { return m2 < 10000 ? m2.toFixed(1) + " m²" : (m2 / 10000).toFixed(3) + " ha"; }

  // area on the sphere (same idea Leaflet.draw uses), good enough for a few hundred metres
  function geoArea(latlngs) {
    const R = 6378137, rad = Math.PI / 180;
    let a = 0;
    for (let k = 0; k < latlngs.length; k++) {
      const p1 = latlngs[k], p2 = latlngs[(k + 1) % latlngs.length];
      a += (p2.lng - p1.lng) * rad * (2 + Math.sin(p1.lat * rad) + Math.sin(p2.lat * rad));
    }
    return Math.abs(a * R * R / 2);
  }

  function measureClick(latlng) {
    pts.push(latlng);
    L.circleMarker(latlng, { radius: 4, color: "#fff", weight: 2, fillColor: "#1f6fb2", fillOpacity: 1 }).addTo(markers);
    if (shape) map.removeLayer(shape);
    const style = { color: "#ffd23f", weight: 3 };
    shape = tool === "area" && pts.length > 2
      ? L.polygon(pts, { ...style, fillOpacity: 0.2 }).addTo(map)
      : L.polyline(pts, style).addTo(map);
    clearBtn.hidden = false;

    let len = 0;
    for (let k = 1; k < pts.length; k++) len += map.distance(pts[k - 1], pts[k]);

    if (tool === "distance") {
      result.innerHTML = '<div class="big">' + fmtLen(len) + "</div>" + pts.length + " points";
    } else if (pts.length < 3) {
      result.textContent = "Add " + (3 - pts.length) + " more point" + (pts.length === 2 ? "" : "s") + ".";
    } else {
      const perim = len + map.distance(pts[pts.length - 1], pts[0]);
      result.innerHTML = '<div class="big">' + fmtArea(geoArea(pts)) + "</div>perimeter " + fmtLen(perim);
    }
  }

  // read the pixel from the PNG tile the browser already has
  function readPixel(latlng) {
    const z = Math.min(map.getZoom(), meta.maxZoom);
    const p = map.project(latlng, z);
    const tx = Math.floor(p.x / 256), ty = Math.floor(p.y / 256);
    const px = Math.floor(p.x - tx * 256), py = Math.floor(p.y - ty * 256);
    const path = "tiles/" + z + "/" + tx + "/" + ty + ".png";

    const img = new Image();
    img.onload = () => {
      const cv = document.createElement("canvas");
      cv.width = cv.height = 256;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const [r, g, b, a] = ctx.getImageData(px, py, 1, 1).data;
      if (a === 0) { showOutside(latlng); return; }
      const hex = "#" + [r, g, b].map(v => v.toString(16).padStart(2, "0")).join("");
      const html =
        '<div class="rgb"><span class="swatch" style="background:' + hex + '"></span>' +
        "<span>R " + r + "</span><span>G " + g + "</span><span>B " + b + "</span></div>" +
        latlng.lat.toFixed(7) + ", " + latlng.lng.toFixed(7) + "<br>" +
        "tile " + z + "/" + tx + "/" + ty + ", pixel (" + px + ", " + py + ")";
      result.innerHTML = html;
      L.popup().setLatLng(latlng).setContent(html).openOn(map);
    };
    img.onerror = () => showOutside(latlng);
    img.src = path;
  }

  function showOutside(latlng) {
    result.textContent = "No drone data here (outside the flight area).";
    L.popup().setLatLng(latlng).setContent("No drone data here").openOn(map);
  }

  map.on("click", e => {
    if (dragging) return;
    tool === "pixel" ? readPixel(e.latlng) : measureClick(e.latlng);
  });

  // misc
  document.getElementById("fit").onclick = () => map.fitBounds(bounds);
  map.on("mousemove", e => {
    document.getElementById("coords").textContent =
      e.latlng.lat.toFixed(6) + ", " + e.latlng.lng.toFixed(6);
  });

  // pipeline results
  const i = meta.input, c = meta.cog;
  document.getElementById("title").textContent = i.file;
  document.getElementById("place").textContent =
    center.lat.toFixed(4) + "°, " + center.lng.toFixed(4) + "°  |  processed " + meta.created;

  const same = JSON.stringify(i.checksums) === JSON.stringify(c.checksums);
  const rows = [
    ["File size", i.size_mb + " MB", c.size_mb + " MB"],
    ["Layout", i.layout, c.layout],
    ["Compression", i.compression, c.compression],
    ["Pixels", i.width + " × " + i.height, c.width + " × " + c.height],
    ["Pixel size", i.pixel_size_m + " m", c.pixel_size_m + " m"],
    ["CRS", i.crs, c.crs],
    ["Checksums", i.checksums.join(", "), c.checksums.join(", ")]
  ];
  document.getElementById("compare").innerHTML =
    "<thead><tr><th></th><th>Input</th><th>COG</th></tr></thead>" +
    rows.map(r => "<tr><th>" + r[0] + "</th><td>" + r[1] + "</td><td>" + r[2] + "</td></tr>").join("") +
    '<tr><th>Result</th><td colspan="2" class="' + (same ? "ok" : "bad") + '">' +
    (same ? "Pixel values identical" : "Pixel values differ") + "</td></tr>";

  const counts = meta.tiles;
  const max = Math.max(...Object.values(counts));
  const total = Object.values(counts).reduce((a, n) => a + n, 0);
  document.getElementById("bars").innerHTML = Object.entries(counts).map(([z, n]) =>
    "<span>z" + z + "</span><div class='bar' style='width:" + (n / max * 100) + "%'></div><span class='n'>" + n + "</span>"
  ).join("");
  document.getElementById("total").textContent =
    total + " tiles  |  COG " + meta.timings.cog + " s, tiling " + meta.timings.tiles + " s  |  GDAL " + meta.gdal;

  document.getElementById("credits").textContent =
    "Imagery: OpenAerialMap contributors, CC-BY 4.0. Native zoom of this image: " + nativeZ + ".";
}
