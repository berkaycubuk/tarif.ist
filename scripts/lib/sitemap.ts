// Sitemaps, sharded by page type.
//
// One combined file would stay well under the 50k-URL limit, but Search
// Console reports indexation *per sitemap* — splitting by type is what tells
// you whether it's the line pages or the station pages that Google is
// actually keeping, which is the signal wave 2 depends on.

import { SITE_ORIGIN } from "./html";

export interface SitemapEntry {
  path: string;
  changefreq?: string;
  priority?: string;
}

export function renderUrlset(entries: SitemapEntry[]): string {
  const urls = entries
    .map(
      (e) => `  <url>
    <loc>${SITE_ORIGIN}${e.path}</loc>${
        e.changefreq ? `\n    <changefreq>${e.changefreq}</changefreq>` : ""
      }${e.priority ? `\n    <priority>${e.priority}</priority>` : ""}
  </url>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

export function renderSitemapIndex(files: string[], lastmod: string): string {
  const items = files
    .map(
      (f) => `  <sitemap>
    <loc>${SITE_ORIGIN}/${f}</loc>
    <lastmod>${lastmod}</lastmod>
  </sitemap>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${items}
</sitemapindex>
`;
}
