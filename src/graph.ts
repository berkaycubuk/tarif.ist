// Builds a routable graph from the IBB rail GeoJSON we ship in /public/data.
//
// Approach:
//   1. For each line, project every station onto that line's polyline geometry.
//      The "cumulative-distance-along-path" of each projection gives a 1D
//      ordering (small turns + branches collapse cleanly because lines like
//      M1A vs M1B are stored as separate features in our trimmed data).
//   2. Connect consecutive stations along the line with rail edges, weighted
//      in seconds based on great-circle distance and a per-mode average speed.
//   3. Connect stations of different lines that sit within ~300m with transfer
//      edges, weighted as walking time + a small headway penalty.
//
// Edge weights are seconds. Distances are meters.

import type { Feature, LineString, MultiLineString, Point } from "geojson";
import type { LineProps, StationProps, TransitData } from "./transit";
import {
  haversineMeters,
  buildLineGeometry,
  projectPointOntoLine,
  type LineGeometry,
} from "./geo";

// --- Tunables ---------------------------------------------------------------

// Average operating speed (m/s) per `HAT_TURU` value.
//   Metro    35 km/h ≈ 9.7 m/s
//   Marmaray 60 km/h ≈ 16.7 m/s  (suburban heavy rail)
//   Banliyö  60 km/h ≈ 16.7 m/s
//   Tramvay  18 km/h ≈ 5.0 m/s
//   Füniküler 20 km/h ≈ 5.6 m/s
//   Teleferik 10 km/h ≈ 2.8 m/s
const SPEED_BY_KIND: Record<string, number> = {
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
const TRANSFER_HEADWAY_SEC = 90; // half of typical 3-min headway
const WALK_SPEED_MPS = 1.4;

// IETT buses run at ~15 km/h average in Istanbul traffic (slower than rail
// even on bus-only lanes). Headways vary but are typically much wider than
// rail, so the per-edge dwell is small but transfers TO a bus pay a bigger
// headway penalty.
const BUS_SPEED_MPS = 4.2;
const BUS_DWELL_SEC = 20;
/** Avg wait time when transferring onto a bus (typical headway ~10 min). */
const BUS_TRANSFER_HEADWAY_SEC = 300;

// --- Types ------------------------------------------------------------------

export type NodeMode = "rail" | "bus";

export interface StationNode {
  id: string;
  mode: NodeMode;
  stationName: string;
  /** Rail station's line code; bus stop's empty string (a stop serves many routes). */
  lineCode: string;
  kind: string | null;
  lat: number;
  lng: number;
  /** cumulative meters along this line's polyline at the station's projection */
  cumDistOnLine: number;
}

export type EdgeKind = "rail" | "bus" | "transfer";

export interface Edge {
  to: string;
  weightSec: number;
  kind: EdgeKind;
  lineCode?: string;
  /** physical distance in meters (for display) */
  distM: number;
}

export interface TransitGraph {
  nodes: Map<string, StationNode>;
  edges: Map<string, Edge[]>;
  /** ordered station list per line code (start → end) */
  byLine: Map<string, StationNode[]>;
  /** flattened polyline + cumulative distance per line */
  lineGeometry: Map<string, LineGeometry>;
}

// --- Accessor helpers — callers use these instead of raw Map operations ------

export function getNode(
  graph: TransitGraph,
  id: string
): StationNode | undefined {
  return graph.nodes.get(id);
}

export function getEdges(graph: TransitGraph, id: string): Edge[] {
  return graph.edges.get(id) ?? [];
}

export function getLineStations(
  graph: TransitGraph,
  code: string
): StationNode[] | undefined {
  return graph.byLine.get(code);
}

export function getLineGeometry(
  graph: TransitGraph,
  code: string
): LineGeometry | undefined {
  return graph.lineGeometry.get(code);
}

// Re-export for callers that only import from graph
export { haversineMeters, sliceLine, type LineGeometry } from "./geo";

// --- Graph construction -----------------------------------------------------

function speedForKind(kind: string | null | undefined): number {
  if (!kind) return DEFAULT_SPEED_MPS;
  return SPEED_BY_KIND[kind] ?? DEFAULT_SPEED_MPS;
}

/**
 * 2-opt refinement: repeatedly reverse sub-ranges of an ordering when doing so
 * produces a shorter total path through the points. For station sets that lie
 * approximately on a 1D curve (which Istanbul rail lines do), this converges
 * to the geographically-correct order, even if the initial guess is poor or
 * the line geometry is missing entirely.
 */
function twoOptOrder<T extends { lat: number; lng: number }>(
  arr: T[]
): T[] {
  const a = arr.slice();
  const n = a.length;
  if (n < 4) return a;
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const oldLeft =
          i > 0 ? haversineMeters(a[i - 1].lat, a[i - 1].lng, a[i].lat, a[i].lng) : 0;
        const oldRight =
          j < n - 1 ? haversineMeters(a[j].lat, a[j].lng, a[j + 1].lat, a[j + 1].lng) : 0;
        const newLeft =
          i > 0 ? haversineMeters(a[i - 1].lat, a[i - 1].lng, a[j].lat, a[j].lng) : 0;
        const newRight =
          j < n - 1 ? haversineMeters(a[i].lat, a[i].lng, a[j + 1].lat, a[j + 1].lng) : 0;
        if (oldLeft + oldRight - newLeft - newRight > 1e-6) {
          let l = i;
          let r = j;
          while (l < r) {
            const tmp = a[l];
            a[l] = a[r];
            a[r] = tmp;
            l++;
            r--;
          }
          improved = true;
        }
      }
    }
  }
  return a;
}

// -- buildGraph sub-steps ----------------------------------------------------

/** Group GeoJSON station features by line code. */
function groupStationsByLine(
  stations: Feature<Point, StationProps>[]
): Map<string, Feature<Point, StationProps>[]> {
  const byLine = new Map<string, Feature<Point, StationProps>[]>();
  for (const f of stations) {
    const code = f.properties.lineCode;
    if (!code) continue;
    let arr = byLine.get(code);
    if (!arr) {
      arr = [];
      byLine.set(code, arr);
    }
    arr.push(f);
  }
  return byLine;
}

/** Index line features by code for fast lookups. */
function indexLinesByCode(
  lines: Feature<LineString | MultiLineString, LineProps>[]
): Map<string, Feature<LineString | MultiLineString, LineProps>> {
  const byCode = new Map();
  for (const f of lines) {
    const code = f.properties.lineCode;
    if (!code) continue;
    byCode.set(code, f);
  }
  return byCode;
}

/** Build the ordered list of StationNodes for one line. */
function buildLineNodes(
  code: string,
  stations: Feature<Point, StationProps>[],
  lineFeature: Feature<LineString | MultiLineString, LineProps> | undefined,
  lineGeometryStore: Map<string, LineGeometry>
): StationNode[] {
  let geom: LineGeometry | undefined;
  if (lineFeature) {
    geom = buildLineGeometry(lineFeature.geometry);
    if (geom.path.length >= 2) {
      lineGeometryStore.set(code, geom);
    } else {
      geom = undefined;
    }
  }

  type Annotated = {
    f: Feature<Point, StationProps>;
    lat: number;
    lng: number;
    cumDist: number;
  };

  let annotated: Annotated[] = stations.map((f) => {
    const [lng, lat] = f.geometry.coordinates;
    let cumDist = 0;
    if (geom) {
      cumDist = projectPointOntoLine(lng, lat, geom).cumDist;
    }
    return { f, lat, lng, cumDist };
  });

  if (geom) annotated.sort((a, b) => a.cumDist - b.cumDist);
  annotated = twoOptOrder(annotated);

  return annotated.map((a, i) => ({
    id: `${code}#${i}`,
    mode: "rail" as const,
    stationName: a.f.properties.name,
    lineCode: code,
    kind: a.f.properties.kind,
    lat: a.lat,
    lng: a.lng,
    cumDistOnLine: a.cumDist,
  }));
}

/** Add bidirectional rail edges between consecutive stations on a line. */
function addRailEdges(
  edges: Map<string, Edge[]>,
  lineNodes: StationNode[],
  code: string
): void {
  for (let i = 1; i < lineNodes.length; i++) {
    const a = lineNodes[i - 1];
    const b = lineNodes[i];
    const distM = haversineMeters(a.lat, a.lng, b.lat, b.lng);
    const speed = speedForKind(a.kind);
    const weightSec = distM / speed + STATION_DWELL_SEC;
    edges
      .get(a.id)!
      .push({ to: b.id, weightSec, kind: "rail", lineCode: code, distM });
    edges
      .get(b.id)!
      .push({ to: a.id, weightSec, kind: "rail", lineCode: code, distM });
  }
}

/** Add transfer edges between close stations on different lines (O(n²)). */
function addTransferEdges(
  nodes: Map<string, StationNode>,
  edges: Map<string, Edge[]>
): void {
  const all = [...nodes.values()];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i];
      const b = all[j];
      if (a.lineCode === b.lineCode) continue;
      const d = haversineMeters(a.lat, a.lng, b.lat, b.lng);
      if (d > TRANSFER_DIST_M) continue;
      const weightSec = d / WALK_SPEED_MPS + TRANSFER_HEADWAY_SEC;
      edges.get(a.id)!.push({ to: b.id, weightSec, kind: "transfer", distM: d });
      edges.get(b.id)!.push({ to: a.id, weightSec, kind: "transfer", distM: d });
    }
  }
}

// --- Bus integration --------------------------------------------------------

export interface BusSegmentData {
  /** stopId → { lat, lng, name } */
  stops: Record<string, { lat: number; lng: number; name: string }>;
  /** ordered stop sequence per route */
  routes: Array<{ code: string; longName: string; stops: string[] }>;
}

function busNodeId(stopId: string): string {
  return `bus#${stopId}`;
}

/** Add a node for every stop *referenced by some route* and an edge for every
 *  consecutive pair in each route's stop sequence. */
function addBusNodesAndEdges(
  nodes: Map<string, StationNode>,
  edges: Map<string, Edge[]>,
  byLine: Map<string, StationNode[]>,
  data: BusSegmentData
): void {
  const referenced = new Set<string>();
  for (const route of data.routes) {
    for (const id of route.stops) referenced.add(id);
  }
  for (const stopId of referenced) {
    const s = data.stops[stopId];
    if (!s) continue;
    const id = busNodeId(stopId);
    nodes.set(id, {
      id,
      mode: "bus",
      stationName: s.name,
      lineCode: "",
      kind: "Bus",
      lat: s.lat,
      lng: s.lng,
      cumDistOnLine: 0,
    });
    edges.set(id, []);
  }

  for (const route of data.routes) {
    const lineNodes: StationNode[] = [];
    for (const id of route.stops) {
      const node = nodes.get(busNodeId(id));
      if (node) lineNodes.push(node);
    }
    if (lineNodes.length >= 2) byLine.set(route.code, lineNodes);

    for (let i = 1; i < route.stops.length; i++) {
      const a = nodes.get(busNodeId(route.stops[i - 1]));
      const b = nodes.get(busNodeId(route.stops[i]));
      if (!a || !b) continue;
      const distM = haversineMeters(a.lat, a.lng, b.lat, b.lng);
      const weightSec = distM / BUS_SPEED_MPS + BUS_DWELL_SEC;
      edges.get(a.id)!.push({
        to: b.id,
        weightSec,
        kind: "bus",
        lineCode: route.code,
        distM,
      });
      edges.get(b.id)!.push({
        to: a.id,
        weightSec,
        kind: "bus",
        lineCode: route.code,
        distM,
      });
    }
  }
}

/** Add walking-transfer edges between rail and bus nodes within range, using
 *  a coarse grid index so the cost stays manageable (rail ~600, bus ~11k). */
function addRailBusTransferEdges(
  nodes: Map<string, StationNode>,
  edges: Map<string, Edge[]>
): void {
  // 0.005° ≈ 555m at Istanbul's latitude — large enough that any rail node's
  // 300m neighborhood is fully covered by its own cell + the 8 around it.
  const CELL = 0.005;
  const cellKey = (lat: number, lng: number) =>
    `${Math.floor(lat / CELL)}|${Math.floor(lng / CELL)}`;

  const bins = new Map<string, StationNode[]>();
  for (const n of nodes.values()) {
    if (n.mode !== "bus") continue;
    const key = cellKey(n.lat, n.lng);
    let arr = bins.get(key);
    if (!arr) {
      arr = [];
      bins.set(key, arr);
    }
    arr.push(n);
  }

  for (const rail of nodes.values()) {
    if (rail.mode !== "bus") {
      // rail node — search the 9 cells around it for nearby bus stops
    } else {
      continue;
    }
    const baseLat = Math.floor(rail.lat / CELL);
    const baseLng = Math.floor(rail.lng / CELL);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = bins.get(`${baseLat + dy}|${baseLng + dx}`);
        if (!arr) continue;
        for (const bus of arr) {
          const d = haversineMeters(rail.lat, rail.lng, bus.lat, bus.lng);
          if (d > TRANSFER_DIST_M) continue;
          const walkSec = d / WALK_SPEED_MPS;
          // Asymmetric: transferring TO a bus pays the bigger headway,
          // arriving at rail uses the regular rail headway.
          edges.get(rail.id)!.push({
            to: bus.id,
            weightSec: walkSec + BUS_TRANSFER_HEADWAY_SEC,
            kind: "transfer",
            distM: d,
          });
          edges.get(bus.id)!.push({
            to: rail.id,
            weightSec: walkSec + TRANSFER_HEADWAY_SEC,
            kind: "transfer",
            distM: d,
          });
        }
      }
    }
  }
}

// --- Main entry point -------------------------------------------------------

export function buildGraph(
  data: TransitData,
  busData?: BusSegmentData | null
): TransitGraph {
  const stationsByLine = groupStationsByLine(data.stations.features);
  const lineFeatureByCode = indexLinesByCode(data.lines.features);

  const nodes = new Map<string, StationNode>();
  const edges = new Map<string, Edge[]>();
  const byLine = new Map<string, StationNode[]>();
  const lineGeometry = new Map<string, LineGeometry>();

  for (const [code, stations] of stationsByLine) {
    const lineFeature = lineFeatureByCode.get(code);
    const lineNodes = buildLineNodes(code, stations, lineFeature, lineGeometry);

    for (const n of lineNodes) {
      nodes.set(n.id, n);
      edges.set(n.id, []);
    }
    byLine.set(code, lineNodes);
    addRailEdges(edges, lineNodes, code);
  }

  addTransferEdges(nodes, edges);

  if (busData) {
    addBusNodesAndEdges(nodes, edges, byLine, busData);
    addRailBusTransferEdges(nodes, edges);
  }

  return { nodes, edges, byLine, lineGeometry };
}
