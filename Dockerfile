# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — build all services and libraries in one pass.
#
# NestJS's monorepo builder widens tsc's rootDir to the repo root when a
# service imports workspace libraries, so the compiled output ends up nested:
#   dist/services/<svc>/services/<svc>/src/main.js   ← service entry point
#   dist/services/<svc>/libs/<lib>/src/index.js      ← inlined library code
#
# Each service's subtree is self-contained: require() paths inside main.js are
# relative and point at the co-located libs copy, so node_modules only needs
# to supply npm packages.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json nest-cli.json tsconfig.json tsconfig.build.json ./
COPY libs   libs
COPY services services

RUN npm ci --ignore-scripts
RUN npm run build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — slim runtime image.
#
# The entire dist/ tree is copied so every service's subtree is present; each
# container is then given a specific CMD pointing at its own entry point, so no
# service can accidentally load another's code.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

COPY --from=builder /app/dist         ./dist
COPY --from=builder /app/node_modules ./node_modules

# Overridden per-service in docker-compose.yml
CMD ["node", "dist/services/gateway/services/gateway/src/main.js"]
