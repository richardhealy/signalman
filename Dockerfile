# ── Build stage ────────────────────────────────────────────────────────────────
# Install all deps (including devDeps required by nest-cli and tsc) and compile
# the full monorepo. Every service and lib lands in dist/ so the runtime stage
# can extract its slice without internet access.
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Strip devDependencies before copying to the runtime stage.
RUN npm prune --omit=dev

# ── Runtime stage ──────────────────────────────────────────────────────────────
# APP build-arg selects which service this image runs; docker-compose passes it
# per service. The compiled slice for that service — inlined libs and copied proto
# assets included — is unpacked into dist/ so relative requires and the proto
# upward-walk both resolve without tsconfig-paths at runtime.
FROM node:20-alpine
ARG APP
ENV APP=${APP}
WORKDIR /app

COPY --from=builder /app/dist/services/${APP} ./dist/
COPY --from=builder /app/node_modules ./node_modules

CMD ["sh", "-c", "node dist/services/${APP}/src/main.js"]
