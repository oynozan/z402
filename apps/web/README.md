# @z402/web

The z402 website: the landing page (`/`), the live list of paid services (`/services`), the documentation (`/docs`,
see [Docs](#docs)), and a read-only proxy to the facilitator's Bazaar (`GET /discovery/resources`, `GET /discovery/search`) that makes the site origin a Bazaar
endpoint, so `withBazaar(new HTTPFacilitatorClient({ url: siteOrigin })).extensions.bazaar.listResources()` works
against it. Next.js 16 (App Router, standalone output), React 19, Tailwind 4.

## Develop

```sh
node scripts/mock-discovery.mjs 4430                         # the facilitator's Bazaar, with the four starter services
DISCOVERY_URL=http://127.0.0.1:4430 pnpm exec next dev -p 3412
```

Open `http://localhost:3412`. The dev server sends its client chunks to its own host only, so `127.0.0.1` shows the
page without the coin. Without a Bazaar the pages still render, with one quiet row in place of the list. The mock is
for development only: it serves two providers with their own `payTo` and per-route prices, the starter services' own
bazaar declarations and the rail's terms, one service in each status, and call counts that grow, and the site itself
never makes data up.

## What it reads

The pages read `GET /discovery/resources` at request time, 100 items a page until the offset reaches the total (the
facilitator holds at most 4096), and the browser reads it again through the proxy every 5 s for each page. Every field
is untrusted. A row is a service: the routes on one origin, paid to one `payTo`, under one `serviceName`, so a name
alone never joins two providers. Its price is each route's own `amount`, its status the age of its latest `lastSeen`
by the server's clock (up under 90 s, stale under 10 min, down after, a dash for a service listed from its paid calls
alone), and TODAY the sum of `paidCallsToday` over its routes. The proxy passes on only the query parameters each read
documents.

## Docs

`/docs` renders the MDX pages under `src/content/docs`: `/docs/<slug>` is `src/content/docs/<slug>.mdx`, and a
section's `index.mdx` is the section's own URL (`services/index.mdx` is `/docs/services`). Every page is built ahead
of time and any other path under `/docs` is a 404.

- **Order and titles.** `src/lib/docs/ia.ts` is the only place they live: the sidebar, previous and next, the search
  and the sitemap all read it. A page listed there without a file is left out, with one warning per build. A page
  with a file but not in the list does not render, except `components`, which `HIDDEN_DOCS` serves at
  `/docs/components` (noindex, out of the sidebar, the search and the sitemap): it shows every element and component
  once, so a design change can be checked on one page.
- **A page** starts with `export const meta = { title, description }` (under 160 characters) and has no `#` heading,
  since the template renders `meta.title` as the H1. `##` and `###` make "On this page", with github-slugger anchors.
  A fence takes a language and an optional title: ```` ```ts title="agent.ts" ````. A ```` ```mermaid ```` fence
  (flowchart, sequenceDiagram, stateDiagram-v2, Mermaid 12.1 syntax) is drawn to inline SVG by Pele at build time; a
  syntax error shows on the page in `next dev` and fails `next build`. Leave out `style`, `classDef`, `%%{init}%%`
  and colors: the site's tokens color the diagrams.
- **Components** every page gets without imports, defined in `src/components/docs/` and listed in
  `src/mdx-components.tsx`:

  | Component | Props |
  |---|---|
  | `<Callout>` | `type`: `note` (default), `tip`, `warning` or `privacy`; `title` optional; Markdown inside |
  | `<Steps>`, `<Step>` | `Step` takes `title`; Markdown inside each step |
  | `<CodeTabs>` | two or more fences inside, each tab named by its fence's `title`, else its language |
  | `<Cards>`, `<Card>` | `Card` takes `title` and `href` (a `/docs/...` path or an `https://` URL); one line inside |
  | `<Video>` | `src`, `poster`, `title`, `caption` optional; a file under `public/` that is not there yet shows a "recording soon" frame |
  | `<Endpoint>` | `method`, `path`, `auth`: `public`, `api-key` or `registration-token`; Markdown inside, optional |
  | `<Params>`, `<Param>` | `Params` takes an optional `title`; `Param` takes `name`, `type` and `required`; Markdown inside |
  | `<Term>` | `tip`, the plain-language meaning, shown by the site's `?` tooltip |
  | `<Source>` | `path` from the repository root, `line` optional; a GitHub link when `NEXT_PUBLIC_REPO_URL` is set, else the path |

- **How it is built.** `@next/mdx` compiles the pages with the plugins `src/lib/docs/mdx/options.ts` names, as
  strings, since Turbopack hands them to its workers as JSON: remark-gfm, rehype-slug, `rehype-docs.mjs` (this app's:
  it exports each page's TOC, its text by heading for the search, and its Markdown for "Copy page") and
  rehype-mdx-code-props (a fence's meta as props on `<pre>`). Shiki colors code on the server in a theme of CSS
  variables that `src/app/docs/docs.css` maps to the site's tokens, and Pele draws the diagrams with Manrope's
  measured widths (`src/lib/docs/manrope.ts`). `/docs/search.json` is the search index, built with the pages and
  fetched by the browser the first time search opens (Cmd+K, Ctrl+K or `/`).

## Environment

| Variable | Default | Read |
|---|---|---|
| `DISCOVERY_URL` | `http://127.0.0.1:4022` | at request time, by the pages and the proxy: the facilitator, which hosts the Bazaar |
| `NEXT_PUBLIC_REPO_URL` | unset | at build time; when set, the header and footer link to it as GitHub, and the docs' `<Source>` links files under its `/blob/main/` |
| `NEXT_PUBLIC_SITE_URL` | unset | at build time; the public origin, such as `https://z402.example`, that the share image's URL is made absolute against. Unset, Next.js uses `http://localhost:3000` and warns |
| `PORT`, `HOSTNAME` | `3000`, `0.0.0.0` | by the standalone server |

## Build and check

```sh
pnpm exec tsc --noEmit    # the app and its tests
pnpm exec vitest run      # catalog, calls, proxy, origin, and the docs: IA, anchors, code meta, search, diagrams
pnpm exec next build      # needs no Bazaar, nothing from it is built in; prerenders every docs page
```

The server lands at `.next/standalone/apps/web/server.js`. Copy `public` and `.next/static` beside it, as
`docker/web.Dockerfile` does, then run `node apps/web/server.js` from `.next/standalone`. `next start` serves the same
build for a quick look, with a warning that standalone output is meant to run through `server.js`.

`next build` type-checks with `tsconfig.build.json`, which leaves the tests out, because an install filtered to this
app does not have the workspace's vitest. `next-env.d.ts` is generated and ignored, and `src/next-types.d.ts` holds
its references so a clean checkout type-checks without it.

## Files worth knowing

- `src/lib/mark.ts` is the z402 mark, a gold square cut in two by a Z, which the header, `src/app/icon.svg`,
  `src/app/apple-icon.tsx`, `src/app/opengraph-image.tsx` and the coin draw. The share image is set in Manrope from
  `src/app/fonts`, cut to Basic Latin, under the SIL Open Font License (`OFL.txt` there).
- `public/coin.png` is drawn by `scripts/render-coin.mjs` (no dependencies, about 20 s), rerun it after changing it.
- `src/components/dither-veil/` is React Bits' Dither Veil, vendored under its own license (`LICENSE.md` there).
- `src/components/light-rays/` is React Bits' Light Rays, vendored the same way; `src/components/services-rays.tsx`
  sets faint white rays behind the head of the landing page's services section, with no pointer listeners, starts
  them once the section nears, and leaves a static glow without WebGL2.
- `src/components/live/catalog.tsx` is the services catalog the landing and `/services` share; `src/lib/catalog.ts`
  and `src/lib/calls.ts` hold its search, filters and the curl and `paidFetch` snippets it copies.
- `src/app/docs/` holds the docs' layout, page template, stylesheet and search index route; `src/lib/docs/` the IA,
  the page loader, the search and the MDX plugin.
