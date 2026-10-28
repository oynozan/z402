# One image for every Node process of compose.yaml (chain jobs, keygen, facilitator, API, services, discovery,
# agent): the pnpm workspace without the website, run from source with tsx, plus the zdecrypt binary that the
# facilitator and the keygen job call. Build context: the repository root.

ARG NODE_IMAGE=node:26.12.1-bookworm-slim
ARG RUST_IMAGE=rust:1.99.1-slim-bookworm

# Default features only: testbuild exists for the crate's own tests and never ships. Target directory and registry
# go in the same layer, so only the binary is kept.
FROM ${RUST_IMAGE} AS zdecrypt
WORKDIR /src
COPY crates/zdecrypt crates/zdecrypt
RUN CARGO_BUILD_JOBS=2 cargo build --release --locked --manifest-path crates/zdecrypt/Cargo.toml \
 && install -m 0755 crates/zdecrypt/target/release/zdecrypt /usr/local/bin/zdecrypt \
 && rm -rf crates/zdecrypt/target "$CARGO_HOME/registry" "$CARGO_HOME/git"

# The workspace manifests alone, so the install layer is rebuilt only when one of them changes
FROM ${NODE_IMAGE} AS manifests
WORKDIR /src
COPY . .
RUN mkdir /manifests \
 && find . -maxdepth 3 -type f \( -name package.json -o -name pnpm-lock.yaml -o -name pnpm-workspace.yaml -o -name .npmrc \) \
      -exec cp --parents {} /manifests/ \;

FROM ${NODE_IMAGE}
RUN npm install --global pnpm@12.6.0 && npm cache clean --force
WORKDIR /app
COPY --from=manifests /manifests/ ./
# Every workspace package and the root's devDependencies (tsx), not @z402/web, which has its own image
RUN pnpm install --frozen-lockfile --filter '!@z402/web' --store-dir /tmp/pnpm-store \
 && rm -rf /tmp/pnpm-store
COPY . .
# The default path of the facilitator (Z402_ZDECRYPT_BIN) and scripts/merchant-keygen.mjs, and on PATH
COPY --from=zdecrypt /usr/local/bin/zdecrypt crates/zdecrypt/target/release/zdecrypt
# Mount points owned by the runtime user, so a fresh named volume mounted on one inherits the owner
RUN ln -s /app/crates/zdecrypt/target/release/zdecrypt /usr/local/bin/zdecrypt \
 && mkdir -p /data/dropbox /keys /run/z402 /chain-info \
 && chown node:node /data /data/dropbox /keys /run/z402 /chain-info
ENV NODE_ENV=production
USER node
