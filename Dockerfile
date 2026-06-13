# syntax=docker/dockerfile:1
#
# Lockstep with the other MangoStudio image variant. The lines that may
# legitimately differ between this file and its pair are exactly three:
# 1. the `FROM` base image,
# 2. the user/package-install `RUN` that follows it (apt-get vs apk, etc.),
# 3. the variant segment inside the docker-ctx COPY paths (matches the
# stage-docker-ctx.ts directory layout).
# Everything else (LABEL, ENV, USER, VOLUME, EXPOSE, ENTRYPOINT, CMD, and the
# shape of the COPY lines) must stay byte-for-byte identical so a hardening
# change applied here propagates to the other variant by copy/paste.

FROM debian:bookworm-slim
ARG TARGETARCH
ARG VERSION=dev
ARG SOURCE_URL=https://github.com/juliopolycarpo/mangostudio

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates libstdc++6 \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system mango \
  && useradd --system --gid mango --home-dir /data --shell /usr/sbin/nologin mango \
  && mkdir -p /data /tmp \
  && chown mango:mango /data \
  && chmod 1777 /tmp

LABEL org.opencontainers.image.source=$SOURCE_URL \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.licenses=MIT \
      org.opencontainers.image.description="AI-powered image generation and chat studio"

COPY docker-ctx/bookworm/${TARGETARCH}/mangostudio /usr/local/bin/mangostudio
COPY docker-ctx/bookworm/${TARGETARCH}/public /usr/local/bin/public

ENV HOME=/data
ENV TMPDIR=/tmp

USER mango
VOLUME ["/data"]
EXPOSE 3001

ENTRYPOINT ["/usr/local/bin/mangostudio"]
CMD ["serve"]
