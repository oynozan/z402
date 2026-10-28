# The website (apps/web) as a Next.js standalone server. next.config sets output "standalone" with the tracing root
# at the repository root, which puts server.js at .next/standalone/apps/web/. Build context: the repository root.

ARG NODE_IMAGE=node:26.12.1-bookworm-slim

# The workspace manifests alone, so the install layer is rebuilt only when one of them changes
FROM ${NODE_IMAGE} AS manifests
WORKDIR /src
COPY . .
RUN mkdir /manifests \
 && find . -maxdepth 3 -type f \( -name package.json -o -name pnpm-lock.yaml -o -name pnpm-workspace.yaml -o -name .npmrc \) \
      -exec cp --parents {} /manifests/ \;

FROM ${NODE_IMAGE} AS build
RUN npm install --global pnpm@12.6.0 && npm cache clean --force
WORKDIR /app
COPY --from=manifests /manifests/ ./
RUN pnpm install --frozen-lockfile --filter '@z402/web...' --store-dir /tmp/pnpm-store \
 && rm -rf /tmp/pnpm-store
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/web apps/web
ENV NEXT_TELEMETRY_DISABLED=1
# The public origin that the share image's URL is made absolute against. Next.js inlines NEXT_PUBLIC_* at build time,
# so a deployment passes it as a build argument (compose.vps.yaml); empty, the default, leaves it unset
ARG NEXT_PUBLIC_SITE_URL=
ENV NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL}
# next/font downloads the fonts from Google Fonts during the build and gives up after under a second of retries, which
# would end the whole docker compose up on a short network failure
RUN for attempt in 1 2 3; do \
      NODE_OPTIONS=--max-old-space-size=1536 pnpm --filter @z402/web build && break; \
      [ "$attempt" -lt 3 ] || exit 1; \
      echo "web build failed (attempt $attempt of 3), retrying in 30 s" >&2; \
      sleep 30; \
    done \
 && mkdir -p apps/web/public

FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public apps/web/public
# Owned by node like the rest: COPY keeps the host's modes, which a strict umask makes unreadable to others
COPY --chown=node:node docker/healthcheck.mjs docker/healthcheck.mjs
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
