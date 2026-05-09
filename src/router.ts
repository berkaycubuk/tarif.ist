// Dijkstra shortest-path on the transit graph, with virtual source/destination
// nodes that represent the user's start and end coordinates. Walk edges connect
// the virtual nodes to the K closest stations within MAX_WALK_M.

import type { EdgeKind, StationNode, TransitGraph } from "./graph";
import { getNode, getEdges, haversineMeters } from "./graph";

const WALK_SPEED_MPS = 1.4;
const MAX_WALK_M = 1500;
const NEAREST_K = 6;
/** If the trip is shorter than this, we also offer "just walk it" as an option. */
const MAX_DIRECT_WALK_M = 2500;
/** One-time cost of stepping onto a transit line (typical wait). */
const BOARDING_PENALTY_SEC = 180;

export const VIRTUAL_SRC = "__SRC__";
export const VIRTUAL_DST = "__DST__";

export interface QueryPoint {
  lat: number;
  lng: number;
}

export type StepKind = "walk" | "rail" | "transfer";

export interface RailLeg {
  kind: "rail";
  lineCode: string;
  fromName: string;
  toName: string;
  /** ordered station nodes traversed (inclusive of board + alight) */
  stations: StationNode[];
  durationSec: number;
  distM: number;
}

export interface TransferLeg {
  kind: "transfer";
  fromName: string;
  toName: string;
  fromLineCode: string;
  toLineCode: string;
  fromLatLng: [number, number];
  toLatLng: [number, number];
  durationSec: number;
  distM: number;
}

export interface WalkLeg {
  kind: "walk";
  /** "origin" = from start point to first station,
   *  "egress" = from last station to end point,
   *  "direct" = whole trip on foot */
  role: "origin" | "egress" | "direct";
  fromLatLng: [number, number];
  toLatLng: [number, number];
  toName?: string;
  fromName?: string;
  durationSec: number;
  distM: number;
}

export type RouteLeg = RailLeg | TransferLeg | WalkLeg;

export interface Route {
  legs: RouteLeg[];
  totalSec: number;
  totalWalkM: number;
  totalRailM: number;
}

// --- Min-heap ---------------------------------------------------------------

class MinHeap<T> {
  private data: T[] = [];
  private cmp: (a: T, b: T) => number;
  constructor(cmp: (a: T, b: T) => number) {
    this.cmp = cmp;
  }
  get size(): number {
    return this.data.length;
  }
  push(v: T): void {
    this.data.push(v);
    this.up(this.data.length - 1);
  }
  pop(): T | undefined {
    if (!this.data.length) return undefined;
    const top = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length) {
      this.data[0] = last;
      this.down(0);
    }
    return top;
  }
  private up(i: number): void {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cmp(this.data[i], this.data[p]) >= 0) break;
      [this.data[i], this.data[p]] = [this.data[p], this.data[i]];
      i = p;
    }
  }
  private down(i: number): void {
    const n = this.data.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let s = i;
      if (l < n && this.cmp(this.data[l], this.data[s]) < 0) s = l;
      if (r < n && this.cmp(this.data[r], this.data[s]) < 0) s = r;
      if (s === i) break;
      [this.data[i], this.data[s]] = [this.data[s], this.data[i]];
      i = s;
    }
  }
}

// --- Routing ----------------------------------------------------------------

function findNearestStations(
  graph: TransitGraph,
  point: QueryPoint,
  k: number,
  maxDist: number
): Array<{ node: StationNode; distM: number }> {
  const arr: Array<{ node: StationNode; distM: number }> = [];
  for (const node of graph.nodes.values()) {
    const d = haversineMeters(point.lat, point.lng, node.lat, node.lng);
    if (d <= maxDist) arr.push({ node, distM: d });
  }
  arr.sort((a, b) => a.distM - b.distM);
  return arr.slice(0, k);
}

interface VirtualEdge {
  to: string;
  weightSec: number;
  kind: EdgeKind | "walk";
  lineCode?: string;
  distM: number;
}

interface PrevEntry {
  from: string;
  edge: VirtualEdge;
}

export function findRoute(
  graph: TransitGraph,
  start: QueryPoint,
  end: QueryPoint
): Route | null {
  const startNeighbors = findNearestStations(graph, start, NEAREST_K, MAX_WALK_M);
  const endNeighbors = findNearestStations(graph, end, NEAREST_K, MAX_WALK_M);

  if (!startNeighbors.length && !endNeighbors.length) {
    const direct = haversineMeters(start.lat, start.lng, end.lat, end.lng);
    if (direct <= MAX_DIRECT_WALK_M) {
      return walkOnlyRoute(start, end, direct);
    }
    return null;
  }

  // Adjacency lookup: for any node id we either return graph edges or, for the
  // virtuals, synthesized walk edges. Edges *into* VIRTUAL_DST are appended at
  // each station that's an end-neighbor.
  const startEdges: VirtualEdge[] = startNeighbors.map((n) => ({
    to: n.node.id,
    weightSec: n.distM / WALK_SPEED_MPS + BOARDING_PENALTY_SEC,
    kind: "walk",
    distM: n.distM,
  }));
  const endWalkByStation = new Map<string, number>();
  for (const n of endNeighbors) endWalkByStation.set(n.node.id, n.distM);

  // Optional direct-walk shortcut
  const directWalkDist = haversineMeters(start.lat, start.lng, end.lat, end.lng);
  if (directWalkDist <= MAX_DIRECT_WALK_M) {
    startEdges.push({
      to: VIRTUAL_DST,
      weightSec: directWalkDist / WALK_SPEED_MPS,
      kind: "walk",
      distM: directWalkDist,
    });
  }

  const dist = new Map<string, number>();
  const prev = new Map<string, PrevEntry>();
  dist.set(VIRTUAL_SRC, 0);

  const heap = new MinHeap<{ id: string; dist: number }>(
    (a, b) => a.dist - b.dist
  );
  heap.push({ id: VIRTUAL_SRC, dist: 0 });

  while (heap.size > 0) {
    const cur = heap.pop()!;
    const known = dist.get(cur.id);
    if (known !== undefined && cur.dist > known) continue;
    if (cur.id === VIRTUAL_DST) break;

    const outEdges: VirtualEdge[] = [];
    if (cur.id === VIRTUAL_SRC) {
      outEdges.push(...startEdges);
    } else {
      for (const e of getEdges(graph, cur.id)) {
        outEdges.push(e as VirtualEdge);
      }
      const walkToDst = endWalkByStation.get(cur.id);
      if (walkToDst !== undefined) {
        outEdges.push({
          to: VIRTUAL_DST,
          weightSec: walkToDst / WALK_SPEED_MPS,
          kind: "walk",
          distM: walkToDst,
        });
      }
    }

    for (const e of outEdges) {
      const next = cur.dist + e.weightSec;
      const prevBest = dist.get(e.to);
      if (prevBest === undefined || next < prevBest) {
        dist.set(e.to, next);
        prev.set(e.to, { from: cur.id, edge: e });
        heap.push({ id: e.to, dist: next });
      }
    }
  }

  const total = dist.get(VIRTUAL_DST);
  if (total === undefined) return null;

  // Reconstruct the path
  const trail: PrevEntry[] = [];
  let cursor = VIRTUAL_DST;
  while (cursor !== VIRTUAL_SRC) {
    const p = prev.get(cursor);
    if (!p) return null;
    trail.unshift(p);
    cursor = p.from;
  }

  return buildRouteFromTrail(graph, start, end, trail, total);
}

function buildRouteFromTrail(
  graph: TransitGraph,
  start: QueryPoint,
  end: QueryPoint,
  trail: PrevEntry[],
  totalSec: number
): Route {
  const legs: RouteLeg[] = [];
  let totalWalkM = 0;
  let totalRailM = 0;

  let i = 0;

  // Origin walk edge (from VIRTUAL_SRC)
  if (trail.length && trail[0].from === VIRTUAL_SRC) {
    const first = trail[0];
    if (first.edge.to === VIRTUAL_DST) {
      // Walk-only trip.
      legs.push({
        kind: "walk",
        role: "direct",
        fromLatLng: [start.lat, start.lng],
        toLatLng: [end.lat, end.lng],
        durationSec: first.edge.weightSec,
        distM: first.edge.distM,
      });
      totalWalkM += first.edge.distM;
      return { legs, totalSec, totalWalkM, totalRailM };
    }
    const station = getNode(graph, first.edge.to);
    legs.push({
      kind: "walk",
      role: "origin",
      fromLatLng: [start.lat, start.lng],
      toLatLng: station ? [station.lat, station.lng] : [start.lat, start.lng],
      toName: station?.stationName,
      durationSec: first.edge.weightSec,
      distM: first.edge.distM,
    });
    totalWalkM += first.edge.distM;
    i = 1;
  }

  while (i < trail.length) {
    const step = trail[i];
    const edge = step.edge;

    if (edge.kind === "rail") {
      const lineCode = edge.lineCode!;
      const startNode = getNode(graph, step.from);
      const stations: StationNode[] = startNode ? [startNode] : [];
      let durationSec = 0;
      let distM = 0;
      let lastTo = edge.to;
      while (
        i < trail.length &&
        trail[i].edge.kind === "rail" &&
        trail[i].edge.lineCode === lineCode
      ) {
        const e = trail[i].edge;
        durationSec += e.weightSec;
        distM += e.distM;
        const toNode = getNode(graph, e.to);
        if (toNode) stations.push(toNode);
        lastTo = e.to;
        i++;
      }
      const finalNode = getNode(graph, lastTo);
      legs.push({
        kind: "rail",
        lineCode,
        fromName: stations[0]?.stationName ?? "?",
        toName: finalNode?.stationName ?? stations[stations.length - 1]?.stationName ?? "?",
        stations,
        durationSec,
        distM,
      });
      totalRailM += distM;
      continue;
    }

    if (edge.kind === "transfer") {
      const fromNode = getNode(graph, step.from);
      const toNode = getNode(graph, edge.to);
      legs.push({
        kind: "transfer",
        fromName: fromNode?.stationName ?? "?",
        toName: toNode?.stationName ?? "?",
        fromLineCode: fromNode?.lineCode ?? "",
        toLineCode: toNode?.lineCode ?? "",
        fromLatLng: fromNode ? [fromNode.lat, fromNode.lng] : [0, 0],
        toLatLng: toNode ? [toNode.lat, toNode.lng] : [0, 0],
        durationSec: edge.weightSec,
        distM: edge.distM,
      });
      totalWalkM += edge.distM;
      i++;
      continue;
    }

    // walk
    if (edge.kind === "walk") {
      if (edge.to === VIRTUAL_DST) {
        const fromNode = getNode(graph, step.from);
        legs.push({
          kind: "walk",
          role: "egress",
          fromLatLng: fromNode ? [fromNode.lat, fromNode.lng] : [end.lat, end.lng],
          toLatLng: [end.lat, end.lng],
          fromName: fromNode?.stationName,
          durationSec: edge.weightSec,
          distM: edge.distM,
        });
        totalWalkM += edge.distM;
      }
      i++;
      continue;
    }

    i++;
  }

  return { legs, totalSec, totalWalkM, totalRailM };
}

function walkOnlyRoute(start: QueryPoint, end: QueryPoint, distM: number): Route {
  const sec = distM / WALK_SPEED_MPS;
  return {
    legs: [
      {
        kind: "walk",
        role: "direct",
        fromLatLng: [start.lat, start.lng],
        toLatLng: [end.lat, end.lng],
        durationSec: sec,
        distM,
      },
    ],
    totalSec: sec,
    totalWalkM: distM,
    totalRailM: 0,
  };
}
