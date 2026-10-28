# One image for every Node process of compose.yaml (chain jobs, keygen, facilitator, provider registration, API,
# services, agent, smoke test): the pnpm workspace without the website, run from source with tsx, plus the zdecrypt
# binary that the facilitator and the keygen job call. Build context: the repository root.

ARG NODE_IMAGE=node:26.12.1-bookworm-slim
ARG RUST_IMAGE=rust:1.98.1-slim-bookworm

# Default features only: testbuild exists for the crate's own tests and never ships. Target directory and registry
# go in the same layer, so only the binary is kept.
FROM ${RUST_IMAGE} AS zdecrypt
WORKDIR /src
COPY crates/zdecrypt crates/zdecrypt
RUN CARGO_BUILD_JOBS=2 cargo build --release --locked --manifest-path crates/zdecrypt/Cargo.toml \
 && install -m 0755 crates/zdecrypt/target/release/zdecrypt /usr/local/bin/zdecrypt \
 && rm -rf crates/zdecrypt/target "$CARGO_HOME/registry" "$CARGO_HOME/git"

# The repository as the node user can read it. COPY keeps the modes of the build context, and a checkout made under
# umask 027 or 077 holds files that only their owner, root in the image, may read.
FROM ${NODE_IMAGE} AS source
WORKDIR /src
COPY . .
RUN chmod -R a+rX,go-w .

# The workspace manifests alone, so the install layer is rebuilt only when one of them changes
FROM source AS manifests
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
COPY --from=source /src/ ./
# The default path of the facilitator (Z402_ZDECRYPT_BIN) and scripts/merchant-keygen.mjs, and on PATH
COPY --from=zdecrypt --chmod=0755 /usr/local/bin/zdecrypt crates/zdecrypt/target/release/zdecrypt
# Mount points owned by the runtime user, so a fresh named volume mounted on one inherits the owner
RUN ln -s /app/crates/zdecrypt/target/release/zdecrypt /usr/local/bin/zdecrypt \
 && mkdir -p /data/dropbox /keys /markdown-keys /run/z402 /run/markdown /chain-info \
 && chown node:node /data /data/dropbox /keys /markdown-keys /run/z402 /run/markdown /chain-info
ENV NODE_ENV=production
USER node
