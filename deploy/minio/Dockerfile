# MinIO 从源码构建（quay.io 社区版转私有后自建）
# 代理：shell 导出 HTTP_PROXY/HTTPS_PROXY，BuildKit 自动透传到构建容器。
# Alpine 包源加速（可选）：ALPINE_MIRROR=mirrors.aliyun.com 传入 build arg。
FROM golang:1.23-alpine AS builder
ARG MINIO_RELEASE=RELEASE.2024-09-13T20-26-02Z
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG ALPINE_MIRROR
ARG GOPROXY=https://proxy.golang.org,direct
ENV GOPROXY=${GOPROXY}
RUN if [ -n "$ALPINE_MIRROR" ]; then sed -i "s/dl-cdn.alpinelinux.org/$ALPINE_MIRROR/g" /etc/apk/repositories; fi \
    && apk add --no-cache curl
WORKDIR /src
RUN curl -sL "https://github.com/minio/minio/archive/refs/tags/${MINIO_RELEASE}.tar.gz" \
      | tar xz --strip-components=1
RUN go build -trimpath -ldflags="-s -w" -o /minio .

FROM alpine:3.20
ARG ALPINE_MIRROR
RUN if [ -n "$ALPINE_MIRROR" ]; then sed -i "s/dl-cdn.alpinelinux.org/$ALPINE_MIRROR/g" /etc/apk/repositories; fi \
    && apk add --no-cache ca-certificates \
    && adduser -D -u 1000 minio \
    && mkdir -p /data && chown minio:minio /data
COPY --from=builder /minio /usr/local/bin/minio
USER minio
EXPOSE 9000 9001
ENTRYPOINT ["minio"]
CMD ["server", "/data", "--console-address", ":9001"]
