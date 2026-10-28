# Zallet with a shell. The upstream image holds nothing but the Zallet binaries, so this adds a static busybox (for
# the zallet-init job and the healthcheck) and the CA bundle Z3 supplies at runtime, and hands the wallet directory
# to uid 1000, the user Zallet runs as. Build context: docker/.

ARG ZALLET_IMAGE=zodlinc/zallet:v0.1.0-beta.1@sha256:1849b4469875dc0165942c06d15fa6a7da76b2d43bade578cc8e5903a639869d

FROM busybox:1.37.0-musl AS busybox
FROM alpine:3.22 AS certs

FROM ${ZALLET_IMAGE}
COPY --from=busybox /bin/busybox /bin/busybox
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
USER 0:0
# A fresh named volume mounted on /var/lib/zallet or /chain-info takes this owner. /etc/zallet exists before the
# COPY below, since a directory that COPY --chmod creates gets the file's mode and loses its x bit.
RUN ["/bin/busybox", "sh", "-c", "/bin/busybox --install -s /bin && mkdir -p /tmp /chain-info /etc/zallet && chmod 1777 /tmp && chown 1000:1000 /var/lib/zallet /chain-info"]
COPY --chmod=0644 z3/zallet.toml /etc/zallet/zallet.toml
COPY --chmod=0755 z3/zallet-init.sh /usr/local/bin/z402-zallet-init
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/zallet-zaino", "--datadir", "/var/lib/zallet", "--config", "/etc/zallet/zallet.toml"]
CMD ["start"]
