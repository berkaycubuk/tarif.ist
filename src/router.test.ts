import { describe, expect, it } from "vitest";
import type {
  BusLeg,
  RailLeg,
  TransferLeg,
  WalkLeg,
} from "./router";
import { findRoute } from "./router";
import type { Edge, StationNode, TransitGraph } from "./graph";

// --- Test fixture builders --------------------------------------------------
//
// We hand-construct tiny TransitGraphs instead of going through buildGraph().
// That gives each test full control over distances, transfer geometry, and
// line topology, with no dependence on the shipped GeoJSON.
//
// IMPORTANT: the router has two distance gates that shape these fixtures:
//   * MAX_WALK_M = 1500m — limit on the "nearest station" walk from src/dst
//   * MAX_DIRECT_WALK_M = 2500m — if start↔end is closer than this, a direct
//     walk leg is offered as a routing option (and usually wins for tiny
//     synthetic graphs). Tests that want to *force* rail/bus routing put
//     endpoints > 2.5km apart.
// At Istanbul's latitude, 0.01° lat ≈ 1.11km, so we use ~0.02° (~2.2km)
// between adjacent stations and place test endpoints to force transit use.

interface NodeSpec {
  id: string;
  mode?: "rail" | "bus";
  stationName: string;
  lineCode: string;
  kind?: string | null;
  lat: number;
  lng: number;
}

interface EdgeSpec {
  from: string;
  to: string;
  weightSec: number;
  kind: "rail" | "bus" | "transfer";
  lineCode?: string;
  distM: number;
}

function makeGraph(nodeSpecs: NodeSpec[], edgeSpecs: EdgeSpec[]): TransitGraph {
  const nodes = new Map<string, StationNode>();
  const edges = new Map<string, Edge[]>();
  const byLine = new Map<string, StationNode[]>();

  for (const n of nodeSpecs) {
    const node: StationNode = {
      id: n.id,
      mode: n.mode ?? "rail",
      stationName: n.stationName,
      lineCode: n.lineCode,
      kind: n.kind ?? "Metro",
      lat: n.lat,
      lng: n.lng,
      cumDistOnLine: 0,
    };
    nodes.set(n.id, node);
    edges.set(n.id, []);
    if (n.lineCode) {
      let arr = byLine.get(n.lineCode);
      if (!arr) {
        arr = [];
        byLine.set(n.lineCode, arr);
      }
      arr.push(node);
    }
  }

  for (const e of edgeSpecs) {
    edges.get(e.from)!.push({
      to: e.to,
      weightSec: e.weightSec,
      kind: e.kind,
      lineCode: e.lineCode,
      distM: e.distM,
    });
    edges.get(e.to)!.push({
      to: e.from,
      weightSec: e.weightSec,
      kind: e.kind,
      lineCode: e.lineCode,
      distM: e.distM,
    });
  }

  // Mirror the spatial-index build that buildGraph() does in production —
  // findNodesNear reads this and would otherwise see an empty index.
  const NEAREST_CELL_DEG = 0.02;
  const nearestIndex = new Map<string, StationNode[]>();
  for (const n of nodes.values()) {
    const key = `${Math.floor(n.lat / NEAREST_CELL_DEG)}|${Math.floor(n.lng / NEAREST_CELL_DEG)}`;
    let arr = nearestIndex.get(key);
    if (!arr) {
      arr = [];
      nearestIndex.set(key, arr);
    }
    arr.push(n);
  }

  return { nodes, edges, byLine, lineGeometry: new Map(), nearestIndex };
}

// --- Tests ------------------------------------------------------------------

describe("findRoute — basic shape", () => {
  it("returns null when stations and endpoints are all out of range", () => {
    // One short isolated line. Query is far from it AND endpoints are >2.5km
    // apart, so neither station routing nor walk-only fallback applies.
    const graph = makeGraph(
      [
        { id: "A#0", stationName: "A", lineCode: "A", lat: 41.0, lng: 29.0 },
        { id: "A#1", stationName: "B", lineCode: "A", lat: 41.02, lng: 29.0 },
      ],
      [{ from: "A#0", to: "A#1", weightSec: 60, kind: "rail", lineCode: "A", distM: 2220 }]
    );
    // Endpoints ~11km apart, far from any station.
    const route = findRoute(graph, { lat: 38.0, lng: 26.0 }, { lat: 38.1, lng: 26.0 });
    expect(route).toBeNull();
  });

  it("offers a direct walk leg when origin and destination are <2.5km apart with no stations nearby", () => {
    const graph = makeGraph(
      [{ id: "Z#0", stationName: "Z", lineCode: "Z", lat: 50.0, lng: 0.0 }],
      []
    );
    const start = { lat: 41.0, lng: 29.0 };
    const end = { lat: 41.005, lng: 29.0 }; // ~555m north
    const route = findRoute(graph, start, end)!;
    expect(route).not.toBeNull();
    expect(route.legs.length).toBe(1);
    const leg = route.legs[0] as WalkLeg;
    expect(leg.kind).toBe("walk");
    expect(leg.role).toBe("direct");
    expect(leg.distM).toBeGreaterThan(500);
    expect(leg.distM).toBeLessThan(600);
  });
});

describe("findRoute — single line", () => {
  // 4 stations spaced ~2.2km apart, total line length ~6.6km. Endpoints
  // exactly on the terminal stations are > MAX_DIRECT_WALK_M, so the router
  // must use the line rather than walking the whole trip.
  const stations: NodeSpec[] = [
    { id: "L#0", stationName: "L-0", lineCode: "L", lat: 41.000, lng: 29.0 },
    { id: "L#1", stationName: "L-1", lineCode: "L", lat: 41.020, lng: 29.0 },
    { id: "L#2", stationName: "L-2", lineCode: "L", lat: 41.040, lng: 29.0 },
    { id: "L#3", stationName: "L-3", lineCode: "L", lat: 41.060, lng: 29.0 },
  ];
  const railEdges: EdgeSpec[] = [];
  for (let i = 1; i < stations.length; i++) {
    railEdges.push({
      from: stations[i - 1].id,
      to: stations[i].id,
      weightSec: 120,
      kind: "rail",
      lineCode: "L",
      distM: 2220,
    });
  }
  const graph = makeGraph(stations, railEdges);

  it("routes end-to-end on the single line, visiting every station", () => {
    const route = findRoute(
      graph,
      { lat: 41.000, lng: 29.0 },
      { lat: 41.060, lng: 29.0 }
    )!;
    expect(route).not.toBeNull();

    const railLegs = route.legs.filter((l) => l.kind === "rail") as RailLeg[];
    expect(railLegs.length).toBe(1);
    expect(railLegs[0].lineCode).toBe("L");
    expect(railLegs[0].stations.map((s) => s.stationName)).toEqual([
      "L-0", "L-1", "L-2", "L-3",
    ]);
    expect(route.legs.some((l) => l.kind === "transfer")).toBe(false);
  });

  it("totalSec ≈ sum of leg durations", () => {
    const route = findRoute(
      graph,
      { lat: 41.000, lng: 29.0 },
      { lat: 41.060, lng: 29.0 }
    )!;
    const sum = route.legs.reduce((acc, l) => acc + l.durationSec, 0);
    expect(sum).toBeCloseTo(route.totalSec, 1);
  });
});

describe("findRoute — transfers", () => {
  // Two perpendicular rail lines that share a transfer point.
  //
  //   L1 (north–south at lng=29.00): S0 — S1 — S2 (spaced 0.02° lat)
  //   L2 (east–west at lat=41.02):   T0 — T1 — T2 (spaced 0.02° lng)
  //
  // S1 and T0 are at the same location → transfer edge between them.
  // Endpoints chosen so the router must use both lines (>2.5km direct walk).
  const nodes: NodeSpec[] = [
    { id: "L1#0", stationName: "S0", lineCode: "L1", lat: 41.000, lng: 29.000 },
    { id: "L1#1", stationName: "S1", lineCode: "L1", lat: 41.020, lng: 29.000 },
    { id: "L1#2", stationName: "S2", lineCode: "L1", lat: 41.040, lng: 29.000 },
    { id: "L2#0", stationName: "T0", lineCode: "L2", lat: 41.020, lng: 29.000 },
    { id: "L2#1", stationName: "T1", lineCode: "L2", lat: 41.020, lng: 29.020 },
    { id: "L2#2", stationName: "T2", lineCode: "L2", lat: 41.020, lng: 29.040 },
  ];
  const edges: EdgeSpec[] = [
    { from: "L1#0", to: "L1#1", weightSec: 120, kind: "rail", lineCode: "L1", distM: 2220 },
    { from: "L1#1", to: "L1#2", weightSec: 120, kind: "rail", lineCode: "L1", distM: 2220 },
    { from: "L2#0", to: "L2#1", weightSec: 120, kind: "rail", lineCode: "L2", distM: 1680 },
    { from: "L2#1", to: "L2#2", weightSec: 120, kind: "rail", lineCode: "L2", distM: 1680 },
    // Same-location transfer between S1 and T0
    { from: "L1#1", to: "L2#0", weightSec: 90, kind: "transfer", distM: 5 },
  ];
  const graph = makeGraph(nodes, edges);

  it("emits a transfer leg between two rail legs when switching lines", () => {
    const route = findRoute(
      graph,
      { lat: 41.000, lng: 29.000 }, // at S0
      { lat: 41.020, lng: 29.040 } // at T2
    )!;
    expect(route).not.toBeNull();

    const transferLegs = route.legs.filter((l) => l.kind === "transfer") as TransferLeg[];
    expect(transferLegs.length).toBe(1);
    expect(transferLegs[0].fromLineCode).toBe("L1");
    expect(transferLegs[0].toLineCode).toBe("L2");

    const railLegs = route.legs.filter((l) => l.kind === "rail") as RailLeg[];
    expect(railLegs.map((l) => l.lineCode)).toEqual(["L1", "L2"]);
  });
});

describe("findRoute — bus transfer headway", () => {
  // Two bus routes sharing a middle stop.
  //
  //   R1: P0 — P1 (shared)
  //   R2: P1 (shared) — P2
  //
  // Stops are spaced ~2.2km apart, total ~4.4km — beyond MAX_DIRECT_WALK_M,
  // beyond MAX_WALK_M from start/end except for the terminals.
  const nodes: NodeSpec[] = [
    { id: "P0", mode: "bus", stationName: "P0", lineCode: "", kind: "Bus", lat: 41.000, lng: 29.000 },
    { id: "P1", mode: "bus", stationName: "P1", lineCode: "", kind: "Bus", lat: 41.020, lng: 29.000 },
    { id: "P2", mode: "bus", stationName: "P2", lineCode: "", kind: "Bus", lat: 41.040, lng: 29.000 },
  ];
  const edges: EdgeSpec[] = [
    { from: "P0", to: "P1", weightSec: 240, kind: "bus", lineCode: "R1", distM: 2220 },
    { from: "P1", to: "P2", weightSec: 240, kind: "bus", lineCode: "R2", distM: 2220 },
  ];
  const graph = makeGraph(nodes, edges);

  it("yields two distinct bus legs when changing routes at a shared stop", () => {
    const route = findRoute(
      graph,
      { lat: 41.000, lng: 29.000 },
      { lat: 41.040, lng: 29.000 }
    )!;
    expect(route).not.toBeNull();

    const busLegs = route.legs.filter((l) => l.kind === "bus") as BusLeg[];
    expect(busLegs.length).toBe(2);
    expect(busLegs.map((l) => l.lineCode)).toEqual(["R1", "R2"]);
  });
});

describe("findRoute — transfer cost is honored", () => {
  // Two ways to get from start (at A) to end (at C):
  //   1. L1: A — B — C (two 120s rail hops, no transfer)
  //   2. L2: shortcut D — E (single fast 5s hop), but requires transfers
  //      A↔D and C↔E. D and E are placed > MAX_WALK_M from start/end so they
  //      are *only* reachable via transfer (not by walking from src/dst).
  //
  // With expensive transfers, L1 wins. With cheap transfers, L2 wins. Same
  // topology, only the transfer cost changes — isolates the router's
  // transfer-accounting behaviour.
  const baseNodes: NodeSpec[] = [
    { id: "L1#0", stationName: "A", lineCode: "L1", lat: 41.000, lng: 29.000 },
    { id: "L1#1", stationName: "B", lineCode: "L1", lat: 41.020, lng: 29.000 },
    { id: "L1#2", stationName: "C", lineCode: "L1", lat: 41.040, lng: 29.000 },
    // D and E sit east of L1, beyond MAX_WALK_M from the start/end points.
    { id: "L2#0", stationName: "D", lineCode: "L2", lat: 41.000, lng: 29.025 },
    { id: "L2#1", stationName: "E", lineCode: "L2", lat: 41.040, lng: 29.025 },
  ];
  const baseEdges = (transferSec: number): EdgeSpec[] => [
    { from: "L1#0", to: "L1#1", weightSec: 120, kind: "rail", lineCode: "L1", distM: 2220 },
    { from: "L1#1", to: "L1#2", weightSec: 120, kind: "rail", lineCode: "L1", distM: 2220 },
    { from: "L2#0", to: "L2#1", weightSec: 5, kind: "rail", lineCode: "L2", distM: 4440 },
    { from: "L1#0", to: "L2#0", weightSec: transferSec, kind: "transfer", distM: 2100 },
    { from: "L1#2", to: "L2#1", weightSec: transferSec, kind: "transfer", distM: 2100 },
  ];

  it("avoids the L2 shortcut when transfers are expensive", () => {
    const graph = makeGraph(baseNodes, baseEdges(1000));
    const route = findRoute(
      graph,
      { lat: 41.000, lng: 29.000 },
      { lat: 41.040, lng: 29.000 }
    )!;
    expect(route).not.toBeNull();
    const railLegs = route.legs.filter((l) => l.kind === "rail") as RailLeg[];
    expect(railLegs.length).toBe(1);
    expect(railLegs[0].lineCode).toBe("L1");
    expect(route.legs.some((l) => l.kind === "transfer")).toBe(false);
  });

  it("takes the L2 shortcut when transfers are cheap", () => {
    const graph = makeGraph(baseNodes, baseEdges(10));
    const route = findRoute(
      graph,
      { lat: 41.000, lng: 29.000 },
      { lat: 41.040, lng: 29.000 }
    )!;
    expect(route).not.toBeNull();
    const lineCodes = (route.legs.filter((l) => l.kind === "rail") as RailLeg[])
      .map((l) => l.lineCode);
    expect(lineCodes).toContain("L2");
    expect(route.legs.some((l) => l.kind === "transfer")).toBe(true);
  });
});
