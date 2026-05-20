import { afterEach, describe, expect, it, vi } from "vitest";
import { getFootRoute } from "./walk-routing";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("getFootRoute", () => {
  it("returns null when the two points are within 25m without calling fetch", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const result = await getFootRoute(
      { lat: 41.0, lng: 29.0 },
      { lat: 41.00005, lng: 29.00005 }
    );
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("parses a successful OSRM response into a FootRoute", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        code: "Ok",
        routes: [
          {
            geometry: {
              coordinates: [
                [29.0, 41.0],
                [29.001, 41.001],
              ],
            },
            distance: 120,
            duration: 80,
          },
        ],
      }),
    }) as unknown as typeof fetch;

    const r = await getFootRoute(
      { lat: 41.1, lng: 29.1 },
      { lat: 41.105, lng: 29.105 }
    );
    expect(r).not.toBeNull();
    expect(r!.distM).toBe(120);
    expect(r!.durationSec).toBe(80);
    expect(r!.coords.length).toBe(2);
  });

  it("returns cached result on second identical call", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        code: "Ok",
        routes: [
          {
            geometry: { coordinates: [[29.2, 41.2]] },
            distance: 50,
            duration: 30,
          },
        ],
      }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const a = { lat: 41.2, lng: 29.2 };
    const b = { lat: 41.21, lng: 29.21 };
    const first = await getFootRoute(a, b);
    const second = await getFootRoute(a, b);
    expect(first).toEqual(second);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to null and caches when OSRM returns non-Ok code", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ code: "NoRoute", routes: [] }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const a = { lat: 41.3, lng: 29.3 };
    const b = { lat: 41.31, lng: 29.31 };
    expect(await getFootRoute(a, b)).toBeNull();
    expect(await getFootRoute(a, b)).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns null on non-OK HTTP status", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    }) as unknown as typeof fetch;
    const r = await getFootRoute(
      { lat: 41.4, lng: 29.4 },
      { lat: 41.41, lng: 29.41 }
    );
    expect(r).toBeNull();
  });

  it("rethrows AbortError", async () => {
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    globalThis.fetch = vi.fn().mockRejectedValue(err) as unknown as typeof fetch;
    await expect(
      getFootRoute(
        { lat: 41.5, lng: 29.5 },
        { lat: 41.51, lng: 29.51 }
      )
    ).rejects.toThrow("aborted");
  });
});
