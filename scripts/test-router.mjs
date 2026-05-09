// Smoke test for the routing engine. Loads the GeoJSONs from public/data,
// builds the graph, runs a few known-good queries, and prints the itinerary.
//
// Run: node scripts/test-router.mjs

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, "..", "public", "data");

// Inline copies of the relevant pure functions from src/graph.ts and
// src/router.ts. Keeping them here avoids depending on a TS toolchain.

const SPEED_BY_KIND = {
  Metro: 9.7,
  Marmaray: 16.7,
  Banliyö: 16.7,
  Tramvay: 5.0,
  Füniküler: 5.6,
  Teleferik: 2.8,
};
const DEFAULT_SPEED_MPS = 8;
const STATION_DWELL_SEC = 30;
const TRANSFER_DIST_M = 300;
const TRANSFER_HEADWAY_SEC = 90;
const WALK_SPEED_MPS = 1.4;
const MAX_WALK_M = 1500;
const NEAREST_K = 6;
const MAX_DIRECT_WALK_M = 2500;
const BOARDING_PENALTY_SEC = 180;
const VIRTUAL_SRC = "__SRC__";
const VIRTUAL_DST = "__DST__";

const EARTH_R = 6371000;
function toRad(d) { return (d * Math.PI) / 180; }
function haversineMeters(la1, lo1, la2, lo2) {
  const dLat = toRad(la2 - la1);
  const dLng = toRad(lo2 - lo1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(la1)) * Math.cos(toRad(la2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(a));
}
function flattenLine(geom) {
  if (geom.type === "LineString") return geom.coordinates;
  const parts = geom.coordinates;
  if (!parts.length) return [];
  if (parts.length === 1) return parts[0];

  // Chain MultiLineString parts greedily by endpoint proximity. The IBB data
  // sometimes orders parts arbitrarily; concatenating raw produces a path that
  // jumps around and breaks projection-based station ordering.
  const used = new Set([0]);
  const chain = [...parts[0]];
  while (used.size < parts.length) {
    const [tx, ty] = chain[chain.length - 1];
    let bestIdx = -1;
    let bestDist = Infinity;
    let reverse = false;
    for (let i = 0; i < parts.length; i++) {
      if (used.has(i)) continue;
      const p = parts[i];
      const dStart = haversineMeters(ty, tx, p[0][1], p[0][0]);
      const dEnd = haversineMeters(ty, tx, p[p.length - 1][1], p[p.length - 1][0]);
      if (dStart < bestDist) { bestDist = dStart; bestIdx = i; reverse = false; }
      if (dEnd < bestDist) { bestDist = dEnd; bestIdx = i; reverse = true; }
    }
    if (bestIdx < 0) break;
    used.add(bestIdx);
    const p = parts[bestIdx];
    const seq = reverse ? [...p].reverse() : p;
    // skip the first point if it duplicates the chain tail
    const startIdx = bestDist < 1 ? 1 : 0;
    for (let k = startIdx; k < seq.length; k++) chain.push(seq[k]);
  }
  return chain;
}

function twoOptPath(annotated) {
  // Improves a candidate ordering toward the shortest Hamiltonian path by
  // repeatedly reversing sub-ranges where doing so shortens the path.
  // For station sets that lie ~linearly (which Istanbul rail lines do), this
  // converges to the correct geographic order regardless of the initial guess.
  const a = [...annotated];
  const n = a.length;
  if (n < 4) return a;
  const distAt = (i, j) => haversineMeters(a[i].lat, a[i].lng, a[j].lat, a[j].lng);
  const reverse = (i, j) => { while (i < j) { [a[i], a[j]] = [a[j], a[i]]; i++; j--; } };
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const oldLeft = i > 0 ? distAt(i - 1, i) : 0;
        const oldRight = j < n - 1 ? distAt(j, j + 1) : 0;
        // After reversing a[i..j]: i becomes (was j), j becomes (was i)
        const tmpI = a[i], tmpJ = a[j];
        // Compute newLeft using the post-reverse adjacency
        const newLeft = i > 0 ? haversineMeters(a[i-1].lat, a[i-1].lng, tmpJ.lat, tmpJ.lng) : 0;
        const newRight = j < n - 1 ? haversineMeters(tmpI.lat, tmpI.lng, a[j+1].lat, a[j+1].lng) : 0;
        if (oldLeft + oldRight - newLeft - newRight > 1e-6) {
          reverse(i, j);
          improved = true;
        }
      }
    }
  }
  return a;
}
function buildLineGeometry(geom) {
  const path = flattenLine(geom);
  const cum = new Float64Array(path.length);
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = path[i - 1];
    const [bx, by] = path[i];
    total += haversineMeters(ay, ax, by, bx);
    cum[i] = total;
  }
  return { path, cum };
}
function projectPointOntoLine(lng, lat, geom) {
  const { path, cum } = geom;
  let bestCum = 0; let bestDist = Infinity;
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = path[i - 1];
    const [bx, by] = path[i];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = 0;
    if (len2 > 1e-18) {
      t = ((lng - ax) * dx + (lat - ay) * dy) / len2;
      if (t < 0) t = 0; else if (t > 1) t = 1;
    }
    const cx = ax + t * dx, cy = ay + t * dy;
    const dist = haversineMeters(lat, lng, cy, cx);
    if (dist < bestDist) {
      bestDist = dist;
      const segLen = cum[i] - cum[i - 1];
      bestCum = cum[i - 1] + t * segLen;
    }
  }
  return { cumDist: bestCum, minDist: bestDist };
}
function speedForKind(k) { return (k && SPEED_BY_KIND[k]) || DEFAULT_SPEED_MPS; }

function buildGraph(data) {
  const stationsByLine = new Map();
  for (const f of data.stations.features) {
    const c = f.properties.lineCode; if (!c) continue;
    if (!stationsByLine.has(c)) stationsByLine.set(c, []);
    stationsByLine.get(c).push(f);
  }
  const lineFeatureByCode = new Map();
  for (const f of data.lines.features) {
    const c = f.properties.lineCode; if (!c) continue;
    lineFeatureByCode.set(c, f);
  }
  const nodes = new Map(); const edges = new Map(); const byLine = new Map();
  for (const [code, stations] of stationsByLine) {
    const lf = lineFeatureByCode.get(code);
    let annotated = stations.map((f) => {
      const [lng, lat] = f.geometry.coordinates;
      return { f, lng, lat, proj: { cumDist: 0, minDist: 0 } };
    });
    if (lf) {
      const geom = buildLineGeometry(lf.geometry);
      for (const a of annotated) a.proj = projectPointOntoLine(a.lng, a.lat, geom);
      annotated.sort((x, y) => x.proj.cumDist - y.proj.cumDist);
    }
    annotated = twoOptPath(annotated);
    const lineNodes = annotated.map((a, i) => ({
      id: `${code}#${i}`,
      stationName: a.f.properties.name,
      lineCode: code,
      kind: a.f.properties.kind,
      lat: a.lat, lng: a.lng,
      cumDistOnLine: a.proj.cumDist,
    }));
    for (const n of lineNodes) { nodes.set(n.id, n); edges.set(n.id, []); }
    byLine.set(code, lineNodes);
    for (let i = 1; i < lineNodes.length; i++) {
      const a = lineNodes[i-1], b = lineNodes[i];
      const distM = haversineMeters(a.lat, a.lng, b.lat, b.lng);
      const w = distM / speedForKind(a.kind) + STATION_DWELL_SEC;
      edges.get(a.id).push({ to: b.id, weightSec: w, kind: "rail", lineCode: code, distM });
      edges.get(b.id).push({ to: a.id, weightSec: w, kind: "rail", lineCode: code, distM });
    }
  }
  const all = [...nodes.values()];
  let transferCount = 0;
  for (let i = 0; i < all.length; i++) {
    for (let j = i+1; j < all.length; j++) {
      const a = all[i], b = all[j];
      if (a.lineCode === b.lineCode) continue;
      const d = haversineMeters(a.lat, a.lng, b.lat, b.lng);
      if (d > TRANSFER_DIST_M) continue;
      const w = d / WALK_SPEED_MPS + TRANSFER_HEADWAY_SEC;
      edges.get(a.id).push({ to: b.id, weightSec: w, kind: "transfer", distM: d });
      edges.get(b.id).push({ to: a.id, weightSec: w, kind: "transfer", distM: d });
      transferCount++;
    }
  }
  return { nodes, edges, byLine, transferCount };
}

class MinHeap {
  constructor(cmp) { this.data = []; this.cmp = cmp; }
  get size() { return this.data.length; }
  push(v) { this.data.push(v); this.up(this.data.length-1); }
  pop() {
    if (!this.data.length) return undefined;
    const t = this.data[0]; const l = this.data.pop();
    if (this.data.length) { this.data[0] = l; this.down(0); }
    return t;
  }
  up(i) { while (i > 0) { const p = (i-1)>>1; if (this.cmp(this.data[i], this.data[p]) >= 0) break; [this.data[i], this.data[p]] = [this.data[p], this.data[i]]; i = p; } }
  down(i) { const n = this.data.length; for (;;) { const l = 2*i+1, r = 2*i+2; let s = i; if (l < n && this.cmp(this.data[l], this.data[s]) < 0) s = l; if (r < n && this.cmp(this.data[r], this.data[s]) < 0) s = r; if (s === i) break; [this.data[i], this.data[s]] = [this.data[s], this.data[i]]; i = s; } }
}

function nearest(graph, p, k, max) {
  const arr = [];
  for (const n of graph.nodes.values()) {
    const d = haversineMeters(p.lat, p.lng, n.lat, n.lng);
    if (d <= max) arr.push({ node: n, distM: d });
  }
  arr.sort((a, b) => a.distM - b.distM);
  return arr.slice(0, k);
}

function findRoute(graph, start, end) {
  const startN = nearest(graph, start, NEAREST_K, MAX_WALK_M);
  const endN = nearest(graph, end, NEAREST_K, MAX_WALK_M);
  if (!startN.length && !endN.length) return null;
  const startEdges = startN.map(n => ({ to: n.node.id, weightSec: n.distM/WALK_SPEED_MPS + BOARDING_PENALTY_SEC, kind: "walk", distM: n.distM }));
  const endByStation = new Map(endN.map(n => [n.node.id, n.distM]));
  const directD = haversineMeters(start.lat, start.lng, end.lat, end.lng);
  if (directD <= MAX_DIRECT_WALK_M) {
    startEdges.push({ to: VIRTUAL_DST, weightSec: directD/WALK_SPEED_MPS, kind: "walk", distM: directD });
  }
  const dist = new Map([[VIRTUAL_SRC, 0]]); const prev = new Map();
  const heap = new MinHeap((a, b) => a.dist - b.dist);
  heap.push({ id: VIRTUAL_SRC, dist: 0 });
  while (heap.size) {
    const cur = heap.pop();
    if (cur.dist > (dist.get(cur.id) ?? Infinity)) continue;
    if (cur.id === VIRTUAL_DST) break;
    const out = [];
    if (cur.id === VIRTUAL_SRC) out.push(...startEdges);
    else {
      const real = graph.edges.get(cur.id) ?? [];
      for (const e of real) out.push(e);
      const w = endByStation.get(cur.id);
      if (w !== undefined) out.push({ to: VIRTUAL_DST, weightSec: w/WALK_SPEED_MPS, kind: "walk", distM: w });
    }
    for (const e of out) {
      const next = cur.dist + e.weightSec;
      if (next < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, next); prev.set(e.to, { from: cur.id, edge: e });
        heap.push({ id: e.to, dist: next });
      }
    }
  }
  const total = dist.get(VIRTUAL_DST);
  if (total === undefined) return null;
  const trail = [];
  let c = VIRTUAL_DST;
  while (c !== VIRTUAL_SRC) { const p = prev.get(c); trail.unshift(p); c = p.from; }
  return { totalSec: total, trail };
}

function format(graph, route) {
  if (!route) return "  (no route)";
  const lines = [`  total: ${(route.totalSec/60).toFixed(1)} min`];
  for (const { from, edge } of route.trail) {
    const fn = graph.nodes.get(from)?.stationName ?? from;
    const tn = graph.nodes.get(edge.to)?.stationName ?? edge.to;
    lines.push(`    ${edge.kind.padEnd(8)} ${fn} → ${tn}  (${edge.lineCode ?? ""}, ${(edge.weightSec/60).toFixed(1)} min, ${edge.distM.toFixed(0)} m)`);
  }
  return lines.join("\n");
}

const stations = JSON.parse(await readFile(resolve(dataDir, "stations.geojson"), "utf8"));
const lines = JSON.parse(await readFile(resolve(dataDir, "lines.geojson"), "utf8"));
const data = { stations, lines };

console.log(`stations: ${stations.features.length}, lines: ${lines.features.length}`);

const stationCodes = new Map();
for (const f of stations.features) {
  const c = f.properties.lineCode ?? "?";
  stationCodes.set(c, (stationCodes.get(c) ?? 0) + 1);
}
const lineCodes = new Map();
for (const f of lines.features) {
  const c = f.properties.lineCode ?? "?";
  lineCodes.set(c, (lineCodes.get(c) ?? 0) + 1);
}
console.log("station codes:", [...stationCodes.entries()].sort().map(([k,v]) => `${k}=${v}`).join(", "));
console.log("line codes:   ", [...lineCodes.entries()].sort().map(([k,v]) => `${k}=${v}`).join(", "));
const graph = buildGraph(data);
const totalEdges = [...graph.edges.values()].reduce((n, a) => n + a.length, 0) / 2;
console.log(`graph: ${graph.nodes.size} nodes, ${totalEdges} edges, ${graph.transferCount} transfer pairs`);
console.log("");

console.log("line codes in graph:", [...graph.byLine.keys()].sort().join(", "));
// Sanity: list a few stations per line in sorted order
for (const code of ["M2", "M1A", "Marmaray", "T1"]) {
  const ns = graph.byLine.get(code);
  if (!ns) { console.log(`${code}: (missing from graph)`); continue; }
  console.log(`${code} (${ns.length}): ${ns.slice(0, 4).map(n => n.stationName).join(" → ")} … ${ns.slice(-3).map(n => n.stationName).join(" → ")}`);
}
console.log("");

const queries = [
  { name: "Taksim → Levent (both M2)", start: { lat: 41.0370, lng: 28.9858 }, end: { lat: 41.0828, lng: 29.0094 } },
  { name: "Sultanahmet → Kadıköy (T1 → Marmaray)", start: { lat: 41.0058, lng: 28.9769 }, end: { lat: 40.9923, lng: 29.0244 } },
  { name: "Atatürk Havalimanı → Taksim (M1A → M2)", start: { lat: 40.9760, lng: 28.8200 }, end: { lat: 41.0370, lng: 28.9858 } },
  { name: "Yenikapı → Yenikapı (same point)", start: { lat: 41.0040, lng: 28.9512 }, end: { lat: 41.0040, lng: 28.9512 } },
];
for (const q of queries) {
  console.log(`▶ ${q.name}`);
  const r = findRoute(graph, q.start, q.end);
  console.log(format(graph, r));
  console.log("");
}
