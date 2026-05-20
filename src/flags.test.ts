import { describe, expect, it } from "vitest";
import { FEATURES, LIVE_TRAINS_URL } from "./flags";

describe("flags", () => {
  it("exposes the routePlanning and liveTrainPositions toggles", () => {
    expect(typeof FEATURES.routePlanning).toBe("boolean");
    expect(typeof FEATURES.liveTrainPositions).toBe("boolean");
  });

  it("LIVE_TRAINS_URL falls back to a non-empty string", () => {
    expect(typeof LIVE_TRAINS_URL).toBe("string");
    expect(LIVE_TRAINS_URL.length).toBeGreaterThan(0);
  });
});
