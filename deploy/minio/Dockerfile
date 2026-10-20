# MinIO 从源码构建（quay.io 社区版转私有后自建）
# 源码 Apache-2.0 开源；基础镜像 golang:alpine 走 Docker Hub。
# 代理：.env 设 BUILD_HTTP_PROXY=http://<host>:<port> 后 compose build
# 自动透传（Docker ARG HTTP_PROXY 特殊语义 = RUN 命令的代理环境）。
FROM golang:1.23-alpine AS builder
ARG MINIO_RELEASE=RELEASE.2024-09-13T20-26-02Z
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY=localhost,127.0.0.1
RUN apk add --no-cache curl
WORKDIR /src
RUN curl -sL "https://github.com/minio/minio/archive/refs/tags/${MINIO_RELEASE}.tar.gz" \
      | tar xz --strip-components=1
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
