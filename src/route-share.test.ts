import { describe, expect, it } from "vitest";
import { encodeShareRoute, tryDecodeShareRoute } from "./route-share";
import type { Route } from "./router";
import type { StationNode, TransitGraph } from "./graph";

function makeGraph(stations: StationNode[]): TransitGraph {
  const nodes = new Map<string, StationNode>();
  const byLine = new Map<string, StationNode[]>();
  const edges = new Map<string, never[]>();
  for (const s of stations) {
    nodes.set(s.id, s);
    edges.set(s.id, []);
    if (!byLine.has(s.lineCode)) byLine.set(s.lineCode, []);
    byLine.get(s.lineCode)!.push(s);
  }
  return {
    nodes,
    edges: edges as any,
    byLine,
    lineGeometry: new Map(),
    nearestIndex: new Map(),
  };
}

function st(
  id: string,
  name: string,
  lineCode: string,
  lat: number,
  lng: number
): StationNode {
  return {
    id,
    mode: "rail",
    stationName: name,
    lineCode,
    kind: "Metro",
    lat,
    lng,
    cumDistOnLine: 0,
  };
}

describe("route-share round-trip", () => {
  it("encodes and decodes a route with walk/rail/transfer legs", () => {
    const s0 = st("L1#0", "Alpha", "L1", 41.0, 29.0);
    const s1 = st("L1#1", "Beta", "L1", 41.02, 29.0);
    const s2 = st("L2#0", "Beta-Transfer", "L2", 41.02, 29.001);
    const s3 = st("L2#1", "Gamma", "L2", 41.02, 29.04);
    const graph = makeGraph([s0, s1, s2, s3]);

    const route: Route = {
      totalSec: 600,
      totalWalkM: 120,
      totalRailM: 0,
      legs: [
        {
          kind: "walk",
          role: "origin",
          fromLatLng: [41.0, 28.99],
          toLatLng: [41.0, 29.0],
          fromName: "Home",
          toName: "Alpha",
          durationSec: 60,
          distM: 80,
        },
        {
          kind: "rail",
          lineCode: "L1",
          fromName: "Alpha",
          toName: "Beta",
          stations: [s0, s1],
          durationSec: 120,
          distM: 2220,
        },
        {
          kind: "transfer",
          fromName: "Beta",
          toName: "Beta-Transfer",
          fromLineCode: "L1",
          toLineCode: "L2",
          fromLatLng: [41.02, 29.0],
          toLatLng: [41.02, 29.001],
          durationSec: 60,
          distM: 80,
        },
        {
          kind: "rail",
          lineCode: "L2",
          fromName: "Beta-Transfer",
          toName: "Gamma",
          stations: [s2, s3],
          durationSec: 300,
          distM: 3300,
        },
      ],
    };

    const encoded = encodeShareRoute(
      route,
      { lat: 41.0, lng: 28.99 },
      { lat: 41.02, lng: 29.04 }
    );
    const decoded = tryDecodeShareRoute(encoded, graph);
    expect(decoded).not.toBeNull();
    expect(decoded!.route.legs.length).toBe(4);
    expect(decoded!.route.legs[0].kind).toBe("walk");
    const railLeg = decoded!.route.legs[1];
    expect(railLeg.kind).toBe("rail");
    if (railLeg.kind === "rail") {
      expect(railLeg.lineCode).toBe("L1");
      expect(railLeg.stations.map((s) => s.id)).toEqual(["L1#0", "L1#1"]);
    }
    const transferLeg = decoded!.route.legs[2];
    expect(transferLeg.kind).toBe("transfer");
    expect(decoded!.start.lat).toBeCloseTo(41.0, 4);
  });

  it("encodes bus legs as 'b' kind", () => {
    const b0 = { ...st("bus#1", "B0", "R1", 41.0, 29.0), mode: "bus" as const };
    const b1 = { ...st("bus#2", "B1", "R1", 41.01, 29.01), mode: "bus" as const };
    const graph = makeGraph([b0, b1]);
    const route: Route = {
      totalSec: 300,
      totalWalkM: 0,
      totalRailM: 0,
      legs: [
        {
          kind: "bus",
          lineCode: "R1",
          fromName: "B0",
          toName: "B1",
          stations: [b0, b1],
          durationSec: 300,
          distM: 1200,
        },
      ],
    };
    const encoded = encodeShareRoute(route, { lat: 41, lng: 29 }, { lat: 41.01, lng: 29.01 });
    const decoded = tryDecodeShareRoute(encoded, graph);
    expect(decoded!.route.legs[0].kind).toBe("bus");
  });

  it("returns null for malformed encoding", () => {
    const graph = makeGraph([]);
    expect(tryDecodeShareRoute("!!!not-base64!!!", graph)).toBeNull();
  });

  it("returns null when payload version is wrong", () => {
    const graph = makeGraph([]);
    // Build a v=2 payload.
    const bin = JSON.stringify({ v: 2, s: [0, 0], e: [0, 0], legs: [], ts: 0, tw: 0 });
    const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(tryDecodeShareRoute(b64, graph)).toBeNull();
  });

  it("returns null when payload is missing required fields", () => {
    const graph = makeGraph([]);
    const bin = JSON.stringify({ v: 1, legs: [], ts: 0, tw: 0 });
    const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(tryDecodeShareRoute(b64, graph)).toBeNull();
  });

  it("returns null when a rail leg references an unknown station id", () => {
    const graph = makeGraph([st("X#0", "X", "X", 41, 29)]);
    const bin = JSON.stringify({
      v: 1,
      s: [41, 29],
      e: [41.01, 29.01],
      ts: 0,
      tw: 0,
      legs: [{ k: "r", c: "X", n: ["X#0", "MISSING"], t: 10 }],
    });
    const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(tryDecodeShareRoute(b64, graph)).toBeNull();
  });

  it("returns null when a rail leg has < 2 stations", () => {
    const graph = makeGraph([st("X#0", "X", "X", 41, 29)]);
    const bin = JSON.stringify({
      v: 1,
      s: [41, 29],
      e: [41.01, 29.01],
      ts: 0,
      tw: 0,
      legs: [{ k: "r", c: "X", n: ["X#0"], t: 10 }],
    });
    const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(tryDecodeShareRoute(b64, graph)).toBeNull();
  });

  it("returns null on an unknown leg kind", () => {
    const graph = makeGraph([]);
    const bin = JSON.stringify({
      v: 1,
      s: [41, 29],
      e: [41.01, 29.01],
      ts: 0,
      tw: 0,
      legs: [{ k: "z" }],
    });
    const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(tryDecodeShareRoute(b64, graph)).toBeNull();
  });

  it("rebuilds transfer endpoints from station-stub fallback", () => {
    const graph = makeGraph([]);
    // Encode a route with a transfer using anonymous station stubs.
    const route: Route = {
      totalSec: 60,
      totalWalkM: 50,
      totalRailM: 0,
      legs: [
        {
          kind: "transfer",
          fromName: "X",
          toName: "Y",
          fromLineCode: "A",
          toLineCode: "B",
          fromLatLng: [41.0, 29.0],
          toLatLng: [41.0, 29.001],
          durationSec: 60,
          distM: 50,
        },
      ],
    };
    const encoded = encodeShareRoute(route, { lat: 41, lng: 29 }, { lat: 41, lng: 29.001 });
    const decoded = tryDecodeShareRoute(encoded, graph);
    expect(decoded).not.toBeNull();
    const t = decoded!.route.legs[0];
    expect(t.kind).toBe("transfer");
    if (t.kind === "transfer") {
      expect(t.fromName).toBe("X");
      expect(t.toLineCode).toBe("B");
    }
  });
});
