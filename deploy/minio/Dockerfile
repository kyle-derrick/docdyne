# MinIO 从源码构建（quay.io 社区版转私有后自建）
# 代理：shell 导出 HTTP_PROXY/HTTPS_PROXY，BuildKit 自动透传到构建容器。
FROM golang:1.23-alpine AS builder
ARG MINIO_RELEASE=RELEASE.2024-09-13T20-26-02Z
ARG HTTP_PROXY
ARG HTTPS_PROXY
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories
RUN apk add --no-cache curl
WORKDIR /src
RUN curl -sL "https://github.com/minio/minio/archive/refs/tags/${MINIO_RELEASE}.tar.gz" \
      | tar xz --strip-components=1
RUN go build -trimpath -ldflags="-s -w" -o /minio .

FROM alpine:3.20
# Alpine 包走阿里云镜像（国内 CDN 加速，实测从 500s 降到秒级）；
# ca-certificates 供 MinIO 出站 HTTPS 用（通知/复制等），最小化其余依赖。
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories \
    && apk add --no-cache ca-certificates \
    && adduser -D -u 1000 minio \
    && mkdir -p /data && chown minio:minio /data
COPY --from=builder /minio /usr/local/bin/minio
USER minio
EXPOSE 9000 9001
ENTRYPOINT ["minio"]
CMD ["server", "/data", "--console-address", ":9001"]
