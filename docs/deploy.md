# Deploying tarif.ist

## Where the site actually runs

The frontend is served by **Cloudflare Pages**, not from the VPS.

That is worth stating explicitly because `compose.yaml` invites the opposite
assumption. The Caddy described there fronts the Go backend only — `/og/*`,
`/s` and `/l`. It does not serve the SPA, so the prerendered pages need no
`try_files` rule or any other Caddy change.

## What this means for the prerendered pages

Cloudflare Pages resolves a directory URL to that directory's `index.html`, so
`dist/hat/m2/index.html` is served at `/hat/m2/` with no configuration.

One thing to confirm on the first deploy: every unknown path currently returns
**200 with the SPA shell** rather than a 404. Whatever produces that fallback
must not shadow real files. Pages serves a matching static asset in preference
to a `/*` splat rule, so the generated pages should win, but check that
`/hat/m2/` returns the generated page and not the map shell before submitting
anything to Search Console.

## Deploying

The Pages project is not wired to the GitHub repo — it has no deployments — so
deploys are a direct upload from a machine holding the Cloudflare credentials:

```sh
npm run build          # tsc → vite build → prerender (253 static pages)
npx wrangler pages deploy dist
```

`npm run build` must be what produces the deployed artifact. If the Pages
project is ever connected to Git instead, its build command has to be
`npm run build` (not `vite build`) or the `prerender` step is skipped and every
generated page silently disappears.

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
