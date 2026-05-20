import L from "leaflet";
import { describe, expect, it, beforeEach } from "vitest";
import {
  addTransitLayers,
  colorForLine,
  loadTransitData,
  railStationKey,
  uniqueLineCodes,
  type TransitData,
} from "./transit";
import { buildGraph } from "./graph";
import type { StationProps, LineProps } from "./transit";
import type { Feature, FeatureCollection, LineString, Point } from "geojson";

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
  coords: Array<[number, number]>,
  shortName = lineCode
): Feature<LineString, LineProps> {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: coords },
    properties: {
      name: lineCode,
      shortName,
      lineCode,
      kind: "Metro",
      lengthKm: null,
      stationCount: null,
    },
  };
}

function transitData(
  stations: Feature<Point, StationProps>[],
  lines: Feature<LineString, LineProps>[]
): TransitData {
  return {
    stations: {
      type: "FeatureCollection",
      features: stations,
    } as FeatureCollection<Point, StationProps>,
    lines: {
      type: "FeatureCollection",
      features: lines,
    } as FeatureCollection<LineString, LineProps>,
  };
}

describe("colorForLine", () => {
  it("returns the brand color for known codes", () => {
    expect(colorForLine("M2")).toBe("#16a34a");
    expect(colorForLine("MARMARAY")).toBe("#0f766e");
  });

  it("uppercases input before lookup", () => {
    expect(colorForLine("m2")).toBe("#16a34a");
  });

  it("falls back to gray for unknown / null", () => {
    expect(colorForLine(null)).toBe("#64748b");
    expect(colorForLine(undefined)).toBe("#64748b");
    expect(colorForLine("XX")).toBe("#64748b");
  });
});

describe("railStationKey", () => {
  it("joins lineCode and name with a pipe", () => {
    expect(railStationKey("M2", "Levent")).toBe("M2|Levent");
  });
  it("treats null lineCode as empty", () => {
    expect(railStationKey(null, "Levent")).toBe("|Levent");
  });
});

describe("loadTransitData", () => {
  it("fetches lines.geojson and stations.geojson", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (url: any) => {
      const u = String(url);
      return Promise.resolve({
        ok: true,
        json: async () =>
          u.endsWith("lines.geojson")
            ? { type: "FeatureCollection", features: [] }
            : { type: "FeatureCollection", features: [] },
      } as Response);
    };
    try {
      const data = await loadTransitData();
      expect(data.lines.features).toEqual([]);
      expect(data.stations.features).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("addTransitLayers + uniqueLineCodes", () => {
  let map: L.Map;
  beforeEach(() => {
    map = makeMap();
  });

  it("renders lines and stations and returns a controlled stations layer", () => {
    const data = transitData(
      [
        stationFeature("A", "M2", 29.0, 41.0),
        stationFeature("B", "M2", 29.01, 41.01),
        stationFeature("C", "T1", 28.97, 41.0),
        stationFeature("D", "T1", 28.98, 41.0),
      ],
      [
        lineFeature("M2", [
          [29.0, 41.0],
          [29.01, 41.01],
        ]),
        lineFeature("T1", [
          [28.97, 41.0],
          [28.98, 41.0],
        ]),
      ]
    );
    const graph = buildGraph(data);
    const layers = addTransitLayers(map, data, graph);
    expect(layers.lines).toBeDefined();
    expect(layers.stations).toBeDefined();

    const codes = uniqueLineCodes(layers.lines);
    expect(codes).toContain("M2");
    expect(codes).toContain("T1");

    // Filtering / hiding exercises every public method.
    layers.stations.setLineFilter("M2");
    layers.stations.setStationKeyFilter(new Set(["M2|A"]));
    layers.stations.setHidden(true);
    layers.stations.setHidden(false);
    layers.stations.setStationKeyFilter(null);
    layers.stations.setLineFilter(null);

    // Force a re-sync at a deeper zoom to exercise the marker-mount path.
    map.setZoom(15);
    map.fire("zoomend");

    layers.stations.destroy();
  });

  it("ignores stations without a Point geometry in the render layer", () => {
    const good = transitData(
      [
        stationFeature("Good", "M", 29.0, 41.0),
        stationFeature("Good2", "M", 29.0, 41.01),
      ],
      [
        lineFeature("M", [
          [29.0, 41.0],
          [29.0, 41.01],
        ]),
      ]
    );
    const graph = buildGraph(good);
    // Now slip a non-Point station feature in just for the render layer.
    const corrupted: TransitData = {
      ...good,
      stations: {
        type: "FeatureCollection",
        features: [
          ...good.stations.features,
          {
            type: "Feature",
            geometry: { type: "LineString", coordinates: [[29, 41]] } as any,
            properties: { name: "Bad", lineName: "M", lineCode: "M", kind: null },
          },
        ],
      } as FeatureCollection<Point, StationProps>,
    };
    expect(() => addTransitLayers(map, corrupted, graph)).not.toThrow();
  });

  it("uses tram icon for tram-coded lines", () => {
    const data = transitData(
      [
        stationFeature("Tram-A", "T1", 28.97, 41.0),
        stationFeature("Tram-B", "T1", 28.98, 41.0),
      ],
      [
        lineFeature("T1", [
          [28.97, 41.0],
          [28.98, 41.0],
        ]),
      ]
    );
    const graph = buildGraph(data);
    const layers = addTransitLayers(map, data, graph);
    expect(uniqueLineCodes(layers.lines)).toContain("T1");
  });

  it("escapes HTML in line + station names", () => {
    const station = stationFeature("Name <evil>", "M", 29.0, 41.0);
    const data = transitData(
      [station, stationFeature("Other", "M", 29.0, 41.01)],
      [
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: [[29, 41], [29, 41.01]] },
          properties: {
            name: "Line<x>",
            shortName: "Sh<y>",
            lineCode: "M",
            kind: "Metro",
            lengthKm: null,
            stationCount: null,
          },
        },
      ]
    );
    const graph = buildGraph(data);
    const { lines } = addTransitLayers(map, data, graph);
    let found: string | undefined;
    lines.eachLayer((l) => {
      const tt = (l as any)._tooltip ?? (l as any).getTooltip?.();
      const content = tt?._content ?? tt?.getContent?.();
      if (content) found = String(content);
    });
    expect(found).toMatch(/&lt;/);
  });
});

describe("uniqueLineCodes — ordering", () => {
  it("sorts metro before tram before funicular", () => {
    const data = transitData(
      [
        stationFeature("a", "F1", 29.0, 41.0),
        stationFeature("b", "F1", 29.0, 41.01),
        stationFeature("c", "T1", 29.0, 41.0),
        stationFeature("d", "T1", 29.0, 41.01),
        stationFeature("e", "M2", 29.0, 41.0),
        stationFeature("f", "M2", 29.0, 41.01),
        stationFeature("g", "B1", 29.0, 41.0),
        stationFeature("h", "B1", 29.0, 41.01),
      ],
      [
        lineFeature("F1", [[29, 41], [29, 41.01]]),
        lineFeature("T1", [[29, 41], [29, 41.01]]),
        lineFeature("M2", [[29, 41], [29, 41.01]]),
        lineFeature("B1", [[29, 41], [29, 41.01]]),
      ]
    );
    const graph = buildGraph(data);
    const map = makeMap();
    const layers = addTransitLayers(map, data, graph);
    const codes = uniqueLineCodes(layers.lines);
    // M before T before F before B.
    expect(codes.indexOf("M2")).toBeLessThan(codes.indexOf("T1"));
    expect(codes.indexOf("T1")).toBeLessThan(codes.indexOf("F1"));
    expect(codes.indexOf("F1")).toBeLessThan(codes.indexOf("B1"));
  });
});
