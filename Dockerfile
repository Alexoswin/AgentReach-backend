# syntax=docker/dockerfile:1

# ---- build: install all deps, compile TS, then drop dev deps ----
FROM node:24-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

# ---- runtime: compiled output + production deps only ----
# Debian slim (glibc) rather than alpine so prebuilt native modules such as
# @napi-rs/canvas (pulled in by pdf-parse) load without extra toolchains.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
# Cloud Run injects PORT; main.ts reads process.env.PORT first.
ENV PORT=8080

COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

USER node
EXPOSE 8080
CMD ["node", "dist/main"]
