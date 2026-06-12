# syntax=docker/dockerfile:1

FROM alpine:3.21
ARG TARGETARCH
ARG VERSION=dev
ARG SOURCE_URL=https://github.com/juliopolycarpo/mangostudio

RUN apk add --no-cache ca-certificates libstdc++ \
  && addgroup -S mango \
  && adduser -S -D -H -h /data -G mango mango \
  && mkdir -p /data /tmp \
  && chown mango:mango /data \
  && chmod 1777 /tmp

LABEL org.opencontainers.image.source=$SOURCE_URL \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.licenses=MIT \
      org.opencontainers.image.description="AI-powered image generation and chat studio"

COPY docker-ctx/${TARGETARCH}/mangostudio /usr/local/bin/mangostudio
COPY docker-ctx/${TARGETARCH}/public /usr/local/bin/public

ENV HOME=/data
ENV TMPDIR=/tmp

USER mango
VOLUME ["/data"]
EXPOSE 3001

ENTRYPOINT ["/usr/local/bin/mangostudio"]
CMD ["serve"]
