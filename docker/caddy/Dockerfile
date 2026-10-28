# Caddy for compose.vps.yaml: the official image at one pinned release, with this deployment's Caddyfile inside, so that
# nothing is mounted from the host (a bind mount depends on the checkout's path and modes, and on file sharing where
# Docker runs in a VM). Build context: this directory.

ARG CADDY_IMAGE=caddy:2.11.7-alpine
FROM ${CADDY_IMAGE}

COPY Caddyfile /etc/caddy/Caddyfile
COPY profiles /etc/caddy/profiles

# A syntax error stops the build and not the first start: once for each way the container's environment can change the
# configuration
RUN caddy adapt --config /etc/caddy/Caddyfile > /dev/null \
 && Z402_TLS=internal Z402_PROFILES=services Z402_DOMAIN=localhost Z402_PORT_SUFFIX=:8443 \
    caddy adapt --config /etc/caddy/Caddyfile > /dev/null
