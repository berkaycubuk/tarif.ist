# Deploying tarif.ist

## Where the site actually runs

The frontend is a **Cloudflare Worker** (`tarifist`) serving static assets. It
is not served from the VPS.

That is worth stating explicitly because `compose.yaml` invites the opposite
assumption. The Caddy described there fronts the Go backend only — `/og/*`,
`/s` and `/l`. It does not serve the SPA, so the prerendered pages need no
`try_files` rule or any other Caddy change.

## What this means for the prerendered pages

A directory URL resolves to that directory's `index.html`, so
`dist/hat/m2/index.html` is served at `/hat/m2/` with no configuration.
Confirmed live: `/hat/m2/` returns the generated page, and real files take
precedence over the SPA fallback.

Known wart, pre-dating the generated pages: an unknown path returns **200 with
the SPA shell** rather than a 404, so `/definitely-not-a-real-page` is a soft
404. Google can index unlimited junk URLs that way. Fixing it means setting the
asset handler's `not_found_handling` to serve a real 404, which lives in the
deploy config rather than in this repo.

## Deploying

**Pushing to `main` deploys.** The Cloudflare GitHub App is installed on the
repo and Workers Builds runs on every push, reporting as a "Workers Builds:
tarifist" check run on the commit. There is no workflow file in `.github/` and
no `wrangler` config in the repo — the build settings live in the Cloudflare
dashboard, which is why none of this is visible from the source tree. Note that
Workers Builds posts *check runs*, not GitHub *deployments*, so the repo's
deployments API stays empty and the integration looks absent when it isn't.

The configured build command runs `npm run build` (tsc → vite build →
prerender). That matters: a build command of plain `vite build` would skip the
prerender step and drop all 253 generated pages without failing the build.

To deploy by hand from a machine holding Cloudflare credentials:

```sh
npm run build
npx wrangler deploy
```

Verify after deploying:

```sh
curl -s https://tarif.ist/hat/m2/ | grep -m1 '<title>'   # expect the M2 page
curl -s https://tarif.ist/sitemap.xml | head -3          # expect a sitemapindex
```

## Search Console

Only once the above returns the generated pages, submit the three sitemaps
**separately** — Search Console reports indexation per sitemap, and that split
is what says whether line pages or station pages are earning their keep:

- `sitemap-pages.xml`
- `sitemap-lines.xml`
- `sitemap-stations.xml`

`robots.txt` already points at `/sitemap.xml`, which is now an index
referencing all three.
