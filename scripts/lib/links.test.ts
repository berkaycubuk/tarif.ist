// Build-time guard: every internal link in the generated pages must resolve to
// a file that exists. Broken links are the fastest way to burn crawl budget on
// a big generated batch, and they're invisible without a check like this.
import { describe, expect, it } from "vitest";
import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const DIST = resolve(import.meta.dirname, "../../dist");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = resolve(dir, e);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith(".html") ? [p] : [];
  });
}

describe("prerendered pages", () => {
  const pages = existsSync(DIST) ? walk(DIST) : [];

  it.skipIf(!pages.length)("link to targets that exist", () => {
    const broken: string[] = [];
    for (const file of pages) {
      const html = readFileSync(file, "utf8");
      for (const m of html.matchAll(/href="(\/[^"#?]*)"/g)) {
        const href = m[1];
        const target = href.endsWith("/")
          ? resolve(DIST, `.${href}`, "index.html")
          : resolve(DIST, `.${href}`);
        if (!existsSync(target)) {
          broken.push(`${file.slice(DIST.length)} → ${href}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
