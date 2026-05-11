import { describe, expect, it } from "vitest";
import type {
  Feature,
  FeatureCollection,
  LineString,
  MultiLineString,
  Point,
} from "geojson";
import { buildGraph, type BusSegmentData } from "./graph";
import type { LineProps, StationProps, TransitData } from "./transit";

// --- Tiny GeoJSON builders --------------------------------------------------
//
// buildGraph is fed real GeoJSON FeatureCollections. These helpers construct
// the minimal shape it needs (no extra IBB properties, just the fields the
// graph builder actually reads).

type StationFeature = Feature<Point, StationProps>;
type LineFeature = Feature<LineString | MultiLineString, LineProps>;

function station(
  name: string,
  lineCode: string | null,
  lng: number,
  lat: number,
  kind: string | null = "Metro"
): StationFeature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lng, lat] },
    properties: {
      name,
      lineName: lineCode ?? "?",
      lineCode,
      kind,
    },
  };
}

function rail(
  lineCode: string | null,
  coords: Array<[number, number]>,
  kind: string | null = "Metro"
): LineFeature {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: coords },
    properties: {
      name: lineCode ?? "?",
      shortName: lineCode ?? "?",
      lineCode,
      kind,
      lengthKm: null,
      stationCount: null,
    },
  };
}

function transitData(
  stations: StationFeature[],
  lines: LineFeature[]
): TransitData {
  const stationsFC: FeatureCollection<Point, StationProps> = {
    type: "FeatureCollection",
    features: stations,
  };
  const linesFC: FeatureCollection<
    LineString | MultiLineString,
    LineProps
  > = {
    type: "FeatureCollection",
    features: lines,
  };
  return { stations: stationsFC, lines: linesFC };
}

// --- Tests ------------------------------------------------------------------

describe("buildGraph — empty / degenerate", () => {
  it("returns empty maps for empty inputs", () => {
    const g = buildGraph(transitData([], []));
    expect(g.nodes.size).toBe(0);
    expect(g.edges.size).toBe(0);
    expect(g.byLine.size).toBe(0);
    expect(g.lineGeometry.size).toBe(0);
  });

  it("ignores stations without a lineCode", () => {
    const g = buildGraph(
      transitData(
        [
          station("Orphan", null, 29.0, 41.0),
          station("Real", "L", 29.0, 41.0),
        ],
        [rail("L", [[29.0, 41.0], [29.0, 41.02]])]
      )
    );
    // Only the lineCode-bearing station became a node.
    expect(g.nodes.size).toBe(1);
    expect([...g.nodes.values()][0].stationName).toBe("Real");
  });
});

describe("buildGraph — single line", () => {
  // Three stations along a meridian segment, fed deliberately *out of order*
  // to verify the polyline projection step sorts them along the line.
  const stations: StationFeature[] = [
    station("Middle", "L", 29.0, 41.020),
    station("North",  "L", 29.0, 41.040),
    station("South",  "L", 29.0, 41.000),
  ];
  const lines: LineFeature[] = [
    rail("L", [[29.0, 41.000], [29.0, 41.020], [29.0, 41.040]]),
  ];
  const g = buildGraph(transitData(stations, lines));

  it("creates one node per station, ordered along the line", () => {
    expect(g.nodes.size).toBe(3);
    const ordered = g.byLine.get("L")!;
    expect(ordered.map((n) => n.stationName)).toEqual(["South", "Middle", "North"]);
  });

  it("assigns stable IDs of the form `<lineCode>#<index>`", () => {
    const ordered = g.byLine.get("L")!;
    expect(ordered.map((n) => n.id)).toEqual(["L#0", "L#1", "L#2"]);
  });

  it("creates bidirectional rail edges between consecutive stations only", () => {
    const fromMid = g.edges.get("L#1")!;
    // L#1 has two rail neighbours (L#0 and L#2); no edge to itself.
    const railNeighbors = fromMid
      .filter((e) => e.kind === "rail")
      .map((e) => e.to)
      .sort();
    expect(railNeighbors).toEqual(["L#0", "L#2"]);

    // Endpoints have exactly one rail neighbour each.
    expect(g.edges.get("L#0")!.filter((e) => e.kind === "rail").map((e) => e.to))
      .toEqual(["L#1"]);
    expect(g.edges.get("L#2")!.filter((e) => e.kind === "rail").map((e) => e.to))
      .toEqual(["L#1"]);
  });

  it("rail edges carry the originating lineCode and a positive duration", () => {
    const e = g.edges.get("L#0")!.find((x) => x.kind === "rail")!;
    expect(e.lineCode).toBe("L");
    expect(e.weightSec).toBeGreaterThan(0);
    expect(e.distM).toBeGreaterThan(2000); // ~2.2 km between adjacent stations
    expect(e.distM).toBeLessThan(2500);
  });

  it("stores polyline geometry for the line", () => {
    const geom = g.lineGeometry.get("L")!;
    expect(geom).toBeDefined();
    expect(geom.path.length).toBe(3);
    expect(geom.totalLengthM).toBeGreaterThan(0);
  });
});

describe("buildGraph — speed differs by kind", () => {
  // Metro = 9.7 m/s, Marmaray = 16.7 m/s. Same distance → Marmaray edge is
  // faster (lower weightSec). We don't pin exact values (they'd be brittle if
  // dwell/speed constants change), just the *ordering*.
  const metroData = transitData(
    [
      station("A", "M", 29.0, 41.000, "Metro"),
      station("B", "M", 29.0, 41.020, "Metro"),
    ],
    [rail("M", [[29.0, 41.000], [29.0, 41.020]], "Metro")]
  );
  const marmarayData = transitData(
    [
      station("A", "Mr", 29.0, 41.000, "Marmaray"),
      station("B", "Mr", 29.0, 41.020, "Marmaray"),
    ],
    [rail("Mr", [[29.0, 41.000], [29.0, 41.020]], "Marmaray")]
  );

  it("Marmaray is faster than Metro across the same distance", () => {
    const metroG = buildGraph(metroData);
    const marmarayG = buildGraph(marmarayData);
    const metroEdge = metroG.edges.get("M#0")!.find((e) => e.kind === "rail")!;
    const marmarayEdge = marmarayG.edges.get("Mr#0")!.find((e) => e.kind === "rail")!;
    expect(marmarayEdge.weightSec).toBeLessThan(metroEdge.weightSec);
    // distM should be ~equal (same coords)
    expect(marmarayEdge.distM).toBeCloseTo(metroEdge.distM, 6);
  });
});

describe("buildGraph — transfer edges", () => {
  // Two perpendicular lines that intersect near (41.020, 29.000). The
  // closest cross-line pair (S1 ↔ T0) sits ~85m apart — inside the 300m
  // transfer radius — and gets a transfer edge. Other pairs are >300m and
  // get nothing.
  const stations: StationFeature[] = [
    station("S0", "L1", 29.000, 41.000),
    station("S1", "L1", 29.000, 41.020),
    station("S2", "L1", 29.000, 41.040),
    // T0 is *just* east of S1 — within 300m
    station("T0", "L2", 29.001, 41.020),
    station("T1", "L2", 29.020, 41.020),
    station("T2", "L2", 29.040, 41.020),
  ];
  const lines: LineFeature[] = [
    rail("L1", [[29.000, 41.000], [29.000, 41.040]]),
    rail("L2", [[29.001, 41.020], [29.040, 41.020]]),
  ];
  const g = buildGraph(transitData(stations, lines));

  it("connects S1 and T0 with a bidirectional transfer edge", () => {
    const s1ToT0 = g.edges.get("L1#1")!.filter((e) => e.kind === "transfer");
    const t0ToS1 = g.edges.get("L2#0")!.filter((e) => e.kind === "transfer");

    expect(s1ToT0.length).toBe(1);
    expect(s1ToT0[0].to).toBe("L2#0");
    expect(s1ToT0[0].distM).toBeLessThan(300);

    expect(t0ToS1.length).toBe(1);
    expect(t0ToS1[0].to).toBe("L1#1");
  });

  it("does not connect far-apart cross-line stations", () => {
    // S0 (41.000, 29.000) and T2 (41.020, 29.040) are several km apart.
    const s0Transfers = g.edges.get("L1#0")!.filter((e) => e.kind === "transfer");
    expect(s0Transfers.length).toBe(0);
  });

  it("does not create transfer edges between stations on the same line", () => {
    // S0 and S1 are 2.2km apart — outside transfer range — but also same line.
    // Even a contrived close-but-same-line pair would be filtered.
    for (const id of ["L1#0", "L1#1", "L1#2"]) {
      const transfersToSameLine = g.edges
        .get(id)!
        .filter((e) => e.kind === "transfer" && e.to.startsWith("L1#"));
      expect(transfersToSameLine.length).toBe(0);
    }
  });
});

describe("buildGraph — bus integration", () => {
  // Two rail-ish stations on line "L" plus a small bus network with two
  // routes that share one stop. A rail station sits within 300m of one bus
  // stop, producing a rail↔bus transfer.
  const stations: StationFeature[] = [
    station("Rail-A", "L", 29.000, 41.000),
    station("Rail-B", "L", 29.000, 41.020),
  ];
  const lines: LineFeature[] = [
    rail("L", [[29.000, 41.000], [29.000, 41.020]]),
  ];

  const busData: BusSegmentData = {
    stops: {
      // s1 is ~85m east of Rail-A → rail↔bus transfer
      s1: { lat: 41.000, lng: 29.001, name: "Bus-Near-RailA" },
      s2: { lat: 41.010, lng: 29.001, name: "Mid-Stop" },
      s3: { lat: 41.020, lng: 29.001, name: "Bus-Near-RailB" },
      // unused stop — referenced by no route, should be excluded
      sX: { lat: 41.500, lng: 29.500, name: "Orphan" },
    },
    routes: [
      { code: "R1", longName: "Route One", stops: ["s1", "s2"] },
      { code: "R2", longName: "Route Two", stops: ["s2", "s3"] },
    ],
  };

  const g = buildGraph(transitData(stations, lines), busData);

  it("creates bus#-prefixed nodes only for stops referenced by some route", () => {
    expect(g.nodes.has("bus#s1")).toBe(true);
    expect(g.nodes.has("bus#s2")).toBe(true);
    expect(g.nodes.has("bus#s3")).toBe(true);
    expect(g.nodes.has("bus#sX")).toBe(false);
  });

  it("creates bus edges with the route's lineCode along each route's sequence", () => {
    const fromS2 = g.edges.get("bus#s2")!;
    const r1 = fromS2.find((e) => e.kind === "bus" && e.lineCode === "R1")!;
    const r2 = fromS2.find((e) => e.kind === "bus" && e.lineCode === "R2")!;
    expect(r1.to).toBe("bus#s1");
    expect(r2.to).toBe("bus#s3");
  });

  it("registers bus routes in byLine", () => {
    expect(g.byLine.get("R1")!.map((n) => n.id)).toEqual(["bus#s1", "bus#s2"]);
    expect(g.byLine.get("R2")!.map((n) => n.id)).toEqual(["bus#s2", "bus#s3"]);
  });

  it("creates asymmetric rail↔bus transfer edges (boarding-a-bus costs more)", () => {
    const railToBus = g.edges
      .get("L#0")!
      .find((e) => e.kind === "transfer" && e.to === "bus#s1")!;
    const busToRail = g.edges
      .get("bus#s1")!
      .find((e) => e.kind === "transfer" && e.to === "L#0")!;

    expect(railToBus).toBeDefined();
    expect(busToRail).toBeDefined();
    // Boarding TO a bus should pay a larger headway penalty than boarding
    // TO rail; the physical walk distance is the same.
    expect(railToBus.weightSec).toBeGreaterThan(busToRail.weightSec);
    expect(railToBus.distM).toBeCloseTo(busToRail.distM, 6);
  });

  it("does not produce rail↔bus transfers for stops outside 300m", () => {
    // Rail-B is at (41.020, 29.000). Bus s3 at (41.020, 29.001) is also
    // within 300m, so it *should* have a transfer. But the orphan stop sX
    // never made it into the graph in the first place — and Mid-Stop s2
    // at (41.010, 29.001) is ~1.1km from Rail-B, far outside 300m.
    const railBTransfers = g.edges
      .get("L#1")!
      .filter((e) => e.kind === "transfer")
      .map((e) => e.to);
    expect(railBTransfers).toContain("bus#s3");
    expect(railBTransfers).not.toContain("bus#s2");
  });
});
