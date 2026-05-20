import L from "leaflet";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "./route-render";
import { buildGraph } from "./graph";
import type { TransitData } from "./transit";
import type { Route } from "./router";
import type { Feature, FeatureCollection, LineString, Point } from "geojson";
import type { StationProps, LineProps } from "./transit";

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  // walk-routing fetches OSRM — stub it to return null routes by default.
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ code: "Ok", routes: [] }),
  }) as unknown as typeof fetch;
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
  return L.map(el, { center: [41, 29], zoom: 11 });
}

function stationFeature(
  name: string,
  lineCode: string,
  lng: number,
  lat: number
): Feature<Point, StationProps> {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lng, lat] },
    properties: { name, lineName: lineCode, lineCode, kind: "Metro" },
  };
}

function lineFeature(
  lineCode: string,
  coords: Array<[number, number]>
): Feature<LineString, LineProps> {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: coords },
    properties: {
      name: lineCode,
      shortName: lineCode,
      lineCode,
      kind: "Metro",
      lengthKm: null,
      stationCount: null,
    },
  };
}

function tinyData(): TransitData {
  return {
    stations: {
      type: "FeatureCollection",
      features: [
        stationFeature("A", "M2", 29.0, 41.0),
        stationFeature("B", "M2", 29.0, 41.02),
        stationFeature("C", "M2", 29.0, 41.04),
      ],
    } as FeatureCollection<Point, StationProps>,
    lines: {
      type: "FeatureCollection",
      features: [
        lineFeature("M2", [
          [29.0, 41.0],
          [29.0, 41.02],
          [29.0, 41.04],
        ]),
      ],
    } as FeatureCollection<LineString, LineProps>,
  };
}

describe("renderRoute", () => {
  it("renders a route with walk + rail legs and produces itinerary HTML", async () => {
    const data = tinyData();
    const graph = buildGraph(data);
    const stations = graph.byLine.get("M2")!;
    const route: Route = {
      totalSec: 600,
      totalWalkM: 300,
      totalRailM: 4400,
      legs: [
        {
          kind: "walk",
          role: "origin",
          fromLatLng: [41.0, 28.999],
          toLatLng: [41.0, 29.0],
          toName: "A",
          durationSec: 60,
          distM: 100,
        },
        {
          kind: "rail",
          lineCode: "M2",
          fromName: "A",
          toName: "C",
          stations,
          durationSec: 240,
          distM: 4400,
        },
        {
          kind: "walk",
          role: "egress",
          fromLatLng: [41.04, 29.0],
          toLatLng: [41.04, 29.001],
          fromName: "C",
          durationSec: 60,
          distM: 100,
        },
      ],
    };
    const map = makeMap();
    const r = await renderRoute(map, graph, route);
    expect(r.layer).toBeDefined();
    expect(r.itineraryHtml).toContain("M2");
    expect(r.itineraryHtml).toContain("dk");
    expect(r.itineraryHtml).toContain("yürü");
    expect(r.route.legs.length).toBe(3);
  });

  it("renders a transfer leg and a bus leg", async () => {
    const data = tinyData();
    const graph = buildGraph(data);
    const stations = graph.byLine.get("M2")!;
    const route: Route = {
      totalSec: 400,
      totalWalkM: 60,
      totalRailM: 2200,
      legs: [
        {
          kind: "rail",
          lineCode: "M2",
          fromName: "A",
          toName: "B",
          stations: stations.slice(0, 2),
          durationSec: 120,
          distM: 2200,
        },
        {
          kind: "transfer",
          fromName: "B",
          toName: "B-bus",
          fromLineCode: "M2",
          toLineCode: "55A",
          fromLatLng: [41.02, 29.0],
          toLatLng: [41.02, 29.001],
          durationSec: 60,
          distM: 80,
        },
        {
          kind: "bus",
          lineCode: "55A",
          fromName: "B-bus",
          toName: "End-bus",
          stations: [
            {
              id: "bus#1",
              mode: "bus",
              stationName: "B-bus",
              lineCode: "",
              kind: "Bus",
              lat: 41.02,
              lng: 29.001,
              cumDistOnLine: 0,
            },
            {
              id: "bus#2",
              mode: "bus",
              stationName: "End-bus",
              lineCode: "",
              kind: "Bus",
              lat: 41.03,
              lng: 29.001,
              cumDistOnLine: 0,
            },
          ],
          durationSec: 180,
          distM: 1100,
        },
      ],
    };
    const map = makeMap();
    const r = await renderRoute(map, graph, route);
    expect(r.itineraryHtml).toContain("55A");
    expect(r.itineraryHtml).toContain("aktar");
  });

  it("renders a direct walk-only route", async () => {
    const data = tinyData();
    const graph = buildGraph(data);
    const route: Route = {
      totalSec: 600,
      totalWalkM: 800,
      totalRailM: 0,
      legs: [
        {
          kind: "walk",
          role: "direct",
          fromLatLng: [41.0, 29.0],
          toLatLng: [41.005, 29.001],
          durationSec: 600,
          distM: 800,
        },
      ],
    };
    const map = makeMap();
    const r = await renderRoute(map, graph, route);
    expect(r.itineraryHtml).toContain("0.8 km");
  });

  it("uses OSRM foot geometry when available", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        code: "Ok",
        routes: [
          {
            geometry: {
              coordinates: [
                [29.0, 41.0],
                [29.0005, 41.0005],
                [29.001, 41.001],
              ],
            },
            distance: 200,
            duration: 140,
          },
        ],
      }),
    }) as unknown as typeof fetch;
    const data = tinyData();
    const graph = buildGraph(data);
    const route: Route = {
      totalSec: 240,
      totalWalkM: 100,
      totalRailM: 0,
      legs: [
        {
          kind: "walk",
          role: "origin",
          fromLatLng: [41.0, 29.0],
          toLatLng: [41.001, 29.001],
          toName: "Some Station",
          durationSec: 80,
          distM: 100,
        },
      ],
    };
    const map = makeMap();
    const r = await renderRoute(map, graph, route);
    expect(r.route.legs[0].durationSec).toBe(140);
  });

  it("falls back to straight-line draw when slice is bogus", async () => {
    // Construct a graph where the line geometry is short but the slice may
    // return ≥4× the direct distance — that triggers the defensive fallback.
    const data: TransitData = {
      stations: {
        type: "FeatureCollection",
        features: [
          stationFeature("X", "ZZ", 29.0, 41.0),
          stationFeature("Y", "ZZ", 29.0, 41.02),
        ],
      } as any,
      lines: {
        type: "FeatureCollection",
        features: [
          // Very loopy line so a slice between X and Y is enormous.
          lineFeature("ZZ", [
            [29.0, 41.0],
            [29.5, 41.0],
            [29.5, 41.02],
            [29.0, 41.02],
          ]),
        ],
      } as any,
    };
    const graph = buildGraph(data);
    const stations = graph.byLine.get("ZZ")!;
    const route: Route = {
      totalSec: 120,
      totalWalkM: 0,
      totalRailM: 2200,
      legs: [
        {
          kind: "rail",
          lineCode: "ZZ",
          fromName: "X",
          toName: "Y",
          stations,
          durationSec: 120,
          distM: 2200,
        },
      ],
    };
    const map = makeMap();
    const r = await renderRoute(map, graph, route);
    expect(r.layer).toBeDefined();
  });
});
