import { afterEach, describe, expect, it, vi } from "vitest";
import { haversineKm, reverseGeocode, searchPlaces } from "./geocode";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("haversineKm", () => {
  it("returns 0 for identical points", () => {
    expect(haversineKm({ lat: 41, lng: 29 }, { lat: 41, lng: 29 })).toBe(0);
  });
  it("converts meters → km", () => {
    const km = haversineKm({ lat: 41, lng: 29 }, { lat: 41.01, lng: 29 });
    expect(km).toBeGreaterThan(1);
    expect(km).toBeLessThan(1.2);
  });
});

describe("searchPlaces", () => {
  it("returns [] for queries shorter than 2 chars", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    expect(await searchPlaces("a")).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("parses Photon results", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        features: [
          {
            geometry: { coordinates: [28.97, 41.03] },
            properties: {
              osm_id: 1,
              osm_type: "N",
              name: "Taksim",
              city: "İstanbul",
              osm_value: "stop_position",
            },
          },
          // Feature missing coords → filtered out
          { geometry: {}, properties: { name: "Skip" } },
          // Has only street+housenumber, no name → still synthesises a name
          {
            geometry: { coordinates: [28.99, 41.0] },
            properties: { street: "Istiklal", housenumber: "10" },
          },
          // No usable name fields → filtered out
          {
            geometry: { coordinates: [29.0, 41.0] },
            properties: {},
          },
        ],
      }),
    }) as unknown as typeof fetch;
    const r = await searchPlaces("Taksim photon");
    expect(r.length).toBe(2);
    expect(r[0].name).toBe("Taksim");
    expect(r[1].name).toBe("Istiklal 10");
  });

  it("caches identical queries", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ features: [] }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await searchPlaces("cached-query-A");
    await searchPlaces("cached-query-A");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to Nominatim on Photon failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error("photon down")))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            place_id: 42,
            display_name: "Eminönü, Fatih, İstanbul, Türkiye",
            lat: "41.0",
            lon: "29.0",
            type: "station",
          },
        ],
      });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const r = await searchPlaces("Eminonu fallback");
    expect(r.length).toBe(1);
    expect(r[0].name).toBe("Eminönü, Fatih");
    expect(r[0].id).toBe("42");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("rethrows AbortError from Photon", async () => {
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    globalThis.fetch = vi.fn().mockRejectedValue(err) as unknown as typeof fetch;
    await expect(searchPlaces("abort-query")).rejects.toThrow("aborted");
  });

  it("throws on Photon non-OK HTTP via the Nominatim fallback path", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            place_id: 1,
            display_name: "A, B",
            lat: "41",
            lon: "29",
          },
        ],
      }) as unknown as typeof fetch;
    const r = await searchPlaces("photon-500");
    expect(r.length).toBe(1);
  });

  it("throws when Nominatim also fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("photon down"))
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => [] }) as unknown as typeof fetch;
    await expect(searchPlaces("nominatim-bad")).rejects.toThrow(/HTTP 500/);
  });
});

describe("reverseGeocode", () => {
  it("parses a successful response into a Place", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        place_id: 7,
        display_name: "Galata Tower, Beyoğlu, İstanbul, Türkiye",
        lat: "41.025",
        lon: "28.974",
      }),
    }) as unknown as typeof fetch;
    const r = await reverseGeocode(41.025, 28.974);
    expect(r).not.toBeNull();
    expect(r!.id).toBe("7");
    expect(r!.name).toBe("Galata Tower, Beyoğlu");
  });

  it("caches identical queries", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        place_id: 8,
        display_name: "X",
        lat: "41.99",
        lon: "28.88",
      }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await reverseGeocode(41.99, 28.88);
    await reverseGeocode(41.99, 28.88);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns null on HTTP error and caches the negative", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    expect(await reverseGeocode(40.5, 28.5)).toBeNull();
    // Cached → no extra call.
    expect(await reverseGeocode(40.5, 28.5)).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns null when the response body has an error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ error: "Not found" }),
    }) as unknown as typeof fetch;
    expect(await reverseGeocode(40.6, 28.6)).toBeNull();
  });

  it("returns null when response has no display_name", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }) as unknown as typeof fetch;
    expect(await reverseGeocode(40.7, 28.7)).toBeNull();
  });

  it("rethrows AbortError", async () => {
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    globalThis.fetch = vi.fn().mockRejectedValue(err) as unknown as typeof fetch;
    await expect(reverseGeocode(41.0, 29.0)).rejects.toThrow("aborted");
  });

  it("returns null on a non-Abort fetch error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("net down")) as unknown as typeof fetch;
    expect(await reverseGeocode(40.8, 28.8)).toBeNull();
  });

  it("uses falls back to query coords when response omits coords", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        display_name: "Just a place",
      }),
    }) as unknown as typeof fetch;
    const r = await reverseGeocode(40.9, 28.9);
    expect(r).not.toBeNull();
    expect(r!.lat).toBe(40.9);
    expect(r!.lng).toBe(28.9);
    expect(r!.id).toMatch(/^rev-/);
  });

  it("shortens single-segment display names", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        place_id: 99,
        display_name: "JustOne",
        lat: "41",
        lon: "29",
      }),
    }) as unknown as typeof fetch;
    const r = await reverseGeocode(41.111, 29.111);
    expect(r!.name).toBe("JustOne");
  });
});
