import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { slugify, slugIndex, SlugCollisionError } from "./slug";

describe("slugify", () => {
  it("folds Turkish letters to ASCII", () => {
    expect(slugify("Mecidiyeköy")).toBe("mecidiyekoy");
    expect(slugify("Şişli")).toBe("sisli");
    expect(slugify("Kâğıthane")).toBe("kagithane");
    expect(slugify("Üsküdar")).toBe("uskudar");
    expect(slugify("Çekmeköy")).toBe("cekmekoy");
  });

  it("sends dotted and dotless capital I to the same letter", () => {
    // The bug this module exists to prevent: naive toLowerCase() leaves a
    // combining dot on "İ" and would emit two different slugs here.
    expect(slugify("İSTİKLAL")).toBe("istiklal");
    expect(slugify("ISTIKLAL")).toBe("istiklal");
    expect(slugify("İstanbul")).toBe("istanbul");
  });

  it("collapses separators and trims edges", () => {
    expect(slugify("Kabataş - Bağcılar")).toBe("kabatas-bagcilar");
    expect(slugify("  4. Levent  ")).toBe("4-levent");
    expect(slugify("Ayrılık Çeşmesi")).toBe("ayrilik-cesmesi");
  });
});

describe("slugIndex", () => {
  it("collapses repeats of one name onto a single slug", () => {
    const idx = slugIndex(["Yenikapı", "Yenikapı", "Taksim"]);
    expect(idx.get("yenikapi")).toBe("Yenikapı");
    expect(idx.size).toBe(2);
  });

  it("throws when two distinct names collide", () => {
    expect(() => slugIndex(["Levent", "LEVENT!"])).toThrow(SlugCollisionError);
  });

  it("assigns every real station a unique slug", () => {
    // Guards the actual dataset: a collision here would silently overwrite a
    // generated page, so the build must fail instead.
    const path = resolve(import.meta.dirname, "../../public/data/stations.geojson");
    const fc = JSON.parse(readFileSync(path, "utf8"));
    const names: string[] = fc.features
      .map((f: { properties: { name?: string } }) => f.properties.name)
      .filter((n: string | undefined): n is string => !!n);

    const idx = slugIndex(names);
    expect(idx.size).toBe(new Set(names).size);
  });
});
