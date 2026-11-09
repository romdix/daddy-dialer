# ---- 1. build the frontend -------------------------------------------------
FROM node:22-alpine AS web
WORKDIR /app/web
# Coolify injects NODE_ENV=production into builds; force dev deps so vite exists.
ENV NODE_ENV=development
COPY web/package.json web/package-lock.json* ./
RUN npm install --production=false --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---- 2. build the API -------------------------------------------------------
FROM node:22-alpine AS api-build
WORKDIR /app/api
ENV NODE_ENV=development
COPY api/package.json api/package-lock.json* ./
RUN npm install --production=false --no-audit --no-fund
COPY api/tsconfig.json ./
COPY api/src ./src
RUN npm run build

# ---- 3. production dependencies only ---------------------------------------
FROM node:22-alpine AS api-deps
WORKDIR /app/api
COPY api/package.json api/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# ---- 4. runtime -------------------------------------------------------------
FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache curl
COPY --from=api-deps /app/api/node_modules ./api/node_modules
COPY --from=api-build /app/api/dist ./api/dist
COPY --from=api-build /app/api/package.json ./api/package.json
COPY --from=web /app/web/dist ./web/dist

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/api/health || exit 1

CMD ["node", "api/dist/index.js"]
