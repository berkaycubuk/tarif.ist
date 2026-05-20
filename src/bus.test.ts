import L from "leaflet";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupBus, setupBusStopsLayer } from "./bus";

function makeMap(): L.Map {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientWidth", { value: 600 });
  Object.defineProperty(el, "clientHeight", { value: 400 });
  document.body.appendChild(el);
  return L.map(el, { center: [41, 29], zoom: 15 });
}

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("setupBus", () => {
  it("loads the index and resolves the entries via getIndex()", async () => {
    const index = [
      { code: "11A", longName: "Foo - Bar", file: "11A.geojson" },
      { code: "12B", longName: "Baz", file: "12B.geojson" },
    ];
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => index }) as unknown as typeof fetch;
    const map = makeMap();
    const bus = await setupBus(map);
    expect(bus.getIndex()).toEqual(index);
  });

  it("returns an empty index when /data/bus/index.json is missing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => [],
    }) as unknown as typeof fetch;
    const bus = await setupBus(makeMap());
    expect(bus.getIndex()).toEqual([]);
  });

  it("returns [] when the index fetch throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("net")) as unknown as typeof fetch;
    const bus = await setupBus(makeMap());
    expect(bus.getIndex()).toEqual([]);
  });

  it("show() renders a route's shape and reports its stopIds", async () => {
    const index = [{ code: "11A", longName: "Foo", file: "11A.geojson" }];
    const route = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: [
              [29.0, 41.0],
              [29.01, 41.0],
            ],
          },
          properties: { kind: "shape", direction: "forward" },
        },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [29.0, 41.0] },
          properties: { kind: "stop", direction: "forward", stopId: "s1", name: "S1" },
        },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [29.01, 41.0] },
          properties: { kind: "stop", direction: "forward", stopId: "s2", name: "S2" },
        },
        // Missing geometry → must be ignored
        { type: "Feature", geometry: null, properties: { kind: "shape", direction: "forward" } },
      ],
    };
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => index })
      .mockResolvedValueOnce({ ok: true, json: async () => route }) as unknown as typeof fetch;
    const map = makeMap();
    const bus = await setupBus(map);
    const handle = await bus.show(index[0]);
    expect(handle).not.toBeNull();
    expect([...handle!.stopIds].sort()).toEqual(["s1", "s2"]);
    bus.clear();
  });

  it("show() returns null when route file is missing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const index = [{ code: "X", longName: "X", file: "X.geojson" }];
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => index })
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }) as unknown as typeof fetch;
    const bus = await setupBus(makeMap());
    expect(await bus.show(index[0])).toBeNull();
  });

  it("show() caches per-route fetches", async () => {
    const index = [{ code: "Z", longName: "Z", file: "Z.geojson" }];
    const route = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: [[29, 41], [29.01, 41]] },
          properties: { kind: "shape", direction: "forward" },
        },
      ],
    };
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => index })
      .mockResolvedValueOnce({ ok: true, json: async () => route });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const bus = await setupBus(makeMap());
    await bus.show(index[0]);
    await bus.show(index[0]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("setupBusStopsLayer", () => {
  let map: L.Map;

  beforeEach(() => {
    map = makeMap();
  });

  it("returns null when /data/bus/stops.geojson is missing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }) as unknown as typeof fetch;
    expect(await setupBusStopsLayer(map)).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("net")) as unknown as typeof fetch;
    expect(await setupBusStopsLayer(map)).toBeNull();
  });

  it("ignores non-Point features", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "LineString", coordinates: [[29, 41]] },
            properties: { stopId: "x", name: "Skip", lines: [] },
          },
        ],
      }),
    }) as unknown as typeof fetch;
    const layer = await setupBusStopsLayer(map);
    expect(layer).not.toBeNull();
    layer!.destroy();
  });

  it("mounts visible stops and supports filter/hide/destroy", async () => {
    // Place stops inside the default map viewport (~41,29).
    const features = Array.from({ length: 3 }, (_, i) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [29 + i * 0.001, 41 + i * 0.001] },
      properties: { stopId: `s${i}`, name: `Stop ${i}`, lines: ["11A"] },
    }));
    // Add a stop with no name + no lines (covers the tooltip-skip branch)
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [29.002, 41.002] },
      properties: { stopId: "anon", name: "", lines: [] },
    } as any);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ type: "FeatureCollection", features }),
    }) as unknown as typeof fetch;

    const layer = await setupBusStopsLayer(map);
    expect(layer).not.toBeNull();

    // Below MIN zoom triggers the unmount branch.
    map.setZoom(10);
    map.fire("moveend");

    // Above MIN zoom — stops mount.
    map.setZoom(16);
    map.fire("moveend");

    layer!.setStopFilter(new Set(["s0"]));
    map.fire("moveend");
    layer!.setStopFilter(null);
    map.fire("moveend");

    layer!.setHidden(true);
    layer!.setHidden(false);
    layer!.destroy();
  });
});
