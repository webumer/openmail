# syntax=docker/dockerfile:1
# OpenMail production image. Multi-stage: build with dev deps, run with prod deps only.

FROM node:22-slim AS base
WORKDIR /app
# Native modules (better-sqlite3, @node-rs/argon2) normally use prebuilt binaries;
# the toolchain is only a fallback and never reaches the runtime image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data /config \
 && chown node:node /data
COPY --from=prod-deps --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
COPY --chown=root:root package.json ./
USER node
EXPOSE 8080
ENV OPENMAIL_CONFIG=/config/config.toml \
    OPENMAIL_DB_PATH=/data/openmail.db
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
