import L from "leaflet";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDisruptions, renderDisruptions } from "./disruptions";
import { buildGraph } from "./graph";
import type { TransitData } from "./transit";
import type { Feature, FeatureCollection, LineString, Point } from "geojson";
import type { StationProps, LineProps } from "./transit";

const ORIGINAL_FETCH = globalThis.fetch;

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

function tinyTransitData(): TransitData {
  return {
    stations: {
      type: "FeatureCollection",
      features: [
        stationFeature("Alpha Station", "M2", 29.0, 41.0),
        stationFeature("Beta Station", "M2", 29.0, 41.02),
        stationFeature("Gamma Station", "M2", 29.0, 41.04),
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

describe("loadDisruptions", () => {
  it("returns [] when the backend returns non-OK", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    }) as unknown as typeof fetch;
    expect(await loadDisruptions()).toEqual([]);
  });

  it("returns [] when the fetch throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch;
    expect(await loadDisruptions()).toEqual([]);
  });

  it("parses backend items into Disruption[]", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        fetchedAt: 0,
        items: [
          {
            id: "1",
            lineCode: "M2",
            severity: "warning",
            type: "delay",
            title: "Delay",
            description: "Alpha Station etkilendi",
            startTime: "2024-01-01T10:00:00Z",
            endTime: null,
          },
        ],
      }),
    }) as unknown as typeof fetch;
    const list = await loadDisruptions();
    expect(list.length).toBe(1);
    expect(list[0].lineCode).toBe("M2");
  });

  it("treats a missing items array as empty", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ fetchedAt: 0 }),
    }) as unknown as typeof fetch;
    expect(await loadDisruptions()).toEqual([]);
  });
});

describe("renderDisruptions", () => {
  it("renders dashed overlays + warning markers for the affected line", () => {
    const map = makeMap();
    const data = tinyTransitData();
    const graph = buildGraph(data);
    const layer = renderDisruptions(map, graph, [
      {
        id: "d1",
        lineCode: "M2",
        severity: "warning",
        type: "incident",
        title: "Slow service",
        description: "Alpha Station ile Gamma Station arasında",
        startTime: "2024-01-01T10:00:00Z",
        endTime: "2024-01-01T11:00:00Z",
      },
      {
        id: "d2",
        lineCode: "M2",
        severity: "critical",
        type: "closure",
        title: "Closure",
        description: "Tüm hat",
      },
      // info: lower severity, but should still bump counts.
      {
        id: "d3",
        lineCode: "M2",
        severity: "info",
        type: "maintenance",
        title: "Maintenance",
        description: "Beta Station",
      },
    ]);
    expect(layer.disruptions.length).toBe(3);
    expect(layer.countsByLine.get("M2")).toBe(3);
    // Worst severity wins.
    expect(layer.severityByLine.get("M2")).toBe("critical");
    layer.setVisibleLine("M2");
    layer.setVisibleLine("M2"); // no-op when same
    layer.setVisibleLine(null);
    layer.destroy();
  });

  it("supports explicit stations[] selector", () => {
    const map = makeMap();
    const data = tinyTransitData();
    const graph = buildGraph(data);
    const layer = renderDisruptions(map, graph, [
      {
        id: "d1",
        lineCode: "M2",
        severity: "warning",
        type: "delay",
        title: "Targeted delay",
        description: "",
        stations: ["Alpha Station", "Beta Station"],
      },
    ]);
    expect(layer.disruptions.length).toBe(1);
    layer.destroy();
  });

  it("falls back gracefully when graph is null", () => {
    const map = makeMap();
    const layer = renderDisruptions(map, null, [
      {
        id: "d1",
        lineCode: "M2",
        severity: "info",
        type: "incident",
        title: "x",
        description: "y",
      },
    ]);
    expect(layer.disruptions.length).toBe(1);
    expect(layer.countsByLine.get("M2")).toBe(1);
    layer.setVisibleLine("M2"); // no group exists, but should not throw
    layer.destroy();
  });

  it("falls back when the disruption's lineCode isn't in the graph", () => {
    const map = makeMap();
    const data = tinyTransitData();
    const graph = buildGraph(data);
    const layer = renderDisruptions(map, graph, [
      {
        id: "d1",
        lineCode: "ZZZ",
        severity: "info",
        type: "incident",
        title: "x",
        description: "y",
      },
    ]);
    expect(layer.disruptions.length).toBe(1);
  });

  it("handles invalid dates in time-range formatter", () => {
    const map = makeMap();
    const data = tinyTransitData();
    const graph = buildGraph(data);
    const layer = renderDisruptions(map, graph, [
      {
        id: "d1",
        lineCode: "M2",
        severity: "info",
        type: "delay",
        title: "Bad date",
        description: "",
        startTime: "not-a-date",
        endTime: "also-not-a-date",
      },
    ]);
    expect(layer.disruptions[0].id).toBe("d1");
  });

  it("formats endTime-only and startTime-only ranges", () => {
    const map = makeMap();
    const data = tinyTransitData();
    const graph = buildGraph(data);
    const layer = renderDisruptions(map, graph, [
      {
        id: "d1",
        lineCode: "M2",
        severity: "info",
        type: "delay",
        title: "Only start",
        description: "",
        startTime: "2024-01-01T10:00:00Z",
      },
      {
        id: "d2",
        lineCode: "M2",
        severity: "info",
        type: "delay",
        title: "Only end",
        description: "",
        endTime: "2024-01-01T11:00:00Z",
      },
    ]);
    expect(layer.disruptions.length).toBe(2);
  });
});
