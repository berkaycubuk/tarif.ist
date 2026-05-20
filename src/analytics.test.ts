import { afterEach, describe, expect, it, vi } from "vitest";
import { placeKind, track } from "./analytics";

afterEach(() => {
  delete (window as any).umami;
});

describe("placeKind", () => {
  it("returns 'unknown' for undefined", () => {
    expect(placeKind(undefined)).toBe("unknown");
  });

  it("maps station-y types to 'station'", () => {
    expect(placeKind("Station")).toBe("station");
    expect(placeKind("bus_halt")).toBe("station");
    expect(placeKind("BUS_STOP")).toBe("station");
    expect(placeKind("platform")).toBe("station");
  });

  it("maps house/address/building to 'address'", () => {
    expect(placeKind("house")).toBe("address");
    expect(placeKind("address")).toBe("address");
    expect(placeKind("building")).toBe("address");
  });

  it("falls back to lower-cased input for everything else", () => {
    expect(placeKind("Restaurant")).toBe("restaurant");
    expect(placeKind("PARK")).toBe("park");
  });
});

describe("track", () => {
  it("is a no-op when window.umami is missing", () => {
    expect(() =>
      track("plan_requested", { from_kind: "station", to_kind: "address" })
    ).not.toThrow();
  });

  it("forwards the call to window.umami.track", () => {
    const trackFn = vi.fn();
    (window as any).umami = { track: trackFn };
    track("plan_requested", { from_kind: "x", to_kind: "y" });
    expect(trackFn).toHaveBeenCalledWith("plan_requested", {
      from_kind: "x",
      to_kind: "y",
    });
  });

  it("swallows exceptions thrown by the umami call", () => {
    (window as any).umami = {
      track: () => {
        throw new Error("boom");
      },
    };
    expect(() =>
      track("plan_failed", { reason: "error", duration_ms: 12 })
    ).not.toThrow();
  });
});
