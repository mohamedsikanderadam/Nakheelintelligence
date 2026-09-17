const Z = 18;                 // ~0.55 m/px in the UAE
const GRID = 3;               // 3x3 tiles = 768 px ≈ 420 m ≈ 17.7 ha
const TILE = 256;
const IMAGERY = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

const LOCATIONS = {
  liwa:   { center: [23.1340, 53.7700], zoom: 17, stress: "liwa" },
  dhaid:  { center: [25.2900, 55.8700], zoom: 17, stress: "dhaid" },
  alfoah: { center: [24.3215, 55.7530], zoom: 17, stress: null },
};

// Indicative farm-gate assumptions for the demo (kg per productive palm, AED per kg). Not measured.
const VARIETIES = {
  khalas: { kg: 60, price: 8.0 },
  lulu:   { kg: 50, price: 7.0 },
  fard:   { kg: 55, price: 5.0 },
  barhi:  { kg: 70, price: 9.0 },
  mixed:  { kg: 55, price: 6.5 },
};
const SALEABLE = 0.85;

const $ = (id) => document.getElementById(id);

const map = L.map("map", { zoomControl: false, attributionControl: false }).setView(LOCATIONS.liwa.center, 17);
L.tileLayer(IMAGERY, { maxZoom: 19 }).addTo(map);
L.control.zoom({ position: "topright" }).addTo(map);

const canvasRenderer = L.canvas({ padding: 0.5 });
let scanBox = L.rectangle(map.getBounds(), { color: "#f0c060", weight: 2, fill: false, className: "scanbox" }).addTo(map);
let palmLayer = L.layerGroup().addTo(map);
let stressLayer = null;
let stressMeta = null;
let ndmiImages = {};
let currentLoc = "liwa";
let lastScan = null;

fetch("data/stress.json").then((r) => r.json()).then((m) => (stressMeta = m));

// --- tile maths --------------------------------------------------------------
function lonLatToTile(lat, lon, z) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const latR = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n;
  return { x, y };
}
function tileToLonLat(x, y, z) {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return { lat, lon };
}
function scanTiles() {
  const c = map.getCenter();
  const t = lonLatToTile(c.lat, c.lng, Z);
  const r = Math.floor(GRID / 2);
  const x0 = Math.floor(t.x) - r, y0 = Math.floor(t.y) - r;
  const nw = tileToLonLat(x0, y0, Z), se = tileToLonLat(x0 + GRID, y0 + GRID, Z);
  return { x0, y0, bounds: L.latLngBounds([se.lat, nw.lon], [nw.lat, se.lon]) };
}
function updateBox() { scanBox.setBounds(scanTiles().bounds); }
map.on("move", updateBox);
updateBox();

// --- palm detector (same algorithm as palmtest/count.py) ---------------------
function gaussianKernel(sigma) {
  const r = Math.ceil(sigma * 3), k = [];
  let s = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); s += v; }
  return { k: k.map((v) => v / s), r };
}
function blur(src, w, h, sigma) {
  const { k, r } = gaussianKernel(sigma);
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let i = -r; i <= r; i++) { const xx = Math.min(w - 1, Math.max(0, x + i)); acc += src[y * w + xx] * k[i + r]; }
    tmp[y * w + x] = acc;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let i = -r; i <= r; i++) { const yy = Math.min(h - 1, Math.max(0, y + i)); acc += tmp[yy * w + x] * k[i + r]; }
    out[y * w + x] = acc;
  }
  return out;
}
// Label 4-connected components of a boolean mask; returns labels and per-label pixel area.
function labelComponents(mask, w, h) {
  const lbl = new Int32Array(w * h), area = [0];
  const stack = [];
  let next = 1;
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || lbl[i]) continue;
    lbl[i] = next; stack.push(i); let a = 0;
    while (stack.length) {
      const p = stack.pop(); a++;
      const x = p % w, y = (p - x) / w;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of nb) if (q >= 0 && mask[q] && !lbl[q]) { lbl[q] = next; stack.push(q); }
    }
    area.push(a); next++;
  }
  return { lbl, area };
}

// Palm crowns are dark blobs (~4-6 m) on bright sand. Steps: (1) dark-vs-local-background mask,
// (2) keep components sized like crowns/canopy clusters, (3) difference-of-Gaussians peaks inside them.
const DARK_THR = 18, MIN_AREA = 12, MAX_AREA = 2500, DOG_THR = 8;
function detectPalms(imgData, w, h) {
  const d = imgData.data, n = w * h;
  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  const g1 = blur(gray, w, h, 1.0), bg = blur(gray, w, h, 10);
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = bg[i] - g1[i] > DARK_THR ? 1 : 0;
  const { lbl, area } = labelComponents(mask, w, h);
  const g15 = blur(gray, w, h, 1.5), g5 = blur(gray, w, h, 5);
  const dog = new Float32Array(n);
  for (let i = 0; i < n; i++) dog[i] = g5[i] - g15[i];
  const pts = [];
  const R = 3;
  for (let y = R; y < h - R; y++) for (let x = R; x < w - R; x++) {
    const i = y * w + x, v = dog[i];
    if (v <= DOG_THR || !lbl[i]) continue;
    const a = area[lbl[i]];
    if (a < MIN_AREA || a > MAX_AREA) continue;
    let isMax = true;
    for (let dy = -R; dy <= R && isMax; dy++) for (let dx = -R; dx <= R; dx++) {
      if ((dx || dy) && dog[(y + dy) * w + (x + dx)] > v) { isMax = false; break; }
    }
    if (isMax) pts.push([x, y, Math.min(1, v / 40)]);
  }
  return pts;
}

// --- scan --------------------------------------------------------------------
function setProgress(p, msg) { $("progress").firstElementChild.style.width = `${Math.round(p * 100)}%`; if (msg) $("status").textContent = msg; }

async function loadTile(x, y) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => res(img);
    img.onerror = () => rej(new Error(`tile ${x},${y}`));
    img.src = IMAGERY.replace("{z}", Z).replace("{x}", x).replace("{y}", y);
  });
}

async function scan() {
  const btn = $("scan");
  btn.disabled = true;
  palmLayer.clearLayers();
  const { x0, y0, bounds } = scanTiles();
  const size = GRID * TILE;
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d");
  let done = 0;
  const jobs = [];
  for (let dy = 0; dy < GRID; dy++) for (let dx = 0; dx < GRID; dx++) {
    jobs.push(loadTile(x0 + dx, y0 + dy).then((img) => { ctx.drawImage(img, dx * TILE, dy * TILE); setProgress(++done / (GRID * GRID) * 0.6, `Fetching imagery… ${done}/${GRID * GRID} tiles`); }));
  }
  try { await Promise.all(jobs); } catch (e) { setProgress(0, "Imagery unavailable here at 0.5 m — try another farm."); btn.disabled = false; return; }

  setProgress(0.7, "Running palm detector…");
  await new Promise((r) => setTimeout(r, 30));
  const pts = detectPalms(ctx.getImageData(0, 0, size, size), size, size);

  setProgress(0.9, "Rendering…");
  const mPerPx = (156543.03 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / 2 ** Z;
  const ha = (size * mPerPx) ** 2 / 1e4;
  for (const [px, py, v] of pts) {
    const ll = tileToLonLat(x0 + px / TILE, y0 + py / TILE, Z);
    L.circleMarker([ll.lat, ll.lon], { renderer: canvasRenderer, radius: 3.5, color: v > 0.45 ? "#ff3b3b" : "#ffd23b", weight: 1.2, fill: false }).addTo(palmLayer);
  }
  const stress = await stressIndex(bounds);
  lastScan = { count: pts.length, ha, stress };
  renderResults();
  setProgress(1, `Done · ${pts.length} palms in ${ha.toFixed(1)} ha (${mPerPx.toFixed(2)} m/px).`);
  btn.disabled = false;
}

// --- Sentinel-2 stress -------------------------------------------------------
function loadImage(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; }); }
async function stressIndex(bounds) {
  const key = LOCATIONS[currentLoc].stress;
  if (!key || !stressMeta) return null;
  if (!ndmiImages[key]) {
    const img = await loadImage(`data/${key}_ndmi.png`);
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    c.getContext("2d").drawImage(img, 0, 0);
    ndmiImages[key] = { data: c.getContext("2d").getImageData(0, 0, img.width, img.height), w: img.width, h: img.height };
  }
  const { data, w, h } = ndmiImages[key];
  const [[s, wl], [n, e]] = stressMeta[key].bounds;
  const px = (lon) => Math.round(((lon - wl) / (e - wl)) * w), py = (lat) => Math.round(((n - lat) / (n - s)) * h);
  const x0 = Math.max(0, px(bounds.getWest())), x1 = Math.min(w, px(bounds.getEast()));
  const y0 = Math.max(0, py(bounds.getNorth())), y1 = Math.min(h, py(bounds.getSouth()));
  let sum = 0, cnt = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * w + x) * 4;
    if (data.data[i + 3] > 0) { sum += data.data[i] / 255 - 0.5; cnt++; }
  }
  if (!cnt) return null;
  return { ndmi: sum / cnt, median: stressMeta[key].median_ndmi, vegPx: cnt };
}
function toggleStress(on) {
  if (stressLayer) { map.removeLayer(stressLayer); stressLayer = null; }
  $("legend").hidden = !on;
  const key = LOCATIONS[currentLoc].stress;
  if (!on || !key || !stressMeta) { if (on) $("stress-toggle").checked = false; return; }
  stressLayer = L.imageOverlay(`data/${key}_stress.png`, stressMeta[key].bounds, { opacity: 0.75, interactive: false }).addTo(map);
}

// --- results -----------------------------------------------------------------
const fmt = (n, d = 0) => n.toLocaleString("en-AE", { maximumFractionDigits: d });
function renderResults() {
  if (!lastScan) return;
  const { count, ha, stress } = lastScan;
  const prod = Number($("productive").value) / 100;
  const v = VARIETIES[$("variety").value];
  const palms = count * prod;
  const t = (k) => (palms * k * SALEABLE) / 1000;
  const tons = [t(v.kg * 0.7), t(v.kg), t(v.kg * 1.25)];
  const rev = [tons[0] * 1000 * v.price * 0.75, tons[1] * 1000 * v.price, tons[2] * 1000 * v.price * 1.4];
  $("results").hidden = false;
  $("k-palms").textContent = fmt(count);
  $("k-ha").textContent = fmt(ha, 1);
  $("k-density").textContent = fmt(count / ha);
  if (stress) {
    const d = stress.ndmi - stress.median;
    $("k-stress").textContent = `${stress.ndmi.toFixed(2)} ${d < -0.03 ? "▼ stressed" : d > 0.03 ? "▲ well‑watered" : "· normal"}`;
  } else $("k-stress").textContent = "n/a here";
  ["lo", "base", "hi"].forEach((k, i) => { $(`t-${k}`).textContent = fmt(tons[i], 1); $(`r-${k}`).textContent = fmt(rev[i]); });
  $("assumptions").textContent = `${fmt(palms)} productive palms × ${v.kg} kg (±) × ${SALEABLE * 100}% saleable × AED ${v.price}/kg farm‑gate (indicative). Replace with the farm's Al Foah receipts for a calibrated forecast.`;
}

// --- UI wiring ---------------------------------------------------------------
document.querySelectorAll(".presets button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".presets button").forEach((x) => x.classList.remove("active"));
  b.classList.add("active");
  currentLoc = b.dataset.loc;
  const loc = LOCATIONS[currentLoc];
  map.setView(loc.center, loc.zoom);
  palmLayer.clearLayers();
  $("results").hidden = true;
  toggleStress($("stress-toggle").checked);
}));
document.querySelector('.presets button[data-loc="liwa"]').classList.add("active");
$("scan").addEventListener("click", scan);
$("variety").addEventListener("change", renderResults);
$("productive").addEventListener("input", () => { $("productive-v").textContent = `${$("productive").value}%`; renderResults(); });
$("stress-toggle").addEventListener("change", (e) => toggleStress(e.target.checked));
$("start").addEventListener("click", () => { $("intro").remove(); map.invalidateSize(); });
