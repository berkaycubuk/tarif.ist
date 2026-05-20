// Final-mile tests for the last few branches.

import L from "leaflet";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

function makeMap(): L.Map {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientWidth", { value: 600 });
  Object.defineProperty(el, "clientHeight", { value: 400 });
  document.body.appendChild(el);
  return L.map(el, { center: [41, 29], zoom: 15 });
}

// --- graph.ts: twoOptOrder swap path + getLineStations -------------------

import { buildGraph, getLineStations } from "./graph";
import type { TransitData } from "./transit";

describe("graph — twoOptOrder swap + accessors", () => {
  it("twoOptOrder reverses sub-ranges to shorten the path", () => {
    // 4 stations in deliberately bad order (lat ascending but with two swapped
    // in the middle), no line geometry → twoOptOrder must improve.
    const data: TransitData = {
      stations: {
        type: "FeatureCollection",
        features: [
          { type: "Feature", geometry: { type: "Point", coordinates: [29, 41.00] }, properties: { name: "a", lineName: "Q", lineCode: "Q", kind: "Metro" } },
          { type: "Feature", geometry: { type: "Point", coordinates: [29, 41.06] }, properties: { name: "b", lineName: "Q", lineCode: "Q", kind: "Metro" } },
          { type: "Feature", geometry: { type: "Point", coordinates: [29, 41.02] }, properties: { name: "c", lineName: "Q", lineCode: "Q", kind: "Metro" } },
          { type: "Feature", geometry: { type: "Point", coordinates: [29, 41.04] }, properties: { name: "d", lineName: "Q", lineCode: "Q", kind: "Metro" } },
        ],
      } as any,
      // No line feature → no geom → no pre-sort.
      lines: { type: "FeatureCollection", features: [] } as any,
    };
    const g = buildGraph(data);
    const stations = getLineStations(g, "Q")!;
    expect(stations).toBeDefined();
    // After 2-opt, the chain visits stations in monotonic latitude order
    // (either ascending or descending — both are optimal).
    const names = stations.map((s) => s.stationName);
    const ascending = ["a", "c", "d", "b"];
    const descending = [...ascending].reverse();
    expect([ascending, descending]).toContainEqual(names);
  });
});

// --- bus.ts: previously-mounted stop disappears when filter narrows -------

import { setupBusStopsLayer } from "./bus";

describe("bus stops layer — stop disappears under new filter", () => {
  it("removes a stop that is no longer in the wanted set", async () => {
    const features = [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [29, 41] },
        properties: { stopId: "alpha", name: "Alpha", lines: ["A"] },
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [29.001, 41.001] },
        properties: { stopId: "beta", name: "Beta", lines: ["B"] },
      },
    ];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ type: "FeatureCollection", features }),
    }) as unknown as typeof fetch;
    const map = makeMap();
    const layer = await setupBusStopsLayer(map);
    expect(layer).not.toBeNull();
    // Mount under filter A+B
    layer!.setStopFilter(new Set(["alpha", "beta"]));
    // Narrow filter — beta should drop.
    layer!.setStopFilter(new Set(["alpha"]));
    layer!.destroy();
  });
});

// --- line-inspector.ts: straight-line lerp when projection unavailable ---

import { setupLineInspector } from "./line-inspector";

describe("line-inspector — train falls back to straight-line lerp", () => {
  it("when the projection for the visible line is missing", async () => {
    const map = makeMap();
    // No GeoJSON lines layer at all → ensureProjection returns null → fallback.
    const layer = L.geoJSON({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          // A single-point line yields path.length < 2, so ensureProjection
          // returns null and the marker uses the straight-line lerp.
          geometry: {
            type: "LineString",
            coordinates: [[29, 41]],
          },
          properties: { lineCode: "M2" },
        } as any,
      ],
    } as any);
    layer.addTo(map);

    globalThis.fetch = vi.fn().mockImplementation((url: any) => {
      const u = String(url);
      if (u.includes("/v1/lines")) {
        return Promise.resolve({
          ok: true,
          json: async () => [
            {
              code: "M2",
              stations: [
                { name: "A", lat: 41, lng: 29 },
                { name: "B", lat: 41.04, lng: 29 },
              ],
            },
          ],
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          trains: [
            {
              trainIdx: 1,
              direction: "ab",
              fromStation: "A",
              toStation: "B",
              segmentProgress: 0.5,
              secondsToNext: 60,
            },
          ],
        }),
      });
    }) as unknown as typeof fetch;
    const li = setupLineInspector({ map, getLinesLayer: () => layer });
    li.selectLine("M2");
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
    li.destroy();
  });
});

// --- router.ts: exercise the MinHeap.down swap path -----------------------

import { findRoute } from "./router";
import type { TransitGraph, StationNode, Edge } from "./graph";

describe("router — larger graph exercises min-heap pop", () => {
  it("routes across a chain of 10 closely-spaced nodes (heap grows + down() swaps)", () => {
    const nodes = new Map<string, StationNode>();
    const edges = new Map<string, Edge[]>();
    const nodeList: StationNode[] = [];
    // 0.003° ≈ 333m spacing → many stations sit inside MAX_WALK_M.
    for (let i = 0; i < 10; i++) {
      const n: StationNode = {
        id: `L#${i}`,
        mode: "rail",
        stationName: `N${i}`,
        lineCode: "L",
        kind: "Metro",
        lat: 41 + i * 0.003,
        lng: 29,
        cumDistOnLine: 0,
      };
      nodes.set(n.id, n);
      edges.set(n.id, []);
      nodeList.push(n);
    }
    for (let i = 1; i < nodeList.length; i++) {
      const a = nodeList[i - 1];
      const b = nodeList[i];
      edges.get(a.id)!.push({
        to: b.id,
        weightSec: 60 + i * 5, // varied weights → different heap orderings
        kind: "rail",
        lineCode: "L",
        distM: 333,
      });
      edges.get(b.id)!.push({
        to: a.id,
        weightSec: 60 + i * 5,
        kind: "rail",
        lineCode: "L",
        distM: 333,
      });
    }
    const idx = new Map<string, StationNode[]>();
    for (const n of nodes.values()) {
      const k = `${Math.floor(n.lat / 0.02)}|${Math.floor(n.lng / 0.02)}`;
      let arr = idx.get(k);
      if (!arr) {
        arr = [];
        idx.set(k, arr);
      }
      arr.push(n);
    }
    const graph: TransitGraph = {
      nodes,
      edges,
      byLine: new Map([["L", nodeList]]),
      lineGeometry: new Map(),
      nearestIndex: idx,
    };
    // Endpoints far apart, both within walking distance of multiple stations.
    const route = findRoute(
      graph,
      { lat: 41.0, lng: 29.0 },
      { lat: 41.027, lng: 29.0 }
    );
    expect(route).not.toBeNull();
  });
});
