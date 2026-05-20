import { beforeEach, describe, expect, it, vi } from "vitest";

// Theme reads localStorage and matchMedia at import time, so each describe
// block resets state and re-imports via vi.resetModules() to exercise the
// initialisation branches.

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

describe("theme module — default", () => {
  it("defaults to 'system' when localStorage is empty", async () => {
    const t = await import("./theme");
    expect(t.getThemePreference()).toBe("system");
  });

  it("resolves to 'light' when matchMedia reports light", async () => {
    const t = await import("./theme");
    expect(t.getResolvedTheme()).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});

describe("theme module — persisted preference", () => {
  it("reads a valid preference from localStorage", async () => {
    localStorage.setItem("tarif-ist:theme", "dark");
    const t = await import("./theme");
    expect(t.getThemePreference()).toBe("dark");
    expect(t.getResolvedTheme()).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("ignores an invalid value", async () => {
    localStorage.setItem("tarif-ist:theme", "neon");
    const t = await import("./theme");
    expect(t.getThemePreference()).toBe("system");
  });

  it("handles localStorage.getItem throwing", async () => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("blocked");
    };
    try {
      const t = await import("./theme");
      expect(t.getThemePreference()).toBe("system");
    } finally {
      Storage.prototype.getItem = orig;
    }
  });
});

describe("theme module — mutation", () => {
  it("setThemePreference stores and applies the choice", async () => {
    const t = await import("./theme");
    t.setThemePreference("dark");
    expect(localStorage.getItem("tarif-ist:theme")).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(t.getResolvedTheme()).toBe("dark");
    t.setThemePreference("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("notifies subscribers and supports unsubscribe", async () => {
    const t = await import("./theme");
    const seen: string[] = [];
    const off = t.subscribeTheme((r) => seen.push(r));
    t.setThemePreference("dark");
    t.setThemePreference("light");
    off();
    t.setThemePreference("dark");
    expect(seen).toEqual(["dark", "light"]);
  });

  it("swallows localStorage.setItem failures", async () => {
    const t = await import("./theme");
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("blocked");
    };
    try {
      expect(() => t.setThemePreference("dark")).not.toThrow();
    } finally {
      Storage.prototype.setItem = orig;
    }
  });
});

describe("theme module — system preference change", () => {
  it("re-applies when matchMedia fires a change event in system mode", async () => {
    // Wire a controllable mql so we can fire the change event manually.
    type Listener = (e: { matches: boolean }) => void;
    const listeners: Listener[] = [];
    const mql = {
      matches: false,
      addEventListener: (_: string, cb: Listener) => listeners.push(cb),
      removeEventListener: vi.fn(),
    };
    (window as any).matchMedia = vi.fn().mockReturnValue(mql);
    const t = await import("./theme");
    expect(t.getResolvedTheme()).toBe("light");
    mql.matches = true;
    listeners.forEach((l) => l({ matches: true }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("ignores system change when user has pinned a preference", async () => {
    type Listener = (e: { matches: boolean }) => void;
    const listeners: Listener[] = [];
    const mql = {
      matches: false,
      addEventListener: (_: string, cb: Listener) => listeners.push(cb),
      removeEventListener: vi.fn(),
    };
    (window as any).matchMedia = vi.fn().mockReturnValue(mql);
    const t = await import("./theme");
    t.setThemePreference("light");
    document.documentElement.classList.remove("dark");
    // OS flips to dark — but preference is pinned to light.
    mql.matches = true;
    listeners.forEach((l) => l({ matches: true }));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
