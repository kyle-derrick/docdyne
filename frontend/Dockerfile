# caddy 镜像：前端 SPA 静态产物 + draw.io 静态层 + Caddy 配置。
# 前端在镜像构建阶段完成 npm ci/build，因此 docker compose build 可直接从源码构建。

FROM node:22-alpine AS frontend-build
WORKDIR /src
ARG NPM_REGISTRY=https://registry.npmjs.org/
COPY package*.json ./
# workspace 包清单须与根清单同批就位，npm ci 才能建立 @docdyne/chat 链接
# （K2 拆包后遗留：镜像内构建此前从未跑过，CI 全量 checkout 不触发）。
COPY packages/chat/package.json packages/chat/
# --ignore-scripts：跳过 canvas 等 xmind-viewer 的 Node.js 原生模块编译
# （浏览器端经 Vite alias 用 shim 替代，Docker Alpine 无 Python/C++ 工具链）。
# esbuild/swc 等用 optionalDependencies 分发二进制，不依赖 post-install 脚本。
RUN npm config set registry "$NPM_REGISTRY" && npm ci --ignore-scripts
COPY . .
# tsc 类型检查 + vite 打包（antd6/monaco 等类型树）内存峰值高，默认堆会 OOM
# （exit 134）；与 CI workflows 一致固定 6GB 堆。
ENV NODE_OPTIONS=--max-old-space-size=6144
RUN npm run build

FROM jgraph/drawio:27.0.9 AS drawio
USER root
RUN mkdir /drawio-static \
    && cp -a /usr/local/tomcat/webapps/draw/. /drawio-static/ \
    && rm -rf /drawio-static/WEB-INF
# v7.15 D1：选区跟踪插件 + 允许同域自定义插件（PreConfig.js 为 drawio 官方
# 自托管定制点，app.min.js 解析时读 window.ALLOW_CUSTOM_PLUGINS）。
COPY docker/drawio/plugins/docdyne-selection.js /drawio-static/plugins/
RUN echo 'window.ALLOW_CUSTOM_PLUGINS = true;' >> /drawio-static/js/PreConfig.js

FROM caddy:2.8.4-alpine
COPY --from=frontend-build /src/dist /srv/frontend
COPY --from=drawio /drawio-static/ /srv/drawio/
