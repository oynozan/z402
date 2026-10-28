# Zebra with the regtest configuration inside the image, so no host file has to be readable by its uid 10001.
# Build context: docker/.
FROM zfnd/zebra:6.2.3
# Into an existing directory: a directory COPY --chmod creates gets the file's mode, which drops its x bit
COPY --chmod=0644 z3/zebra.toml /etc/zebrad.toml
# The image's entrypoint passes this file to zebrad with --config
ENV CONFIG_FILE_PATH=/etc/zebrad.toml
