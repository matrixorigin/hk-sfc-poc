# HK SFC POC - 应用镜像 (Go 后端 + React 前端)
# 构建: docker build -t hk-poc-app .

# ---- Stage 1: 前端构建 ----
FROM node:20-slim AS frontend
WORKDIR /build
COPY web/package.json web/package-lock.json ./
RUN npm install --legacy-peer-deps
COPY web/ ./
RUN npm run build

# ---- Stage 2: 后端编译 ----
FROM golang:1.25-bookworm AS backend
ENV GOPROXY=https://goproxy.cn,direct
WORKDIR /build
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 go build -o hk-poc-backend .

# ---- Stage 3: 运行 ----
FROM debian:bookworm-slim
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources && \
    apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN mkdir -p /app/data
COPY --from=backend /build/hk-poc-backend .
COPY --from=frontend /build/dist ./web/dist
COPY backend/config.yaml .

ENV STATIC_DIR=/app/web/dist SERVER_PORT=3000
EXPOSE 3000
CMD ["./hk-poc-backend", "-config", "config.yaml"]
