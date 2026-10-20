# MinIO 从源码构建（2026-10：quay.io 社区版镜像转私有后自建）
# 源码 Apache-2.0 开源，GitHub 可达即可构建；基础镜像走 Docker Hub。
FROM golang:1.23-alpine AS builder
RUN apk add --no-cache git bash
ARG MINIO_RELEASE=RELEASE.2024-09-13T20-26-02Z
WORKDIR /src
RUN git clone --depth 1 --branch ${MINIO_RELEASE} https://github.com/minio/minio.git .
RUN go build -trimpath -ldflags="-s -w" -o /minio .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates curl && \
    adduser -D -u 1000 minio && \
    mkdir -p /data && chown minio:minio /data
COPY --from=builder /minio /usr/local/bin/minio
USER minio
EXPOSE 9000 9001
ENTRYPOINT ["minio"]
CMD ["server", "/data", "--console-address", ":9001"]
