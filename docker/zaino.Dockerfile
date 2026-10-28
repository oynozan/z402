# Zaino with the regtest configuration inside the image. Zaino publishes linux/amd64 only, so arm64 hosts run it
# emulated. Build context: docker/.
FROM --platform=linux/amd64 zingodevops/zainod:0.10.2-no-tls
# Into an existing directory: a directory COPY --chmod creates gets the file's mode, which drops its x bit
COPY --chmod=0644 z3/zaino.toml /etc/zindexer.toml
