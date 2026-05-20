import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});

describe("i18n", () => {
  it("defaults to Turkish when localStorage is empty", async () => {
    const m = await import("./i18n");
    expect(m.getLang()).toBe("tr");
    expect(m.t("plan.heading")).toBe("Rotanı planla");
  });

  it("reads a stored language preference", async () => {
    localStorage.setItem("tarif-ist:lang", "en");
    const m = await import("./i18n");
    expect(m.getLang()).toBe("en");
    expect(m.t("plan.heading")).toBe("Plan your route");
  });

  it("falls back to Turkish on an unknown stored value", async () => {
    localStorage.setItem("tarif-ist:lang", "de");
    const m = await import("./i18n");
    expect(m.getLang()).toBe("tr");
  });

  it("interpolates {placeholders} in strings", async () => {
    const m = await import("./i18n");
    expect(m.t("itin.leg.walkKm", { km: "1.2" })).toBe("1.2 km yürü");
  });

  it("setLang triggers reload when the language changes", async () => {
    const m = await import("./i18n");
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, reload, assign: vi.fn() },
      writable: true,
    });
    m.setLang("en");
    expect(localStorage.getItem("tarif-ist:lang")).toBe("en");
    expect(reload).toHaveBeenCalled();
  });

  it("setLang is a no-op when the language is unchanged", async () => {
    const m = await import("./i18n");
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, reload, assign: vi.fn() },
      writable: true,
    });
    m.setLang("tr");
    expect(reload).not.toHaveBeenCalled();
  });

  it("swallows localStorage failures in setLang", async () => {
    const m = await import("./i18n");
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("blocked");
    };
    Object.defineProperty(window, "location", {
      value: { ...window.location, reload: vi.fn(), assign: vi.fn() },
      writable: true,
    });
    try {
      expect(() => m.setLang("en")).not.toThrow();
    } finally {
      Storage.prototype.setItem = orig;
    }
  });

  it("swallows localStorage failures in readInitialLang", async () => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("blocked");
    };
    try {
      const m = await import("./i18n");
      expect(m.getLang()).toBe("tr");
    } finally {
      Storage.prototype.getItem = orig;
    }
  });
});
