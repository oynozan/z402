# @z402/web

The z402 website: the landing page (`/`), the live list of paid services (`/services`), and a read-only proxy
(`GET /discovery/resources`, `GET /discovery/status`) that makes the site origin a Bazaar endpoint, so
`withBazaar(new HTTPFacilitatorClient({ url: siteOrigin })).extensions.bazaar.listResources()` works against it.
Next.js 16 (App Router, standalone output), React 19, Tailwind 4.

## Develop

```sh
node scripts/mock-discovery.mjs 4430                         # the four starter services as the real stack lists them
DISCOVERY_URL=http://127.0.0.1:4430 pnpm exec next dev -p 3412
```

Open `http://localhost:3412`. The dev server sends its client chunks to its own host only, so `127.0.0.1` shows the
page without the coin. Without a discovery service the pages still render, with one quiet row in place of the list.
The mock is for development only: it serves the starter services' own bazaar declarations, terms and status shape, with
Text embeddings starting and call counts that grow, and the site itself never makes data up.

## Environment

| Variable | Default | Read |
|---|---|---|
| `DISCOVERY_URL` | `http://127.0.0.1:4030` | at request time, by the pages and the proxy |
| `NEXT_PUBLIC_REPO_URL` | unset | at build time; when set, the header and footer link to it as GitHub |
| `PORT`, `HOSTNAME` | `3000`, `0.0.0.0` | by the standalone server |

## Build and check

```sh
pnpm exec tsc --noEmit    # the app and its tests
pnpm exec vitest run      # parsing, grouping, status merge, catalog search and filters, call snippets, proxy, origin
pnpm exec next build      # needs no discovery service, nothing from it is built in
```

The server lands at `.next/standalone/apps/web/server.js`. Copy `public` and `.next/static` beside it, as
`docker/web.Dockerfile` does, then run `node apps/web/server.js` from `.next/standalone`. `next start` serves the same
build for a quick look, with a warning that standalone output is meant to run through `server.js`.

`next build` type-checks with `tsconfig.build.json`, which leaves the tests out, because an install filtered to this
app does not have the workspace's vitest. `next-env.d.ts` is generated and ignored, and `src/next-types.d.ts` holds
its references so a clean checkout type-checks without it.

## Files worth knowing

- `public/coin.png` is drawn by `scripts/render-coin.mjs` (no dependencies, about 20 s), rerun it after changing it.
- `src/components/dither-veil/` is React Bits' Dither Veil, vendored under its own license (`LICENSE.md` there).
- `src/components/live/catalog.tsx` is the services catalog the landing and `/services` share; `src/lib/catalog.ts`
  and `src/lib/calls.ts` hold its search, filters and the curl and `paidFetch` snippets it copies.
